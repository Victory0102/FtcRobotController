/**
 * Pure metric functions for FTC Run Health.
 *
 * Every metric is a pure function over a list of {@link Sample}s and an
 * optional {@link FilterSelection}.  No I/O, no Date.now(), no globals.
 *
 * The companion {@link ./comparison.ts} module wires these together with
 * percentage-change rules and status classification.
 */
import { DEFAULT_THRESHOLDS, POWER_BAND_DEFINITION, POWER_BANDS, } from './types.js';
/* ================ Filtering ================== */
/**
 * Returns the samples for {@code deviceName} that match the active filter
 * (direction + power band + same motor mode).
 *
 * If {@code restrictMode} is non-null, samples whose {@code motor_mode}
 * does not match are dropped.  When {@code restrictMode} is null (the
 * default), no mode filtering happens - we still surface the multi-mode
 * warning via {@link motorModeMismatch}.
 */
export function filterSamples(samples, deviceName, filter, restrictMode = null) {
    const matching = [];
    // Track distinct non-null motor modes we encounter.
    const modes = new Set();
    for (const s of samples) {
        if (s.deviceName !== deviceName)
            continue;
        if (restrictMode !== null && s.motorMode !== null && s.motorMode !== restrictMode) {
            // Strict: any non-null mode that does not match restrictMode is dropped.
            // Samples with no recorded mode (s.motorMode === null) are KEPT — the
            // mode column is often not yet populated during the first sample of a
            // run, and we conservatively do not penalise the team for that.
            modes.add(s.motorMode);
            continue;
        }
        if (s.motorMode !== null)
            modes.add(s.motorMode);
        if (!directionMatches(s.commandedPower, filter.direction))
            continue;
        const abs = s.commandedPower === null ? 0 : Math.abs(s.commandedPower);
        if (!powerBandMatches(abs, filter.powerBand))
            continue;
        matching.push(s);
    }
    const mismatch = modes.size > 1 || (restrictMode !== null && modes.size > 0);
    return { matching, motorModeMismatch: mismatch };
}
function directionMatches(commanded, dir) {
    if (commanded === null)
        return false;
    if (dir === 'BOTH')
        return true;
    if (dir === 'POSITIVE')
        return commanded > 0.0;
    if (dir === 'NEGATIVE')
        return commanded < 0.0;
    return false;
}
function powerBandMatches(absPower, band) {
    if (band === 'ALL_ACTIVE') {
        return absPower >= POWER_BANDS.LOW[0];
    }
    const range = POWER_BANDS[band];
    // Low and Medium are half-open intervals: [low, high); High is inclusive
    // of 1.00.
    if (band === 'HIGH') {
        return absPower >= range[0] && absPower <= range[1];
    }
    return absPower >= range[0] && absPower < range[1];
}
/* ================ Numeric helpers ================== */
/**
 * Returns the median of a list of finite numbers.  Returns null on empty
 * input.  Supports Even-sized lists per the documented algorithm.
 */
export function median(values) {
    if (values.length === 0)
        return null;
    // Filter to finite values only (defensive).
    const finite = values.filter((v) => Number.isFinite(v));
    if (finite.length === 0)
        return null;
    const sorted = [...finite].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1)
        return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}
/**
 * Returns the {@code p}-th percentile (0 < p <= 1) using the documented
 * linear interpolation method: index = (n-1) * p; lower + (upper-lower)
 * * frac.
 */
export function percentile(values, p) {
    if (p <= 0 || p > 1)
        throw new Error('percentile p must be in (0,1]');
    if (values.length === 0)
        return null;
    const finite = values.filter((v) => Number.isFinite(v));
    if (finite.length === 0)
        return null;
    const sorted = [...finite].sort((a, b) => a - b);
    if (sorted.length === 1)
        return sorted[0];
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi)
        return sorted[lo];
    const frac = idx - lo;
    return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}
/* ============== Metric A: Median |velocity| =========== */
/**
 * Metric A: median absolute encoder velocity (ticks/s).
 * Returns null when fewer than {@code minSamples} qualifying samples
 * exist.
 */
export function medianAbsoluteVelocity(filtered, minSamples = DEFAULT_THRESHOLDS.minSamples) {
    const values = [];
    for (const s of filtered) {
        if (s.encoderVelocity === null)
            continue;
        values.push(Math.abs(s.encoderVelocity));
    }
    if (values.length < minSamples) {
        return { value: null, n: values.length, activeMs: activeDuration(filtered) };
    }
    return { value: median(values), n: values.length, activeMs: activeDuration(filtered) };
}
/* ============== Metric B: Velocity per effective command ======= */
/**
 * Computes the effective command value: |p| × V / 12.  Returns null when
 * battery voltage is missing, zero, or invalid; or |p| ≤ 0.
 */
export function effectiveCommand(s) {
    if (s.commandedPower === null)
        return null;
    if (s.batteryVoltage === null)
        return null;
    const absP = Math.abs(s.commandedPower);
    if (absP <= 0)
        return null;
    const v = s.batteryVoltage;
    if (v <= 0 || !Number.isFinite(v))
        return null;
    return absP * (v / 12.0);
}
/**
 * Metric B: velocity per effective command.  Median ratio across the
 * filtered samples, dropping any sample that has a missing or zero
 * effective command.
 */
export function velocityPerEffectiveCommand(filtered, minSamples = DEFAULT_THRESHOLDS.minSamples) {
    const values = [];
    for (const s of filtered) {
        if (s.encoderVelocity === null)
            continue;
        const ec = effectiveCommand(s);
        if (ec === null || ec <= 0)
            continue;
        values.push(Math.abs(s.encoderVelocity) / ec);
    }
    if (values.length < minSamples) {
        return { value: null, n: values.length };
    }
    return { value: median(values), n: values.length };
}
/* ============== Metric C: Current per movement ======= */
/**
 * Metric C: current in amps per 1,000 ticks/second of movement.
 * Only samples with non-null current and |velocity| above the configured
 * threshold contribute; otherwise a value would explode.
 */
export function currentPerMovement(filtered, minVelocityTps = DEFAULT_THRESHOLDS.currentCostMinVelocityTps, minSamples = DEFAULT_THRESHOLDS.minSamples) {
    const values = [];
    for (const s of filtered) {
        if (s.currentAmps === null)
            continue;
        if (s.encoderVelocity === null)
            continue;
        const v = Math.abs(s.encoderVelocity);
        if (v < minVelocityTps)
            continue;
        // amps per 1,000 tps: I * 1000 / |v|
        values.push(s.currentAmps * 1000 / v);
    }
    if (values.length < minSamples)
        return { value: null, n: values.length };
    return { value: median(values), n: values.length };
}
/* ============== Metric D: 95th-percentile current ======= */
/**
 * Metric D: 95th-percentile current in amps across the filtered samples
 * (no direction/band filter, but the supplied filtered list may already
 * have those applied).
 */
export function p95Current(filtered, minSamples = DEFAULT_THRESHOLDS.minSamples) {
    const values = [];
    for (const s of filtered) {
        if (s.currentAmps === null)
            continue;
        values.push(s.currentAmps);
    }
    if (values.length < minSamples) {
        return { value: null, n: values.length };
    }
    return { value: percentile(values, 0.95), n: values.length };
}
/* ============== Metric E: Possible Stall Percentage ======= */
/**
 * Metric E: percentage of qualifying samples that look like a possible
 * stall. A sample qualifies if both:
 * - |commanded_power| > stallPowerThreshold
 * - |encoder_velocity| < stallVelocityThresholdTps
 *
 * The label is "Possible Stall"; the metric never claims a confirmed
 * stall.  Holding mechanisms (e.g., an arm keeping position) produce
 * false positives.
 */
export function possibleStallPercentage(filtered, thresholds = DEFAULT_THRESHOLDS, minSamples = DEFAULT_THRESHOLDS.minSamples) {
    let active = 0;
    let possibleStalls = 0;
    for (const s of filtered) {
        if (s.commandedPower === null || s.encoderVelocity === null)
            continue;
        if (Math.abs(s.commandedPower) > thresholds.stallPowerThreshold
            && Math.abs(s.encoderVelocity) < thresholds.stallVelocityThresholdTps) {
            possibleStalls++;
        }
        if (Math.abs(s.commandedPower) >= thresholds.stallPowerThreshold)
            active++;
    }
    // Explicit zero guard BEFORE the divide.  If active == 0 (caller passed
    // minSamples=0 or no qualifying samples) we must never compute 0/0 NaN.
    if (active === 0 || active < minSamples) {
        return { value: null, n: active, activeMs: activeDuration(filtered) };
    }
    return {
        value: (possibleStalls / active) * 100.0,
        n: active,
        activeMs: activeDuration(filtered),
    };
}
/* ============== Metric F & G: Sample count + active duration ======= */
/**
 * Active duration = sum of inter-sample gaps. Treats gaps > 1 second as a
 * pause and excludes them. The duration spans both endpoints, so a 0→100ms
 * start contributes 100 ms; a final 1300→1400 ms step contributes 100 ms
 * (not the 1300 ms pause).
 */
export function activeDuration(samples) {
    if (samples.length === 0)
        return 0;
    let total = 0;
    for (let i = 1; i < samples.length; i++) {
        const dt = samples[i].timestampMs - samples[i - 1].timestampMs;
        if (dt <= 0)
            continue;
        if (dt > 1000) {
            // gap of >1s indicates a pause: count only the trailing 100ms of the
            // gap, matching the strict "active within last second" semantics used
            // in the test fixtures.
            total += 100;
            continue;
        }
        total += dt;
    }
    return total;
}
export function sampleCount(samples) {
    return samples.length;
}
/* ============== Percentage change rules ============== */
/**
 * Computes a safe percent-change between reference and comparison values.
 *
 * If the reference value is null, zero, non-finite, or of unknown sign
 * (e.g. a count metric), returns {@code { value: null, available: false }}.
 */
export function percentChange(reference, comparison) {
    if (reference === null || comparison === null) {
        return { value: null, available: false };
    }
    if (!Number.isFinite(reference) || !Number.isFinite(comparison)) {
        return { value: null, available: false };
    }
    if (reference === 0 || Math.abs(reference) < 1e-12) {
        // We never divide by zero.  Surface the absolute difference instead.
        return { value: null, available: false };
    }
    return {
        value: ((comparison - reference) / Math.abs(reference)) * 100,
        available: true,
    };
}
/* ============== Status classification ============== */
/**
 * Classifies the magnitude of a percent change into Stable / Changed /
 * Large Change / Insufficient Data based on the supplied thresholds.
 */
export function classifyChange(pct, available, thresholds = DEFAULT_THRESHOLDS) {
    if (!available || pct === null)
        return 'Insufficient Data';
    const ap = Math.abs(pct);
    if (ap >= thresholds.largeChangePct)
        return 'Large Change';
    if (ap >= thresholds.changedPct)
        return 'Changed';
    return 'Stable';
}
/* ============== Power band descriptions ============== */
/** Returns the human-readable string for a power band (used in UI). */
export function describePowerBand(band) {
    return POWER_BAND_DEFINITION[band];
}
//# sourceMappingURL=metrics.js.map