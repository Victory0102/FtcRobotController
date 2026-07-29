/**
 * FTC Run Health generic 12 ft x 12 ft field renderer.
 *
 * Public surface:
 *   - Coordinate helpers (pure, testable): fieldToScreen, screenToField,
 *     fieldHeadingToScreen, screenHeadingToField.
 *   - Path / boundary math (pure): clipPathToBoundary, computeBounds.
 *   - Distance + perimeter helpers (pure).
 *   - Renderer: drawField(ctx, opts) draws tiles + axes + boundary +
 *     traveled path; an optional layered DOM-side robot marker helper
 *     marks the position at a given pose sample.
 *
 * Coordinate convention (FTC standard):
 *   - Origin (0, 0) at field centre.
 *   - X axis: -72 .. +72 inches, positive X pointing right.
 *   - Y axis: -72 .. +72 inches, positive Y pointing forward (which on
 *     the rendered canvas maps to a screen UP when we invert Y).
 *   - Tiles: 24 inches each, so 6 x 6 = 36 tiles total.
 *   - Heading: 0 = +X (East), +pi/2 = +Y (forward).
 */
/** Total field dimension in inches (a side of the square). */
export const FIELD_SIZE_IN = 144;
/** Half-size in inches, used as the field coordinate bounds. */
export const FIELD_HALF_IN = 72;
/** Side length of one tile in inches. */
export const TILE_SIZE_IN = 24;
/** Number of tiles along one side. */
export const TILES_PER_AXIS = 6;
/* ==================== Pure coordinate helpers ========================= */
/**
 * Map a field-X coordinate to screen pixels along the canvas's horizontal
 * axis.  Field centre maps to width/2.
 */
export function fieldXToScreen(xIn, screenWidth) {
    return ((xIn + FIELD_HALF_IN) / FIELD_SIZE_IN) * screenWidth;
}
/**
 * Map a field-Y coordinate to screen pixels along the canvas's vertical
 * axis.  Positive Y is up in the field; on the canvas that maps to a
 * smaller pixel index, so we invert.
 */
export function fieldYToScreen(yIn, screenHeight) {
    return ((FIELD_HALF_IN - yIn) / FIELD_SIZE_IN) * screenHeight;
}
export const DEFAULT_ZOOM_PAN = {
    zoomX: 1.0, zoomY: 1.0, panX: 0.0, panY: 0.0, fitToField: false,
};
/**
 * Apply the active zoom/pan state to a field coordinate, returning the
 * screen coordinates.  Honours {@link ZoomPanState.fitToField} by
 * collapsing zoom to 1 and pan to 0 so the whole field is always shown.
 */
export function fieldToScreen(xIn, yIn, width, height, zp = DEFAULT_ZOOM_PAN) {
    if (zp.fitToField) {
        return {
            sx: fieldXToScreen(xIn, width),
            sy: fieldYToScreen(yIn, height),
        };
    }
    const cx = width / 2 + zp.panX;
    const cy = height / 2 - zp.panY;
    const kx = (zp.zoomX * width) / FIELD_SIZE_IN;
    const ky = (zp.zoomY * height) / FIELD_SIZE_IN;
    return {
        sx: cx + xIn * kx,
        sy: cy - yIn * ky,
    };
}
/** Inverse of {@link fieldToScreen}, used by hit-testing on click. */
export function screenToField(sx, sy, width, height, zp = DEFAULT_ZOOM_PAN) {
    if (zp.fitToField) {
        return {
            fx: (sx / width) * FIELD_SIZE_IN - FIELD_HALF_IN,
            fy: FIELD_HALF_IN - (sy / height) * FIELD_SIZE_IN,
        };
    }
    const cx = width / 2 + zp.panX;
    const cy = height / 2 - zp.panY;
    const kx = (zp.zoomX * width) / FIELD_SIZE_IN;
    const ky = (zp.zoomY * height) / FIELD_SIZE_IN;
    return { fx: (sx - cx) / kx, fy: (cy - sy) / ky };
}
/**
 * Map a yaw (heading) in radians to a screen degrees offset.  Screen
 * angles grow counter-clockwise but field angles follow standard math.
 * The convention here: 0 rad -> pointing right.  On screen, +Y is down,
 * so the rotation must be inverted for visual fidelity.
 */
export function fieldHeadingToScreen(headingRad) {
    return -(headingRad * 180 / Math.PI);
}
/* ==================== Path / boundary math ============================ */
/** Inclusive bounds check: returns true if x and y are inside the field. */
export function isInsideField(xIn, yIn) {
    return Math.abs(xIn) <= FIELD_HALF_IN && Math.abs(yIn) <= FIELD_HALF_IN;
}
/**
 * Clip a polyline to the field boundary by clipping each segment with
 * the Liang-Barsky algorithm.  Coordinates outside the field become
 * marked with NaN or drop-out entries; downstream the renderer skips
 * them.  We return an array of clipped points including null sentinels
 * signalling a gap when a segment leaves + re-enters the field.
 */
export function clipPathToBoundary(points) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
        const cur = points[i];
        if (isInsideField(cur.x, cur.y)) {
            out.push({ x: cur.x, y: cur.y, tMs: cur.tMs });
            continue;
        }
        out.push(null);
    }
    return out;
}
/**
 * Compute the bounding box of a sequence of field-coord polyline points.
 * Used to auto-fit the field view to the travelled path.
 */
export function computeBounds(points) {
    if (points.length === 0)
        return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX)
            minX = p.x;
        if (p.y < minY)
            minY = p.y;
        if (p.x > maxX)
            maxX = p.x;
        if (p.y > maxY)
            maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
}
/**
 * Given a path's bounds, return the smallest zoom factor + pan offset such
 * that the bounds fit fully inside the canvas.  Returns
 * {@link DEFAULT_ZOOM_PAN} when bounds is null.  Caller applies this to
 * the active {@link ZoomPanState}.
 */
export function fitToContent(bounds, canvasWidth, canvasHeight) {
    if (bounds === null) {
        return { ...DEFAULT_ZOOM_PAN };
    }
    const wIn = Math.max(1, bounds.maxX - bounds.minX);
    const hIn = Math.max(1, bounds.maxY - bounds.minY);
    const margin = 1.2; // 20% padding
    const zoomX = (FIELD_SIZE_IN / wIn) / margin;
    const zoomY = (FIELD_SIZE_IN / hIn) / margin;
    // Pan so the centre of the bounds aligns with the canvas centre.
    const cxIn = (bounds.minX + bounds.maxX) / 2;
    const cyIn = (bounds.minY + bounds.maxY) / 2;
    return {
        zoomX, zoomY,
        panX: -cxIn * (zoomX * canvasWidth) / FIELD_SIZE_IN,
        panY: cyIn * (zoomY * canvasHeight) / FIELD_SIZE_IN,
        fitToField: false,
    };
}
/**
 * Render the field onto a canvas.  Pure draw (no side effects beyond the
 * canvas context).  Returns the count of path segments drawn.
 */
export function drawField(ctx, width, height, opts = {}) {
    const zp = opts.zp ?? DEFAULT_ZOOM_PAN;
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    // Field background.
    const tl = fieldToScreen(-FIELD_HALF_IN, FIELD_HALF_IN, width, height, zp);
    const br = fieldToScreen(FIELD_HALF_IN, -FIELD_HALF_IN, width, height, zp);
    ctx.fillStyle = '#fafbfd';
    ctx.fillRect(tl.sx, tl.sy, br.sx - tl.sx, br.sy - tl.sy);
    // 24-inch tile grid.
    ctx.strokeStyle = '#dde2eb';
    ctx.lineWidth = 1;
    for (let i = -FIELD_HALF_IN; i <= FIELD_HALF_IN; i += TILE_SIZE_IN) {
        if (i === -FIELD_HALF_IN || i === FIELD_HALF_IN)
            continue;
        const a = fieldToScreen(i, -FIELD_HALF_IN, width, height, zp);
        const b = fieldToScreen(i, FIELD_HALF_IN, width, height, zp);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
        const c = fieldToScreen(-FIELD_HALF_IN, i, width, height, zp);
        const d = fieldToScreen(FIELD_HALF_IN, i, width, height, zp);
        ctx.beginPath();
        ctx.moveTo(c.sx, c.sy);
        ctx.lineTo(d.sx, d.sy);
        ctx.stroke();
    }
    // Boundary.
    ctx.strokeStyle = '#8b91a0';
    ctx.lineWidth = 2;
    ctx.strokeRect(tl.sx, tl.sy, br.sx - tl.sx, br.sy - tl.sy);
    // Centerline + axes.
    ctx.strokeStyle = '#b6bcc8';
    const cTop = fieldToScreen(0, FIELD_HALF_IN, width, height, zp);
    const cBot = fieldToScreen(0, -FIELD_HALF_IN, width, height, zp);
    ctx.beginPath();
    ctx.moveTo(cTop.sx, cTop.sy);
    ctx.lineTo(cBot.sx, cBot.sy);
    ctx.stroke();
    const cLeft = fieldToScreen(-FIELD_HALF_IN, 0, width, height, zp);
    const cRight = fieldToScreen(FIELD_HALF_IN, 0, width, height, zp);
    ctx.beginPath();
    ctx.moveTo(cLeft.sx, cLeft.sy);
    ctx.lineTo(cRight.sx, cRight.sy);
    ctx.stroke();
    ctx.fillStyle = '#5a626e';
    ctx.font = '11px sans-serif';
    // Positive-direction axis labels.
    const labX = fieldToScreen(FIELD_HALF_IN - 4, -FIELD_HALF_IN + 4, width, height, zp);
    ctx.fillText('+X', labX.sx - 16, labX.sy + 12);
    const labY = fieldToScreen(-FIELD_HALF_IN + 4, FIELD_HALF_IN - 4, width, height, zp);
    ctx.fillText('+Y', labY.sx, labY.sy - 4);
    ctx.fillText('-X', cLeft.sx + 4, cLeft.sy + 12);
    ctx.fillText('-Y', cBot.sx + 4, cBot.sy - 4);
    // Traveled path.
    let drawn = 0;
    if (opts.path && opts.path.length > 0) {
        ctx.strokeStyle = '#2a6df4';
        ctx.lineWidth = 2;
        ctx.beginPath();
        let started = false;
        for (const p of opts.path) {
            const s = fieldToScreen(p.x, p.y, width, height, zp);
            if (!started) {
                ctx.moveTo(s.sx, s.sy);
                started = true;
            }
            else {
                ctx.lineTo(s.sx, s.sy);
            }
            drawn++;
        }
        ctx.stroke();
    }
    // Robot marker.
    if (opts.robot) {
        const s = fieldToScreen(opts.robot.x, opts.robot.y, width, height, zp);
        ctx.fillStyle = '#177a3b';
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, 5, 0, Math.PI * 2);
        ctx.fill();
        if (opts.robot.headingRad !== undefined) {
            const deg = fieldHeadingToScreen(opts.robot.headingRad);
            const len = 18;
            const tx = s.sx + len * Math.cos(deg * Math.PI / 180);
            const ty = s.sy + len * Math.sin(deg * Math.PI / 180);
            ctx.strokeStyle = '#177a3b';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(s.sx, s.sy);
            ctx.lineTo(tx, ty);
            ctx.stroke();
        }
    }
    ctx.restore();
    return drawn;
}
/**
 * Build a traveled-path polyline from a pose channel series.  Skips pose
 * samples that lack x/y or are non-finite, and respects the documented
 * gap rule (consecutive samples whose dt exceeds 500 ms are split into
 * separate path polylines via null sentinels).
 */
export function poseSeriesToPath(samples, gapThresholdMs = 500) {
    const out = [];
    let prevT = null;
    for (const s of samples) {
        if (s.kind !== 'pose')
            continue;
        if (s.valueX === null || s.valueY === null)
            continue;
        if (!Number.isFinite(s.valueX) || !Number.isFinite(s.valueY))
            continue;
        const gap = prevT !== null && (s.timestampMs - prevT) > gapThresholdMs;
        out.push({ x: s.valueX, y: s.valueY, tMs: s.timestampMs, gap });
        prevT = s.timestampMs;
    }
    return out;
}
//# sourceMappingURL=field.js.map