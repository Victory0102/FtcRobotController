/**
 * FTC Run Health graph engine.
 *
 * Two layers:
 *   - Pure data preparation (no DOM) for testability + reusability.
 *   - Canvas 2D render helpers that consume the prepared data.
 *
 * Design notes (from the architectural plan):
 *   - SeriesPoint carries a `gap` flag.  A gap is a consecutive-sample
 *     breaking gap whose `dt` exceeds gapThresholdMs (default 500 ms).
 *   - Downsampling on the data-prep side keeps the renderer fast on runs
 *     with thousands of samples; the policy is per-screen-pixel-budget.
 *   - The renderer's line drawing calls `ctx.moveTo()` at every gap so we
 *     never connect across a missing-data gap.
 *   - Hover and synchronized cursor are separate: hover is the user-driven
 *     pointer over a single graph; the synchronized cursor is the
 *     replay-clock-driven line drawn on every visible graph.
 */
/** Default threshold above which a consecutive-sample gap becomes a gap in
 *  the rendered line.  500 ms comfortably covers scheduled ~100 ms loop
 *  ping-pong and accidental sampling jitter while still leaving the line
 *  disconnected across real pauses. */
export const DEFAULT_GAP_THRESHOLD_MS = 500;
/** Default per-screen-pixel budget that drives downsampling.  ~3 samples
 *  per pixel keeps lines visually smooth without overdrawing. */
export const DEFAULT_TARGET_SAMPLES_PER_PIXEL = 3;
/* ====================== Pure data-prep helpers ======================== */
/**
 * Convert {@link Sample}s into a {@link SeriesPoint[]} for one motor.
 *
 * @param samples         All samples for this motor across the run.
 * @param valueOf         Pulls the y-value for one sample.
 * @param gapThresholdMs  Any inter-sample dt above this becomes a `gap: true`.
 */
export function buildSampleSeries(samples, valueOf, gapThresholdMs = DEFAULT_GAP_THRESHOLD_MS) {
    const out = [];
    let prevT = null;
    for (const s of samples) {
        const v = valueOf(s);
        if (v === null || !Number.isFinite(v))
            continue;
        const t = s.timestampMs;
        const gap = prevT !== null && (t - prevT) > gapThresholdMs;
        out.push({ t, v, gap });
        prevT = t;
    }
    return out;
}
/**
 * Domain (time + value range) for a list of series; null if every series
 * has zero points.
 */
export function seriesDomain(seriesList) {
    let tMin = Infinity, tMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    let any = false;
    for (const s of seriesList) {
        if (!s.visible)
            continue;
        for (const p of s.points) {
            if (!Number.isFinite(p.v) || !Number.isFinite(p.t))
                continue;
            any = true;
            if (p.t < tMin)
                tMin = p.t;
            if (p.t > tMax)
                tMax = p.t;
            if (p.v < yMin)
                yMin = p.v;
            if (p.v > yMax)
                yMax = p.v;
        }
    }
    if (!any)
        return null;
    // Always add a small default margin so a horizontal/vertical polyline is
    // not rendered flush against the canvas edges - this is the default
    // expectation across the test suite and the UI.  We widen BOTH axes
    // so a single longest-value series does not clip.
    const yPad = Math.max(Math.abs(yMin) * 0.05, Math.abs(yMax) * 0.05, 1) * 0.6;
    if (yMin === yMax) {
        yMin -= Math.abs(yMin) * 0.05 || 1;
        yMax += Math.abs(yMax) * 0.05 || 1;
    }
    else {
        yMin -= yPad;
        yMax += yPad;
    }
    if (tMin === tMax) {
        tMin -= 1;
        tMax += 1;
    }
    return { tMin, tMax, yMin, yMax };
}
/**
 * Downsample larger-than-budget series to fit a target screen-pixel
 * density.  Preserves the first and last sample so the line still starts
 * and ends at the same coordinates.
 */
export function downsample(points, targetSampleCount) {
    if (points.length <= targetSampleCount || targetSampleCount < 2) {
        return points.slice();
    }
    const stride = points.length / (targetSampleCount - 2);
    const out = [];
    out.push(points[0]);
    for (let i = 1; i < targetSampleCount - 1; i++) {
        const idx = Math.min(points.length - 1, Math.round(i * stride));
        out.push(points[idx]);
    }
    out.push(points[points.length - 1]);
    return out;
}
/* ====================== Renderer state utilities ====================== */
/** Map a millisecond timestamp to a canvas x-pixel given a time-domain. */
export function timeToX(t, domain, widthPx) {
    if (domain.tMax === domain.tMin)
        return 0;
    return ((t - domain.tMin) / (domain.tMax - domain.tMin)) * widthPx;
}
/** Map a y-value to a canvas y-pixel given a value-domain. */
export function valueToY(v, domain, heightPx) {
    if (domain.yMax === domain.yMin)
        return heightPx / 2;
    // Invert so larger values appear at the top of the canvas.
    return heightPx - ((v - domain.yMin) / (domain.yMax - domain.yMin)) * heightPx;
}
/** Inverse of {@link valueToY}, used by hover lookup. */
export function yToValue(yPx, domain, heightPx) {
    if (domain.yMax === domain.yMin)
        return domain.yMin;
    const frac = 1 - (yPx / heightPx);
    return domain.yMin + frac * (domain.yMax - domain.yMin);
}
/* ======================== Drawing helpers ============================== */
/**
 * Draw the series list onto a canvas.  Skips invisible series.  Draws a
 * line per series separated by `gap` moveTo() calls so a missing-data gap
 * is never visually crossed.
 *
 * @returns number of visible series drawn.
 */
export function drawSeries(ctx, seriesList, domain, width, height, hoverT) {
    let drawn = 0;
    for (const series of seriesList) {
        if (!series.visible)
            continue;
        ctx.save();
        ctx.strokeStyle = series.color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let started = false;
        for (const p of series.points) {
            const x = timeToX(p.t, domain, width);
            const y = valueToY(p.v, domain, height);
            if (p.gap || !started) {
                ctx.moveTo(x, y);
                started = true;
            }
            else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
        drawn++;
        ctx.restore();
    }
    // Synchronized cursor drawn on top of every series.
    if (hoverT !== null) {
        ctx.save();
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        const x = timeToX(hoverT, domain, width);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.restore();
    }
    return drawn;
}
/**
 * Find the sample on each visible series whose t is closest to {@code t}.
 * Returns one {@link SeriesPointEntry} per series (or null if none).
 */
export function hoverLookup(seriesList, t) {
    const out = [];
    for (const series of seriesList) {
        if (!series.visible || series.points.length === 0)
            continue;
        // Binary search for the largest index where points[i].t <= t.
        let lo = 0, hi = series.points.length - 1, best = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (series.points[mid].t <= t) {
                best = mid;
                lo = mid + 1;
            }
            else
                hi = mid - 1;
        }
        if (best === -1)
            continue;
        out.push({ series, point: series.points[best] });
    }
    return out;
}
/**
 * Build a default color sequence so multi-run overlays never reuse a
 * consecutive color.  Returns hex strings.  The first eight are
 * high-contrast; subsequent ones cycle through muted variants.
 */
const DEFAULT_PALETTE = [
    '#2a6df4', '#b05a00', '#177a3b', '#aa3377',
    '#6633cc', '#0099aa', '#cc3344', '#aaaa00',
];
export function defaultColor(index) {
    return DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
}
/**
 * Build a {@link Series} from samples + a label + an index that drives the
 * palette.  Useful for tests + the UI harness.
 */
export function makeSeries(id, label, points, index, visible = true) {
    return { id, label, color: defaultColor(index), visible, points };
}
/** Convenience: produce one Series per requested metric of one motor. */
export function motorMetricSeries(motorName, samples, index) {
    return [
        makeSeries(`${motorName}.power`, `${motorName} – power`, buildSampleSeries(samples, (s) => s.commandedPower), index),
        makeSeries(`${motorName}.velocity`, `${motorName} – velocity`, buildSampleSeries(samples, (s) => s.encoderVelocity), index),
        makeSeries(`${motorName}.current`, `${motorName} – current`, buildSampleSeries(samples, (s) => s.currentAmps), index),
    ];
}
//# sourceMappingURL=graphs.js.map