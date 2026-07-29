/**
 * FTC Run Health chronological trend charts.
 *
 * One data-prep module that builds {@link ChronoPoint}[] per series
 * across runs in chronological order.  Missing data is represented as
 * a `null` value, never zero or a placeholder; the renderer treats null
 * as a gap and calls moveTo() at every transition.
 *
 * Baseline delta:  delta = current.value - baselineRun.value.  both
 * null when either side is missing.
 *
 * Previous-run delta:  same as above but with the chronologically prior
 * point in the same series.  The first point has no previous delta.
 */
import { perMotorTrend } from './comparison.js';
import { DEFAULT_THRESHOLDS } from './types.js';
/* ============== Motor-metric trend builders ========================== */
/** Build median velocity trend rows.  Requires the chosen motor name. */
export function medianVelocityTrend(runs, motorName, filter, thresholds = DEFAULT_THRESHOLDS) {
    return buildChronoFromTrendRows(perMotorTrend(runs, motorName, filter, thresholds), runs, (r) => r.medianVelocity);
}
export function velocityEfficiencyTrend(runs, motorName, filter, thresholds = DEFAULT_THRESHOLDS) {
    return buildChronoFromTrendRows(perMotorTrend(runs, motorName, filter, thresholds), runs, (r) => r.velocityEfficiency);
}
export function currentCostTrend(runs, motorName, filter, thresholds = DEFAULT_THRESHOLDS) {
    return buildChronoFromTrendRows(perMotorTrend(runs, motorName, filter, thresholds), runs, (r) => r.currentCost);
}
export function p95CurrentTrend(runs, motorName, filter, thresholds = DEFAULT_THRESHOLDS) {
    return buildChronoFromTrendRows(perMotorTrend(runs, motorName, filter, thresholds), runs, (r) => r.p95Current);
}
export function possibleStallPctTrend(runs, motorName, filter, thresholds = DEFAULT_THRESHOLDS) {
    return buildChronoFromTrendRows(perMotorTrend(runs, motorName, filter, thresholds), runs, (r) => r.possibleStallPct);
}
/* ============== Battery trend builders =============================== */
/** Battery minimum voltage per run.  Returns null when the run had no
 *  positive batteryVoltage sample. */
export function batteryMinTrend(runs) {
    return runs.map((run) => {
        let min = null;
        for (const s of run.samples) {
            if (s.batteryVoltage === null)
                continue;
            if (!Number.isFinite(s.batteryVoltage) || s.batteryVoltage <= 0)
                continue;
            if (min === null || s.batteryVoltage < min)
                min = s.batteryVoltage;
        }
        return makeBasePoint(run, min, min === null);
    }).sort(byRunStartedAt);
}
/** Battery median voltage per run.  Runs with insufficient samples return
 *  null (the renderer treats it as a gap). */
export function batteryMedianTrend(runs) {
    return runs.map((run) => {
        const voltages = [];
        for (const s of run.samples) {
            if (s.batteryVoltage === null)
                continue;
            if (Number.isFinite(s.batteryVoltage) && s.batteryVoltage > 0) {
                voltages.push(s.batteryVoltage);
            }
        }
        if (voltages.length < 5) {
            return makeBasePoint(run, null, true);
        }
        const sorted = [...voltages].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 1 ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;
        return makeBasePoint(run, median, false);
    }).sort(byRunStartedAt);
}
/* ============== Loop-time trend builders ============================= */
/**
 * Loop time is the inter-sample delta between consecutive
 * {@code timestampMs} values.  We aggregate per-run median + p95.  Runs
 * with fewer than five non-zero deltas are flagged insufficient.
 */
export function loopTimeTrend(runs) {
    const medianPts = [];
    const p95Pts = [];
    for (const run of runs) {
        const dt = [];
        for (let i = 1; i < run.samples.length; i++) {
            const a = run.samples[i - 1].timestampMs;
            const b = run.samples[i].timestampMs;
            const gap = b - a;
            if (gap > 0 && gap <= 1000)
                dt.push(gap);
        }
        if (dt.length < 5) {
            medianPts.push(makeBasePoint(run, null, true));
            p95Pts.push(makeBasePoint(run, null, true));
            continue;
        }
        medianPts.push(makeBasePoint(run, medianOf(dt), false));
        p95Pts.push(makeBasePoint(run, percentileOf(dt, 0.95), false));
    }
    medianPts.sort(byRunStartedAt);
    p95Pts.sort(byRunStartedAt);
    return { median: medianPts, p95: p95Pts };
}
function medianOf(values) {
    if (values.length === 0)
        return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}
function percentileOf(values, p) {
    if (values.length === 0)
        return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length === 1)
        return sorted[0];
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi)
        return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
/* ============== Custom-channel trend builders ======================= */
/**
 * Build a custom-numeric-channel trend row across runs.  Reads the
 * per-channel samples (already in {@link Run.channels?.byChannel}).  For
 * runs without a channels payload, returns null (the renderer renders a
 * gap).
 */
export function customChannelTrend(runs, channelName) {
    return runs.map((run) => {
        const chs = run.channels?.byChannel[channelName.toLowerCase()];
        if (!chs || chs.length === 0)
            return makeBasePoint(run, null, true);
        const values = [];
        for (const ch of chs) {
            if (ch.kind !== 'number')
                continue;
            if (ch.valueNumber === null)
                continue;
            if (Number.isFinite(ch.valueNumber))
                values.push(ch.valueNumber);
        }
        if (values.length < 1)
            return makeBasePoint(run, null, true);
        return makeBasePoint(run, medianOf(values), false);
    }).sort(byRunStartedAt);
}
/**
 * Compute the baseline and previous-run delta for every point in
 * {@code series}.  Returns a NEW array; the input is not mutated.
 *
 * Both delta values are null when either side is missing data, per the
 * "never represent missing as zero" rule.
 */
export function applyDeltas(series, opts) {
    const chronological = [...series].sort(byRunStartedAt);
    const baselineIndex = opts.baselineRunId
        ? chronological.findIndex((p) => p.runId === opts.baselineRunId)
        : -1;
    const baselineValue = baselineIndex >= 0 ? chronological[baselineIndex].value : null;
    const out = [];
    for (let i = 0; i < chronological.length; i++) {
        const cur = chronological[i];
        const prev = i > 0 ? chronological[i - 1] : null;
        const baselineDelta = (baselineValue === null || cur.value === null)
            ? null
            : cur.value - baselineValue;
        const previousDelta = (prev === null || cur.value === null || prev.value === null)
            ? null
            : cur.value - prev.value;
        out.push({ ...cur, baselineDelta, previousDelta });
    }
    return out;
}
/* ============== Internal helpers ====================================== */
function makeBasePoint(run, value, insufficient) {
    return {
        runId: run.runId,
        runStartedAt: run.runStartedAt,
        opmodeName: run.opmodeName,
        buildIdentifier: run.buildIdentifier ?? '',
        value,
        baselineDelta: null,
        previousDelta: null,
        insufficient,
    };
}
function buildChronoFromTrendRows(rows, runs, pick) {
    const byRunId = new Map();
    for (const r of runs)
        byRunId.set(r.runId, r);
    return rows.map((row) => {
        const run = byRunId.get(row.runId);
        if (!run) {
            return {
                runId: row.runId,
                runStartedAt: row.runStartedAt,
                opmodeName: '',
                buildIdentifier: '',
                value: pick(row),
                baselineDelta: null,
                previousDelta: null,
                insufficient: false,
            };
        }
        const v = pick(row);
        return makeBasePoint(run, v, v === null && row.comparableSamples < 5);
    });
}
function byRunStartedAt(a, b) {
    return a.runStartedAt.localeCompare(b.runStartedAt);
}
//# sourceMappingURL=trends.js.map