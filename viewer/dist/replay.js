/**
 * FTC Run Health replay engine.
 *
 * One shared clock drives every visualisation: motor graphs, custom-
 * channel value tables, the field view's robot marker, the synchronised
 * cursor, and event markers.  Consumers register a function that takes a
 * timestamp and updates its own DOM.  Playback speeds 0.25/0.5/1/2/4x
 * are time-scale multipliers applied advance-on-rAF, not different
 * timers, so we never compete with the browser's paint cycle.
 *
 * Read-only by construction: the engine holds no references to network,
 * websocket, opmode, or any mutable hardware surface.  It only reads
 * already-parsed Run data.
 *
 * Lookups (numeric / boolean / text):
 *   - "Latest previous sample".  We never fabricate motion.
 *   - Numeric interpolation is limited AND it is forbidden across a
 *     timestamp gap larger than {@link DEFAULT_MAX_GAP_MS}.
 */
/** Default maximum allowed gap before interpolation is forbidden. */
export const DEFAULT_MAX_GAP_MS = 500;
/** Default playback speed; 1.0 = wall-clock real-time. */
export const DEFAULT_SPEED = 1.0;
/** Allowed speeds per the user spec. */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4];
/** Default starting speed. */
export const DEFAULT_PLAYBACK_SPEED_INDEX = 2;
/* ====================== Pure lookup helpers ============================ */
/**
 * Binary search for the largest index where {@code samples[i].timestampMs <= t}.
 * Returns -1 when every sample is later than t.  Exposed for tests + the
 * other lookup helpers below.
 */
export function latestIndexAtOrBefore(samples, t) {
    if (samples.length === 0)
        return -1;
    let lo = 0, hi = samples.length - 1, best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (samples[mid].timestampMs <= t) {
            best = mid;
            lo = mid + 1;
        }
        else
            hi = mid - 1;
    }
    return best;
}
/**
 * Look up a numeric value at time {@code t}.
 *
 * Default policy (per the user spec: "nearest previous sample or limited
 * interpolation"): returns the latest previous sample's value verbatim.
 * Set {@code interpolate: true} to linearly interpolate across a small
 * gap (gap <= {@code maxGapMs}).  Larger gaps are always flat - we never
 * cross them.
 */
export function lookupNumeric(samples, t, maxGapMs = DEFAULT_MAX_GAP_MS, interpolate = false) {
    if (samples.length === 0)
        return null;
    const idx = latestIndexAtOrBefore(samples, t);
    if (idx === -1)
        return null;
    const cur = samples[idx];
    const v = numericValueOf(cur);
    if (v === null)
        return null;
    if (!interpolate || idx === samples.length - 1)
        return v;
    const next = samples[idx + 1];
    const dn = numericValueOf(next);
    if (dn === null)
        return v;
    const gap = next.timestampMs - cur.timestampMs;
    if (gap <= 0 || gap > maxGapMs)
        return v;
    const frac = (t - cur.timestampMs) / gap;
    return v + (dn - v) * frac;
}
/**
 * State-like lookup: returns the most recent previous sample's value.
 * State values are NEVER interpolated.
 */
export function lookupBoolean(samples, t) {
    const idx = latestIndexAtOrBefore(samples, t);
    if (idx === -1)
        return null;
    const s = samples[idx];
    return s.kind === 'boolean' ? s.valueBoolean : null;
}
export function lookupText(samples, t) {
    const idx = latestIndexAtOrBefore(samples, t);
    if (idx === -1)
        return null;
    const s = samples[idx];
    return s.kind === 'text' ? s.valueText : null;
}
/**
 * Pose is a numeric compound of x/y/heading; we honour the same
 * max-gap policy as numeric.  Returns null if x/y missing or non-finite.
 */
export function lookupPose(samples, t, maxGapMs = DEFAULT_MAX_GAP_MS) {
    const idx = latestIndexAtOrBefore(samples, t);
    if (idx === -1)
        return null;
    const cur = samples[idx];
    if (cur.kind !== 'pose')
        return null;
    if (cur.valueX === null || cur.valueY === null)
        return null;
    if (!Number.isFinite(cur.valueX) || !Number.isFinite(cur.valueY))
        return null;
    if (idx === samples.length - 1) {
        return { x: cur.valueX, y: cur.valueY, heading: cur.valueHeading, atMs: cur.timestampMs };
    }
    const next = samples[idx + 1];
    if (next.kind !== 'pose' || next.valueX === null || next.valueY === null) {
        return { x: cur.valueX, y: cur.valueY, heading: cur.valueHeading, atMs: cur.timestampMs };
    }
    const gap = next.timestampMs - cur.timestampMs;
    if (gap <= 0 || gap > maxGapMs) {
        return { x: cur.valueX, y: cur.valueY, heading: cur.valueHeading, atMs: cur.timestampMs };
    }
    const frac = (t - cur.timestampMs) / gap;
    return {
        x: cur.valueX + (next.valueX - cur.valueX) * frac,
        y: cur.valueY + (next.valueY - cur.valueY) * frac,
        heading: interpolateHeading(cur.valueHeading, next.valueHeading, frac),
        atMs: cur.timestampMs,
    };
}
function interpolateHeading(a, b, frac) {
    if (a === null || b === null)
        return a ?? b;
    // We do not interpolate heading mod 2pi here; consumers can re-normalise.
    return a + (b - a) * frac;
}
function numericValueOf(s) {
    if (s.kind === 'number') {
        if (s.valueNumber === null)
            return null;
        return Number.isFinite(s.valueNumber) ? s.valueNumber : null;
    }
    if (s.kind === 'pose') {
        if (s.valueX === null)
            return null;
        return Number.isFinite(s.valueX) ? s.valueX : null;
    }
    return null;
}
/**
 * Replay clock.  One singleton per browser tab; consumers register a
 * function that is called on every animation frame while playing, and on
 * every explicit seek.
 */
export class ReplayClock {
    constructor() {
        this.timeMs = 0;
        this.isPlaying = false;
        this.speed = DEFAULT_SPEED;
        this.rafId = null;
        this.lastWallMs = 0;
        this.startMs = 0;
        this.endMs = 0;
        this.consumers = new Set();
    }
    /** Load a run's duration bounds.  Calling this resets timeMs to 0. */
    loadRun(startMs, endMs) {
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
            return;
        }
        this.startMs = startMs;
        this.endMs = endMs;
        this.timeMs = 0;
        this.lastWallMs = 0;
        if (this.isPlaying) {
            this.stopRaf();
            this.startRaf();
        }
        else {
            this.notify();
        }
    }
    /** Register a consumer; immediate single notify() is dispatched once. */
    registerConsumer(c) {
        this.consumers.add(c);
        try {
            c(this.timeMs);
        }
        catch (e) { /* swallow - consumer fault */ }
        return () => { this.consumers.delete(c); };
    }
    /** Read the latest snapshot for UI binding outside rAF. */
    snapshot() {
        const totalMs = Math.max(1, this.endMs - this.startMs);
        const inRun = Math.min(Math.max(0, this.timeMs), totalMs);
        return {
            timeMs: this.timeMs,
            wallMs: this.lastWallMs,
            isPlaying: this.isPlaying,
            speed: this.speed,
            progress: inRun / totalMs,
        };
    }
    play() {
        if (this.isPlaying)
            return;
        if (this.timeMs >= this.endMs - this.startMs)
            this.timeMs = 0;
        this.isPlaying = true;
        this.lastWallMs = 0;
        this.startRaf();
    }
    pause() {
        if (!this.isPlaying)
            return;
        this.isPlaying = false;
        this.stopRaf();
        this.notify();
    }
    restart() {
        this.timeMs = 0;
        if (!this.isPlaying)
            this.notify();
    }
    /** Seek to {@code t} (clamped to [0, endMs-startMs]). */
    seek(t) {
        const total = Math.max(0, this.endMs - this.startMs);
        this.timeMs = Math.max(0, Math.min(total, t));
        this.notify();
    }
    setSpeed(s) {
        if (!PLAYBACK_SPEEDS.includes(s))
            return;
        this.speed = s;
        if (this.isPlaying) {
            this.stopRaf();
            this.startRaf();
        }
        else {
            this.notify();
        }
    }
    getSpeed() { return this.speed; }
    isPlayingNow() { return this.isPlaying; }
    getTime() { return this.timeMs; }
    getDuration() { return Math.max(0, this.endMs - this.startMs); }
    startRaf() {
        if (typeof requestAnimationFrame !== 'function')
            return;
        this.rafId = requestAnimationFrame((now) => this.tick(now));
    }
    stopRaf() {
        if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this.rafId);
        }
        this.rafId = null;
    }
    tick(nowMs) {
        if (!this.isPlaying)
            return;
        if (this.lastWallMs === 0)
            this.lastWallMs = nowMs;
        const dt = nowMs - this.lastWallMs;
        this.lastWallMs = nowMs;
        this.timeMs += dt * this.speed;
        const total = Math.max(0, this.endMs - this.startMs);
        if (this.timeMs >= total) {
            this.timeMs = total;
            this.isPlaying = false;
            this.notify();
            return;
        }
        this.notify();
        this.rafId = requestAnimationFrame((now) => this.tick(now));
    }
    notify() {
        for (const c of this.consumers) {
            try {
                c(this.timeMs);
            }
            catch (e) { /* consumer fault is not propagated */ }
        }
    }
}
/** Global singleton replay clock.  Tests can construct their own. */
export const globalReplayClock = new ReplayClock();
/**
 * Compute the end-of-run duration range for one Run, using either the
 * sample buffer span OR the manifest.durationMs.  Always prefer
 * manifest.durationMs when present and non-zero so callers get the full
 * recorded duration even if the last sample timestamp is short.
 */
export function runDurationMs(samples, manifestDurationMs) {
    if (manifestDurationMs !== null && Number.isFinite(manifestDurationMs) && manifestDurationMs > 0) {
        return manifestDurationMs;
    }
    if (samples.length === 0)
        return 0;
    return Math.max(0, samples[samples.length - 1].timestampMs);
}
//# sourceMappingURL=replay.js.map