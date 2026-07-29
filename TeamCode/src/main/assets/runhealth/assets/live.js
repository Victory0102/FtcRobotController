export class LivePoller {
    constructor(opts) {
        this.timer = null;
        this.controller = null;
        this.running = false;
        this.consecutiveFailures = 0;
        this.visibilityFactor = 5;
        this.url = opts?.url ?? '/runhealth/api/live/snapshot';
        this.pollMs = opts?.pollMs ?? 250;
        this.maxBackoffMs = opts?.maxBackoffMs ?? 5000;
        this.fetchImpl = opts?.fetchImpl ?? fetch.bind(globalThis);
        this.docLike = opts?.documentLike ?? (typeof document !== 'undefined' ? document : null);
    }
    isRunning() { return this.running; }
    start(onSnap, onErr) {
        if (this.running)
            return;
        this.running = true;
        this.consecutiveFailures = 0;
        this.scheduleNext(onSnap, onErr ?? (() => { }));
    }
    stop() {
        this.running = false;
        if (this.timer != null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.controller != null) {
            try {
                this.controller.abort();
            }
            catch { /* ignore */ }
            this.controller = null;
        }
    }
    scheduleNext(onSnap, onErr) {
        if (!this.running)
            return;
        const factor = this.hiddenFactor();
        const wait = this.computeBackoff() * factor;
        this.timer = setTimeout(() => { void this.tickOnce(onSnap, onErr); }, wait);
    }
    computeBackoff() {
        if (this.consecutiveFailures <= 0)
            return this.pollMs;
        const raw = this.pollMs << this.consecutiveFailures; // 2^k * pollMs
        return Math.min(raw, this.maxBackoffMs);
    }
    hiddenFactor() {
        if (!this.docLike)
            return 1;
        if (this.docLike.visibilityState === 'hidden')
            return this.visibilityFactor;
        return 1;
    }
    async tickOnce(onSnap, onErr) {
        if (!this.running)
            return;
        // Abort any prior in-flight request before scheduling a new one.
        if (this.controller != null) {
            try {
                this.controller.abort();
            }
            catch { /* ignore */ }
        }
        const c = new AbortController();
        this.controller = c;
        try {
            const resp = await this.fetchImpl(this.url, { signal: c.signal });
            if (!resp.ok)
                throw new Error('http_' + resp.status);
            const txt = await resp.text();
            let parsed;
            try {
                parsed = JSON.parse(txt);
            }
            catch (e) {
                throw new Error('parse_error');
            }
            this.consecutiveFailures = 0;
            onSnap(parsed);
        }
        catch (err) {
            // AbortError is expected when stop() raced with an in-flight request.
            const msg = (err instanceof Error ? err.message : String(err));
            if (msg === 'AbortError' || /aborted/i.test(msg)) {
                // Do not count as a real failure; just exit quietly.
                return;
            }
            this.consecutiveFailures += 1;
            onErr({ reason: msg || 'unknown', attempt: this.consecutiveFailures });
        }
        finally {
            if (this.controller === c)
                this.controller = null;
            this.scheduleNext(onSnap, onErr);
        }
    }
}
export const LIVE_LIMITS = {
    MAX_HISTORY_MS: 60000,
    MAX_MOTOR_SERIES: 8,
    MAX_CHANNEL_SERIES_PER_KIND: 24,
    MAX_PATH_POINTS: 600,
    MAX_EVENTS: 200,
    MAX_POINTS_PER_GRAPH: 600,
};
export class LiveStore {
    constructor() {
        this.lastSequence = -1;
        this.motorHistoryByName = new Map();
        this.channelHistoryByName = new Map();
        this.poseHistoryByName = new Map();
        this.events = [];
        this._batteryHistory = [];
        this.accepted = 0;
        this._firstAcceptedAtMs = null;
        this._lastAcceptedAtMs = null;
    }
    /** Returns count of accepted (non-duplicate, non-out-of-order) snapshots. */
    acceptedCount() { return this.accepted; }
    /** Resets all bounded buffers. */
    reset() {
        this.lastSequence = -1;
        this.motorHistoryByName.clear();
        this.channelHistoryByName.clear();
        this.poseHistoryByName.clear();
        this.events = [];
        this._batteryHistory = [];
        this.accepted = 0;
        this._firstAcceptedAtMs = null;
        this._lastAcceptedAtMs = null;
    }
    /**
     * Apply a new snapshot.  Out-of-order (sequence < lastSequence) and
     * duplicates (sequence == lastSequence) are silently dropped.
     * Trimming happens progressively per buffer.
     */
    apply(snap) {
        if (!snap || typeof snap !== 'object')
            return;
        if (typeof snap.sequence !== 'number')
            return;
        if (snap.sequence <= this.lastSequence)
            return;
        this.lastSequence = snap.sequence;
        this.accepted += 1;
        const now = Number(snap.timestamp_ms) || Date.now();
        if (this._firstAcceptedAtMs == null)
            this._firstAcceptedAtMs = now;
        this._lastAcceptedAtMs = now;
        // ---- battery ----
        if (snap.battery_voltage != null) {
            this._batteryHistory.push({ t: now, v: snap.battery_voltage });
            this.trimByWindow(this._batteryHistory, now, LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
        }
        // ---- motors ----
        if (Array.isArray(snap.motors)) {
            // Truncate to MAX_MOTOR_SERIES across this tick to enforce cap per
            // snapshot.  Older entries are evicted on the next apply if new
            // devices appear.
            const motors = snap.motors.slice(0, LIVE_LIMITS.MAX_MOTOR_SERIES);
            for (const mv of motors) {
                if (!mv || typeof mv.device_name !== 'string')
                    continue;
                const slice = this.ensureMotor(mv.device_name);
                slice.powerHistory.push({ t: now, v: mv.power ?? null });
                slice.positionHistory.push({ t: now, v: mv.position_ticks ?? null });
                slice.velocityHistory.push({ t: now, v: mv.velocity_ticks_per_second ?? null });
                slice.currentHistory.push({ t: now, v: mv.current_amps ?? null });
                if (mv.mode != null)
                    slice.mode = mv.mode;
                this.trimByWindow(slice.powerHistory, now, LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
                this.trimByWindow(slice.positionHistory, now, LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
                this.trimByWindow(slice.velocityHistory, now, LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
                this.trimByWindow(slice.currentHistory, now, LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
            }
        }
        if (snap.battery_voltage != null) {
            for (const slice of this.motorHistoryByName.values()) {
                slice.batteryHistory.push({ t: now, v: snap.battery_voltage });
                this.trimByWindow(slice.batteryHistory, now, LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
            }
        }
        // ---- channels ----
        if (Array.isArray(snap.channels)) {
            const channels = snap.channels.slice(0, LIVE_LIMITS.MAX_CHANNEL_SERIES_PER_KIND);
            for (const cv of channels) {
                if (!cv || typeof cv.name !== 'string')
                    continue;
                const kind = (cv.kind ?? 'number');
                const slice = this.ensureChannel(cv.name, kind);
                slice.unit = cv.unit ?? slice.unit;
                slice.group = cv.group ?? slice.group;
                slice.description = cv.description ?? slice.description;
                const numVal = kind === 'number' ? cv.value_number ?? null :
                    kind === 'pose' ? null :
                        null;
                if (kind === 'number') {
                    slice.history.push({ t: now, v: numVal });
                    this.trimByWindow(slice.history, now, LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
                }
                else if (kind === 'boolean') {
                    slice.booleanHistory.push({ t: now, v: cv.value_boolean ?? null });
                    if (slice.booleanHistory.length > LIVE_LIMITS.MAX_POINTS_PER_GRAPH) {
                        slice.booleanHistory.splice(0, slice.booleanHistory.length - LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
                    }
                }
                else if (kind === 'text') {
                    slice.textHistory.push({ t: now, text: cv.value_text ?? null });
                    if (slice.textHistory.length > LIVE_LIMITS.MAX_POINTS_PER_GRAPH) {
                        slice.textHistory.splice(0, slice.textHistory.length - LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
                    }
                }
                else if (kind === 'pose') {
                    const path = this.poseHistoryByName.get(cv.name) ?? [];
                    path.push({
                        t: now,
                        x: cv.pose_x ?? null,
                        y: cv.pose_y ?? null,
                        heading: cv.pose_heading ?? null,
                    });
                    if (path.length > LIVE_LIMITS.MAX_PATH_POINTS) {
                        path.splice(0, path.length - LIVE_LIMITS.MAX_PATH_POINTS);
                    }
                    this.poseHistoryByName.set(cv.name, path);
                    slice.poseHistory = path;
                }
                else if (kind === 'event') {
                    slice.textHistory.push({ t: now, text: cv.value_text ?? null });
                    if (slice.textHistory.length > LIVE_LIMITS.MAX_POINTS_PER_GRAPH) {
                        slice.textHistory.splice(0, slice.textHistory.length - LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
                    }
                }
            }
        }
        // ---- events ----
        if (Array.isArray(snap.events)) {
            const evs = snap.events;
            for (const e of evs) {
                if (!e)
                    continue;
                this.events.push({ t: Number(e.timestamp_ms) || now, label: e.label ?? '' });
            }
            if (this.events.length > LIVE_LIMITS.MAX_EVENTS) {
                this.events.splice(0, this.events.length - LIVE_LIMITS.MAX_EVENTS);
            }
        }
    }
    /** Returns motor slice by name, or undefined. */
    getMotor(name) {
        return this.motorHistoryByName.get(name);
    }
    /** Returns channel slice by name, or undefined. */
    getChannel(name) {
        return this.channelHistoryByName.get(name);
    }
    /** Returns the most-recent pose channel's path, or empty. */
    getPrimaryPath() {
        for (const p of this.poseHistoryByName.values())
            return p;
        return [];
    }
    /** Returns the robot's most-recent pose, or null if none. */
    lastPose() {
        const path = this.getPrimaryPath();
        let last = null;
        for (const p of path) {
            if (p.x == null || p.y == null)
                continue;
            last = p;
        }
        if (!last)
            return null;
        return { x: last.x, y: last.y, heading: last.heading ?? 0 };
    }
    /** Returns all retained event markers (bounded to MAX_EVENTS). */
    getEvents() {
        return this.events.slice();
    }
    /** Battery voltage series in time order, oldest first. */
    getBatteryHistory() {
        return this._batteryHistory.slice();
    }
    /**
     * Returns the wall-clock acceptance range for the current session in
     * milliseconds since epoch.  Used by {@link liveSnapshotStats} and
     * forwarded through the Public-API boundary without piercing
     * encapsulation via `as unknown` casts.
     */
    getAcceptedRangeMs() {
        return { first: this._firstAcceptedAtMs, last: this._lastAcceptedAtMs };
    }
    /** Names of every motor ever observed, deduped.  O(N) scan. */
    getMotorNames() {
        return Array.from(this.motorHistoryByName.keys());
    }
    /** Names of every channel ever observed, in insertion order. */
    getChannelNames() {
        return Array.from(this.channelHistoryByName.keys());
    }
    ensureMotor(name) {
        let s = this.motorHistoryByName.get(name);
        if (!s) {
            s = {
                deviceName: name,
                powerHistory: [],
                positionHistory: [],
                velocityHistory: [],
                currentHistory: [],
                batteryHistory: [],
                mode: null,
            };
            this.motorHistoryByName.set(name, s);
        }
        return s;
    }
    ensureChannel(name, kind) {
        let s = this.channelHistoryByName.get(name);
        if (!s) {
            s = {
                name, kind,
                history: [],
                textHistory: [],
                booleanHistory: [],
                poseHistory: [],
                unit: null, group: null, description: null,
            };
            this.channelHistoryByName.set(name, s);
        }
        return s;
    }
    trimByWindow(buf, now, maxPoints) {
        // 1) drop points older than now - MAX_HISTORY_MS
        const cutoff = now - LIVE_LIMITS.MAX_HISTORY_MS;
        let i = 0;
        while (i < buf.length && buf[i].t < cutoff)
            i += 1;
        if (i > 0)
            buf.splice(0, i);
        // 2) bound total count to maxPoints
        if (buf.length > maxPoints)
            buf.splice(0, buf.length - maxPoints);
    }
}
/**
 * Aggregates lightweight header numbers from the store and the next snapshot.
 * Observed frequency is computed from the wall-clock span the store has been
 * seeing accepted snapshots, which deliberately excludes dropped/duplicate
 * packets so an offline browser does not silently report "0 Hz" — the
 * {@code accepted} counter is the truth.
 */
export function liveSnapshotStats(store) {
    const battery = (() => {
        const series = store.getBatteryHistory();
        for (let i = series.length - 1; i >= 0; i -= 1) {
            if (series[i].v != null)
                return series[i].v;
        }
        return null;
    })();
    const motors = store.getMotorNames();
    const channels = store.getChannelNames();
    const events = store.getEvents();
    const { first, last } = store.getAcceptedRangeMs();
    let hz = 0;
    if (first != null && last != null && last > first) {
        hz = (store.acceptedCount() * 1000) / Math.max(1, last - first);
    }
    return {
        accepted: store.acceptedCount(),
        battery,
        motorCount: motors.length,
        channelCount: channels.length,
        eventCount: events.length,
        observedHz: hz,
    };
}
/**
 * Round-trips a value through JSON and then HTML-escapes the
 * unsafe characters ({@code <}, {@code >}, {@code &}, {@code "},
 * apostrophe) so the consumer can safely render it via
 * {@code textContent}.  This prevents "<script>" / "</script>" /
 * '<img onerror=…>' from reaching the DOM as live HTML even if a
 * caller mistakenly uses innerHTML.
 *
 * <p>The output is pure ASCII for inputs that contain only ASCII;
 * non-ASCII codepoints are passed through verbatim (which is safe for
 * textContent rendering).
 */
export function safeText(v) {
    if (v == null)
        return '';
    let s;
    try {
        // JSON.stringify escapes \u2028, \u2029, quotes, backslashes, and control
        // chars; surrounding quotes are dropped.
        s = JSON.stringify(v).replace(/^"|"$/g, '');
    }
    catch {
        s = String(v);
    }
    // Belt-and-braces: also replace the unsafe HTML characters with
    // their unicode-escaped forms so even a CSS-rule or attribute
    // boundary cannot be re-interpreted as live HTML.
    return s
        .replace(/&/g, '\\u0026')
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/"/g, '\\u0022')
        .replace(/'/g, '\\u0027');
}
/**
 * Test-only / debug seam: returns the bounded poller URL.
 */
export function defaultLiveUrl() { return '/runhealth/api/live/snapshot'; }
//# sourceMappingURL=live.js.map