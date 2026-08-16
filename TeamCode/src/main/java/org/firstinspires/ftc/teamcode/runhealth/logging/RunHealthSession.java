/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.hardware.DcMotor;
import com.qualcomm.robotcore.hardware.DcMotorEx;
import com.qualcomm.robotcore.hardware.HardwareMap;
import com.qualcomm.robotcore.util.ElapsedTime;
import com.qualcomm.robotcore.util.RobotLog;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Public entry point for read-only motor performance logging.
 *
 * <p>Two static factories create a session:
 * <ul>
 *     <li>{@link #start(HardwareMap, Object)} which may return a no-op
 *         instance if Recording is currently OFF.</li>
 *     <li>{@link #start(HardwareMap, Object, boolean)} which lets the caller
 *         force recording on regardless of the persisted mode (used by
 *         unit tests).</li>
 * </ul>
 *
 * <p>A session is bound to exactly one OpMode and consumes the record-mode
 * "NEXT" claim atomically (if present).
 *
 * <h2>Read-only contract</h2>
 *
 * This class MUST NOT write to any device, sensor, motor, hub, or OpMode
 * state.  Only reads of {@code getPower()}, {@code getVelocity()},
 * {@code getCurrent(CurrentUnit)}, and
 * {@code getMode()} are permitted.  This class does not call any setter on
 * {@code DcMotorEx}.
 *
 * <h2>Safety properties</h2>
 *
 * <ul>
 *     <li>{@link #capture()} never throws.  Any failure is logged and
 *         swallowed; the OpMode keeps running.</li>
 *     <li>A failure on one motor does not stop sampling of other motors.</li>
 *     <li>Sample rate is limited to at most one capture every
 *         {@link #MIN_CAPTURE_INTERVAL_MS} milliseconds.</li>
 *     <li>Sample count is capped per motor at {@link #MAX_SAMPLES_PER_MOTOR}
 *         to bound memory; further samples are dropped, the run is flagged
 *         {@code truncated=true}, and the partial buffer is still saved.</li>
 *     <li>No file I/O occurs during {@link #capture()}; CSV is written once
 *         on {@link #finish()}.</li>
 *     <li>If no samples were captured (Recording OFF, motorless config,
 *         or instant cancellation), no file is written.</li>
 *     <li>{@link #finish()} is idempotent; a second call is a no-op.</li>
 *     <li>If the process is killed before {@link #finish()} completes, the
 *         current run is lost (no partial files are written).</li>
 * </ul>
 */
public final class RunHealthSession implements AutoCloseable {

    public static final long MIN_CAPTURE_INTERVAL_MS = 100;     // 10 Hz cap
    public static final int MAX_SAMPLES_PER_MOTOR = 5400;       // ~9 minutes at 10 Hz

    private static final String TAG = "RunHealthSession";

    private final HardwareMap hardwareMap;
    private final String opmodeName;
    /** Caller-provided name fallback. Empty by default. */
    private final java.util.Map<DcMotorEx, String> providedNames;
    private final String runId;
    private final String runStartedAt; // ISO-8601 UTC
    private final List<DcMotorEx> motors;
    private final List<int[]> motorCounts;        // parallel to motors
    private final boolean forcedRecord;
    private final RunStorage storage;

    private ElapsedTime runClock;             // allocated only when recording.
    private final Object lock = new Object();

    private long lastCaptureAtMs = 0;
    private Double latestLoopTimeMs = null;
    // Volatile so concurrent observers (rare but possible in some driver
    // stations) see consistent state across reads.
    private volatile boolean truncated = false;
    private volatile boolean finished = false;
    /** True once we have consumed the persisted NEXT claim. */
    private volatile boolean consumedNext = false;
    /** True if the channel buffer dropped data due to cap (separate from motor cap). */
    private volatile boolean truncatedChannels = false;
    /**
     * Set to true after the very first successful capture. If the OpMode is
     * initialized and canceled before this happens, the claim is held and
     * {@link #finish()} will release it so a subsequent OpMode can claim.
     */
    private volatile boolean armedAndUnconsumed = false;

    /* ---------------- v2 custom-channel buffers ----------------
     *
     * The session also accepts typed custom telemetry via
     *   put(name, double), putBoolean, putText, putPose, mark(String)
     * and channel declarations via defineChannel(spec).
     *
     * Two-tier buffering pattern:
     *   - latestValuesByName: the most-recent staged value for each channel.
     *     put() overwrites here.  capture() flushes these into committedSamples.
     *   - committedSamples: the durable record that finish() will serialise
     *     to channels.csv.  Includes every channel sample and every mark().
     *
     * Event markers (mark()) bypass the rate limit by writing directly into
     * committedSamples so a user-triggered event is preserved with the
     * exact tap-time timestamp.
     */
    private final java.util.Map<String, ChannelSample> latestValuesByName = new java.util.HashMap<>();
    private final java.util.List<ChannelSample> committedSamples = new java.util.ArrayList<>();
    private final ChannelRegistry channelRegistry = new ChannelRegistry();
    private int channelSamplesCap = 5400;
    private boolean channelsFlushedAtLeastOnce = false;

    private RunHealthSession(HardwareMap hardwareMap,
                             Object opmodeContextOrName,
                             java.util.Map<DcMotorEx, String> providedNames,
                             boolean forcedRecord,
                             RunStorage storage,
                             boolean armedNext,
                             boolean recordingOn) {
        if (!recordingOn) {
            // No-op session; spec §6 says "no meaningful memory or CPU work
            // occurs".  Skip allocation of ElapsedTime/buffer/storage fields.
            this.hardwareMap = null;
            this.providedNames = java.util.Collections.emptyMap();
            this.opmodeName = opmodeName(opmodeContextOrName);
            this.motors = java.util.Collections.emptyList();
            this.motorCounts = java.util.Collections.emptyList();
            this.forcedRecord = false;
            this.storage = null;
            this.runId = "";
            this.runStartedAt = "";
            // Initialise only the fields needed for finish()/runId() in the
            // no-op branch.  The locks/flags default to false/0.
            return;
        }
        this.hardwareMap = hardwareMap;
        this.providedNames = providedNames == null
                ? java.util.Collections.<DcMotorEx, String>emptyMap()
                : providedNames;
        this.forcedRecord = forcedRecord;
        this.storage = storage;
        this.armedAndUnconsumed = armedNext;
        this.runId = RunId.newId();
        this.runStartedAt = formatUtcIso(new Date());
        this.opmodeName = opmodeName(opmodeContextOrName);

        this.motors = discoverMotors(hardwareMap, this.providedNames);
        this.motorCounts = new ArrayList<>(motors.size());
        for (int i = 0; i < motors.size(); i++) motorCounts.add(new int[]{0});
        this.runClock = new ElapsedTime(ElapsedTime.Resolution.MILLISECONDS);

        RobotLog.ii(TAG, "Session created: runId=" + runId
                + " opmode=" + opmodeName
                + " motors=" + motors.size()
                + " armedNext=" + armedNext
                + " forced=" + forcedRecord);
    }

    /**
     * Begin a session if Recording mode permits it.  If mode is OFF, returns
     * a no-op session whose {@link #capture()} does nothing.  If mode is
     * NEXT or EVERY, the session is "armed" but the NEXT claim is not
     * consumed until the first successful {@link #capture()}.  This means
     * that if the OpMode is initialized and canceled before producing a
     * sample, NEXT remains armed for the next eligible OpMode.
     *
     * <p>The caller must pass either the OpMode instance or the simple
     * class name to use as the recorded name.  Passing the OpMode itself
     * is preferred.
     *
     * <p>{@code motorNames} is an optional map from {@link DcMotorEx}
     * instance to the user's chosen configuration name.  The FTC SDK does
     * not expose a reverse-lookup on a motor instance, so explicit names
     * are the only reliable source.  When omitted, sessions still record
     * samples but with {@code device_name="unknown"}; the comparison UI
     * will not match these runs against each other.
     */
    public static RunHealthSession start(HardwareMap hardwareMap,
                                          Object opmodeContextOrName,
                                          java.util.Map<DcMotorEx, String> motorNames) {
        return start(hardwareMap, opmodeContextOrName, motorNames, false, new RunStorage());
    }

    /**
     * Backward-compatible overload without motor names.  Equivalent to
     * {@code start(hwm, name, null, false, new RunStorage())}.
     */
    public static RunHealthSession start(HardwareMap hardwareMap, Object opmodeContextOrName) {
        return start(hardwareMap, opmodeContextOrName, null);
    }

    /** Test-friendly overload accepting a custom storage implementation. */
    public static RunHealthSession start(HardwareMap hardwareMap,
                                          Object opmodeContextOrName,
                                          java.util.Map<DcMotorEx, String> motorNames,
                                          boolean forceRecord,
                                          RunStorage storage) {
        if (hardwareMap == null) {
            return createNoop(opmodeContextOrName);
        }
        String opName = opmodeName(opmodeContextOrName);
        String mode = forceRecord ? RunHealthConfig.MODE_EVERY : RunHealthConfig.getRecordingMode();
        boolean armed = false;

        if (RunHealthConfig.MODE_OFF.equals(mode)) {
            return createNoop(opName);
        }
        if (RunHealthConfig.MODE_NEXT.equals(mode)) {
            // Arm NEXT; do not consume until the first capture(). Stable across
            // pre-start cancellations.
            armed = true;
        }
        return new RunHealthSession(
                hardwareMap, opName, motorNames, forceRecord, storage, armed, true);
    }

    /**
     * Creates a no-op session used when Recording is OFF or the NEXT claim
     * was lost.  {@link #capture()} and {@link #finish()} are still safe to
     * call and are no-ops.
     */
    private static RunHealthSession createNoop(Object name) {
        return new RunHealthSession(
                null, opmodeName(name), null, false, null, false, false);
    }

    /**
     * Records one sample for every discovered motor, at the configured rate.
     *
     * <p>Returns {@code true} if any sample was actually written to the
     * in-memory buffer; {@code false} if this call was throttled or skipped
     * for safety reasons.
     *
     * <p>Never throws.  All errors are caught and logged.
     */
    public boolean capture() {
        // Spec §2 + §7 require capture() to NEVER throw to the caller's
        // control loop.  We wrap the entire body in try/catch(Throwable) so
        // any unexpected failure (memory, threading, SDK regression) is
        // logged and swallowed.
        try {
            synchronized (lock) {
                if (finished) return false;
                if (hardwareMap == null || motors.isEmpty()) return false;

                // Atomically consume the NEXT claim on the first sample we accept.
                if (armedAndUnconsumed) {
                    boolean ok = false;
                    try {
                        ok = RunHealthConfig.compareAndSetMode(
                                RunHealthConfig.MODE_NEXT, RunHealthConfig.MODE_OFF);
                    } catch (Throwable t) {
                        RobotLog.ww(TAG, "NEXT consume failed (claim lost): " + t.getMessage());
                    }
                    armedAndUnconsumed = false;
                    consumedNext = ok;
                    if (!ok) {
                        RobotLog.vv(TAG, "NEXT claim lost before first capture; recording anyway because armed");
                    } else {
                        RobotLog.ii(TAG, "NEXT claim consumed on first sample");
                    }
                }

                long now = (long) runClock.milliseconds();
                if (lastCaptureAtMs != 0 && now - lastCaptureAtMs < MIN_CAPTURE_INTERVAL_MS) {
                    return false; // rate-limited
                }
                if (lastCaptureAtMs != 0) {
                    latestLoopTimeMs = Double.valueOf(now - lastCaptureAtMs);
                }
                lastCaptureAtMs = now;

                Double batteryV = BatteryVoltageReader.read(hardwareMap);
                boolean anyMotorCapReached = false;

                for (int i = 0; i < motors.size(); i++) {
                    DcMotorEx m = motors.get(i);
                    int[] counter = motorCounts.get(i);
                    if (counter[0] >= MAX_SAMPLES_PER_MOTOR) {
                        anyMotorCapReached = true;
                        continue;
                    }
                    MotorSample row = readOneMotor(m, now, batteryV);
                    if (row != null) {
                        bufferAdd(row);
                        counter[0]++;
                    }
                }

                if (anyMotorCapReached && !truncated) {
                    truncated = true;
                    RobotLog.ww(TAG, "Sample cap reached; subsequent captures will be skipped");
                }

                // Flush staged custom-channel values into the durable record.
                // Done under the same lock+throttle cadence so channels share
                // the documented 10 Hz cap; mark() bypasses this and writes
                // immediately.
                if (!latestValuesByName.isEmpty()) {
                    java.util.Iterator<java.util.Map.Entry<String, ChannelSample>> it =
                            latestValuesByName.entrySet().iterator();
                    while (it.hasNext()) {
                        java.util.Map.Entry<String, ChannelSample> e = it.next();
                        if (committedSamples.size() >= channelSamplesCap) {
                            truncated = true;
                            truncatedChannels = true;
                            break;
                        }
                        committedSamples.add(e.getValue());
                        it.remove();
                    }
                    if (!committedSamples.isEmpty()) channelsFlushedAtLeastOnce = true;
                }
                // Publish the latest bounded live snapshot.  This is O(1)
                // for the reader (volatile assignment of an immutable
                // POJO) and never throws even under pathological input —
                // the read-only API endpoint simply returns the previous
                // snapshot if this publish fails.
                try {
                    publishLiveSnapshot();
                } catch (Throwable tIgnored) {
                    RobotLog.vv(TAG, "live publish skipped: " + tIgnored.getMessage());
                }
                return true;
            }
        } catch (Throwable t) {
            RobotLog.ee(TAG, t, "Unexpected error in capture(); swallowing to keep OpMode alive");
            return false;
        }
    }

    /**
     * Closes the session and writes the CSV file (if any samples were
     * captured).  Idempotent.
     *
     * <p>If we armed NEXT but never produced a sample (OpMode canceled in
     * the init phase), the next claim remains held and can be consumed by
     * the next eligible OpMode that successfully captures.
     */
    public void finish() {
        synchronized (lock) {
            if (finished) return;
            finished = true;

            // If the OpMode never produced its first sample, release the NEXT
            // claim so the next call may still claim it.
            if (armedAndUnconsumed) {
                RobotLog.ii(TAG, "NEXT claim released (no first sample produced)");
                armedAndUnconsumed = false;
            }

            if (storage == null) {
                RobotLog.vv(TAG, "No-op session finished; no file written");
                markLiveInactive();
                return;
            }
            int total = totalSamples();
            if (total == 0 && committedSamples.isEmpty()) {
                RobotLog.ii(TAG, "No samples captured; no file written for opmode=" + opmodeName);
                markLiveInactive();
                return;
            }

            String utcTs = runStartedAt;            // ISO-8601 already
            String safeTs = utcTs.replace(':', '-');
            String opSeg = truncated
                    ? org.firstinspires.ftc.teamcode.runhealth.logging.FilenameSanitizer
                            .sanitizeSegment(opmodeName) + "-truncated"
                    : org.firstinspires.ftc.teamcode.runhealth.logging.FilenameSanitizer
                            .sanitizeSegment(opmodeName);
            long durationMs = runClock != null ? (long) runClock.milliseconds() : 0L;

            try {
                if (total == 0) {
                    // Channel-only run: we deliberately do NOT write an empty
                    // v1 motor CSV (v1 parsers treat header-only as No-samples
                    // error).  The run is discoverable through its manifest
                    // and channels companion files instead.
                    RobotLog.ii(TAG, "Channel-only run; skipping motor CSV for opmode=" + opmodeName
                            + " channels=" + committedSamples.size());
                } else {
                    StringBuilder sb = new StringBuilder(64 + total * 64);
                    sb.append(RunHealthCsv.headerRow()).append('\n');
                    for (MotorSample row : snapshotBuffer()) {
                        sb.append(row.toCsvRow()).append('\n');
                    }
                    // Append a metadata footer line: still within the schema,
                    // with all numeric fields blank and run_id == our id, so
                    // the parser's strict column validator can still recognise it.
                    if (truncated) {
                        sb.append(truncatedMarkerRow()).append('\n');
                    }
                    java.io.File out = storage.writeRun(safeTs, opSeg, runId, sb.toString());
                    RobotLog.ii(TAG, "Run written: " + out.getAbsolutePath()
                            + " samples=" + total
                            + " truncated=" + truncated);
                }

                // ---------------- v2 companion files -----------------
                if (!committedSamples.isEmpty()) {
                    StringBuilder cb = new StringBuilder(64 + committedSamples.size() * 96);
                    cb.append(ChannelsCsv.headerRow()).append('\n');
                    // Sorted by (timestamp_ms, channel_name) for stable diffs in tests.
                    java.util.List<ChannelSample> sorted = new java.util.ArrayList<>(committedSamples);
                    sorted.sort((a, b) -> {
                        int c = Long.compare(a.timestampMs, b.timestampMs);
                        if (c != 0) return c;
                        return a.channelName.compareTo(b.channelName);
                    });
                    for (ChannelSample s : sorted) {
                        cb.append(s.toCsvRow()).append('\n');
                    }
                    String stem = FilenameSanitizer.buildCsvFilename(safeTs, opSeg, runId);
                    String motorsStem = stem;
                    String channelsStem = stem.substring(0, stem.length() - 4) + ".channels.csv";
                    java.io.File chOut = storage.writeCompanion(channelsStem, cb.toString());
                    RobotLog.ii(TAG, "Channels written: " + chOut.getAbsolutePath()
                            + " samples=" + committedSamples.size());

                    // Build the manifest
                    java.util.List<String> deviceNames = deviceNamesSnapshot();
                    String buildId = System.getProperty("runhealth.build_id", "");
                    RunManifest.Builder mb = RunManifest.builder()
                            .runId(runId)
                            .opmodeName(opmodeName)
                            .runStartedAt(runStartedAt)
                            .durationMs(durationMs)
                            .buildIdentifier(buildId)
                            .configFingerprint(fingerprintOf(deviceNames))
                            .deviceNames(deviceNames)
                            .truncated(truncated)
                            .motorsFile(motorsStem)
                            .channelsFile(channelsStem);
                    for (ChannelSpec spec : channelRegistry.snapshot()) {
                        mb.addChannel(spec);
                    }
                    RunManifest mf = mb.build();
                    String manifestStem = stem.substring(0, stem.length() - 4) + ".manifest.json";
                    java.io.File mfOut = storage.writeCompanion(manifestStem, mf.toJson());
                    RobotLog.ii(TAG, "Manifest written: " + mfOut.getAbsolutePath());
                }
            } catch (Throwable t) {
                RobotLog.ee(TAG, t, "Failed to persist Run Health CSV");
            } finally {
                // The browser treats active -> inactive as the completion
                // signal. Publish it only after all run files are visible.
                markLiveInactive();
            }
        }
    }

    private static void markLiveInactive() {
        try {
            LiveSnapshotRegistry.getInstance().markInactive();
        } catch (Throwable ignored) {
            // Diagnostics must never interfere with OpMode shutdown.
        }
    }

    private java.util.List<String> deviceNamesSnapshot() {
        java.util.List<String> out = new java.util.ArrayList<>();
        try {
            for (DcMotorEx m : motors) {
                String name = providedNames.get(m);
                if (name == null || name.isEmpty()) continue;
                if (!out.contains(name)) out.add(name);
            }
        } catch (Throwable t) { /* swallow */ }
        java.util.Collections.sort(out);
        return out;
    }

    /** Stable, low-cost fingerprint over sorted device names. */
    private static String fingerprintOf(java.util.List<String> deviceNames) {
        if (deviceNames == null || deviceNames.isEmpty()) return "empty";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < deviceNames.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(deviceNames.get(i));
        }
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                hex.append(String.format(java.util.Locale.US, "%02x", b & 0xff));
            }
            return hex.toString();
        } catch (Throwable t) {
            // SHA-256 always present on Android API 24+, but defensive.
            return Integer.toHexString(sb.toString().hashCode());
        }
    }

    /**
     * Returns the meta footer row that flags truncation.  All numeric
     * columns are blank; the {@code device_name} field carries the literal
     * tag {@code __RUN_HEALTH_TRUNCATED__} and {@code motor_mode} carries
     * the cursor index so the parser can attribute the row to a specific
     * run.  The {@code commanded_power} column carries the literal text
     * {@code TRUNCATED=N} (sample count captured) — ASCII only, no format
     * numeric risk.
     */
    private String truncatedMarkerRow() {
        Object[] values = new Object[RunHealthCsv.COLUMNS.length];
        values[0] = RunHealthCsv.SCHEMA_VERSION;
        values[1] = runId;
        values[2] = opmodeName;
        values[3] = runStartedAt;
        values[4] = Long.valueOf((long) runClock.milliseconds());
        values[5] = "__RUN_HEALTH_TRUNCATED__";
        values[6] = "TRUNCATED=" + totalSamples();         // ASCII literal in numeric slot
        values[7] = null;
        values[8] = null;
        values[9] = null;
        values[10] = null;                                  // motor_mode left blank
        values[11] = null;
        return RunHealthCsv.joinRow(values);
    }

    /** Same as {@link #finish()}; for try-with-resources. */
    @Override public void close() { finish(); }

    /** Returns the run ID assigned at {@link #start}. Empty for no-op sessions. */
    public String runId() {
        if (hardwareMap == null) return "";
        return runId;
    }

    /** Returns true if Recording did record samples and produced a file (best-effort). */
    public boolean isRecording() {
        return hardwareMap != null;
    }

    /** True if the run was truncated due to the per-motor sample cap. */
    public boolean wasTruncated() {
        return truncated;
    }

    // -------------------------------------------------------------- live snapshot

    /**
     * Builds and publishes a {@link LiveSnapshot} representing the most
     * recent sampled state.  Called from {@link #capture()} inside the
     * session lock so readers cannot observe a half-stage state.  Never
     * throws to the caller; all failures are swallowed and logged.
     */
    private void publishLiveSnapshot() {
        if (hardwareMap == null) return; // no-op session: do not pollute the registry
        LiveSnapshotRegistry reg = LiveSnapshotRegistry.getInstance();
        long now = (long) (runClock != null ? runClock.milliseconds() : 0L);
        LiveSnapshot.Factory f = new LiveSnapshot.Factory();
        f.active(true)
                .sessionId(runId)
                .opMode(opmodeName)
                .recordingMode(org.firstinspires.ftc.teamcode.runhealth.logging.RunHealthConfig.getRecordingMode())
                .sequence(reg.currentSequence() + 1L)
                .timestampMs(System.currentTimeMillis())
                .elapsedMs(now)
                .loopTimeMs(latestLoopTimeMs);

        // Battery voltage — read this tick via BatteryVoltageReader.
        Double battV = null;
        try { battV = BatteryVoltageReader.read(hardwareMap); } catch (Throwable ignored) { battV = null; }
        if (battV != null && Double.isFinite(battV)) f.batteryVoltage(battV);
        else f.batteryVoltage(null);

        // Motors — read once per motor, emit a MotorView with nulls for
        // fields the SDK did not expose.  Never coercive: if a motor is
        // disconnected, the corresponding MotorView fields are null.
        for (int i = 0; i < motors.size(); i++) {
            DcMotorEx m = motors.get(i);
            String name = providedNames.get(m);
            if (name == null || name.isEmpty()) name = "unknown";
            Double power = null;
            Double velocity = null;
            Double amps = null;
            String mode = null;
            try {
                double p = m.getPower();
                if (Double.isFinite(p)) power = p;
            } catch (Throwable ignored) { /* null */ }
            try {
                double v = m.getVelocity();
                if (Double.isFinite(v)) velocity = v;
            } catch (Throwable ignored) { /* null */ }
            try {
                // Use the reflection-based helper so we compile against SDK
                // builds that may not expose the modern CurrentUnit class.
                Double a = readMotorCurrentAmps(m);
                if (a != null && Double.isFinite(a)) amps = a;
            } catch (Throwable ignored) { /* null */ }
            try {
                com.qualcomm.robotcore.hardware.DcMotor.RunMode mm = m.getMode();
                if (mm != null) mode = mm.toString();
            } catch (Throwable ignored) { /* null */ }
            f.addMotor(new LiveSnapshot.MotorView(name, power, velocity, amps, mode));
        }

        // Channels — emit the latest staged value per channel name so the
        // browser sees numbers / booleans / text / pose in one snapshot.
        try {
            for (java.util.Map.Entry<String, ChannelSample> e : latestValuesByName.entrySet()) {
                ChannelSample s = e.getValue();
                String kindStr;
                switch (s.type) {
                    case NUMBER: kindStr = "number"; break;
                    case BOOLEAN: kindStr = "boolean"; break;
                    case TEXT: kindStr = "text"; break;
                    case POSE: kindStr = "pose"; break;
                    case EVENT: kindStr = "event"; break;
                    default: kindStr = "number";
                }
                ChannelSpec spec = channelRegistry.get(e.getKey());
                String unit = spec == null ? null : spec.unit;
                String group = spec == null ? null : spec.group;
                String desc = spec == null ? null : spec.description;
                f.addChannel(new LiveSnapshot.ChannelView(
                        s.channelName, kindStr,
                        s.valueNumber, s.valueBoolean, s.valueText,
                        s.valueX, s.valueY, s.valueHeading,
                        unit, group, desc));
            }
        } catch (Throwable ignored) { /* swallow */ }

        // Surface up to 4 most-recent event markers (committedSamples
        // whose kind is EVENT) so the browser can render them on graphs
        // and the field timeline.  Bounded count keeps the snapshot small.
        try {
            int n = committedSamples.size();
            int from = Math.max(0, n - 4);
            for (int i = from; i < n; i++) {
                ChannelSample s = committedSamples.get(i);
                if (s == null || s.type != ChannelType.EVENT) continue;
                String label = s.valueText != null ? s.valueText : "";
                if (label.isEmpty() && s.note != null) label = s.note;
                f.addEvent(new LiveSnapshot.EventView(s.timestampMs, label));
            }
        } catch (Throwable ignored) { /* swallow */ }

        reg.publish(f.build());
    }

    // -------------------------------------------------------------- v2 API

    /**
     * Declares a custom channel and its metadata.  Idempotent: redeclaring a
     * channel with the same name and {@link ChannelType} refines the
     * metadata in place if it was empty before; divergent declarations
     * (same name, different type) are rejected silently.
     *
     * <p>Defining a channel is optional.  Teams that call {@link #put} or
     * {@link #mark} without first calling {@code defineChannel} still get
     * their samples recorded — the channel appears with default metadata
     * ("unknown" group, no unit, no description).
     *
     * @return {@code true} when the registration succeeded; {@code false}
     *         on validation failure, channel cap, or conflicting redefinition.
     */
    public boolean defineChannel(ChannelSpec spec) {
        if (hardwareMap == null) return false;
        if (spec == null) return false;
        try {
            return channelRegistry.define(spec);
        } catch (Throwable t) {
            RobotLog.ww(TAG, "defineChannel rejected: " + t.getMessage());
            return false;
        }
    }

    /** Numeric channel.  Overwrites any prior staged value with the same name. */
    public void put(String name, double value) {
        if (hardwareMap == null) return;
        if (name == null) return;
        try {
            String key = ChannelSpec.validateName(name.trim());
            if (!Double.isFinite(value)) return;
            double nowMs = runClock != null ? (long) runClock.milliseconds() : 0L;
            ChannelSample sample = new ChannelSample(
                    (long) nowMs, key, ChannelType.NUMBER,
                    Double.valueOf(value), null, null,
                    null, null, null, null);
            synchronized (lock) {
                latestValuesByName.put(ChannelSpec.keyFor(key), sample);
            }
        } catch (Throwable t) {
            RobotLog.vv(TAG, "put " + name + " rejected: " + t.getMessage());
        }
    }

    /** Boolean channel.  Overwrites the previous staged value. */
    public void putBoolean(String name, boolean value) {
        if (hardwareMap == null) return;
        if (name == null) return;
        try {
            String key = ChannelSpec.validateName(name.trim());
            double nowMs = runClock != null ? (long) runClock.milliseconds() : 0L;
            ChannelSample sample = new ChannelSample(
                    (long) nowMs, key, ChannelType.BOOLEAN,
                    null, Boolean.valueOf(value), null,
                    null, null, null, null);
            synchronized (lock) {
                latestValuesByName.put(ChannelSpec.keyFor(key), sample);
            }
        } catch (Throwable t) {
            RobotLog.vv(TAG, "putBoolean " + name + " rejected: " + t.getMessage());
        }
    }

    /** Text channel.  Strings longer than {@link ChannelsCsv#MAX_TEXT_VALUE}
     *  are truncated.  Overwrites the previous staged value. */
    public void putText(String name, String value) {
        if (hardwareMap == null) return;
        if (name == null) return;
        try {
            String key = ChannelSpec.validateName(name.trim());
            double nowMs = runClock != null ? (long) runClock.milliseconds() : 0L;
            ChannelSample sample = new ChannelSample(
                    (long) nowMs, key, ChannelType.TEXT,
                    null, null, clamp(value, ChannelsCsv.MAX_TEXT_VALUE),
                    null, null, null, null);
            synchronized (lock) {
                latestValuesByName.put(ChannelSpec.keyFor(key), sample);
            }
        } catch (Throwable t) {
            RobotLog.vv(TAG, "putText " + name + " rejected: " + t.getMessage());
        }
    }

    /** Robot pose channel.  Each coordinate must be finite; non-finite values
     *  are dropped silently, leaving the previous valid pose in place. */
    public void putPose(String name, double x, double y, double headingRadians) {
        if (hardwareMap == null) return;
        if (name == null) return;
        try {
            String key = ChannelSpec.validateName(name.trim());
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(headingRadians)) {
                return;
            }
            double nowMs = runClock != null ? (long) runClock.milliseconds() : 0L;
            ChannelSample sample = new ChannelSample(
                    (long) nowMs, key, ChannelType.POSE,
                    null, null, null,
                    Double.valueOf(x), Double.valueOf(y),
                    Double.valueOf(headingRadians), null);
            synchronized (lock) {
                latestValuesByName.put(ChannelSpec.keyFor(key), sample);
            }
        } catch (Throwable t) {
            RobotLog.vv(TAG, "putPose " + name + " rejected: " + t.getMessage());
        }
    }

    /**
     * Records a single event marker.  Unlike {@link #put}, this writes
     * immediately to the durable channel buffer, bypassing the
     * 10 Hz throttle - so a user-noted event lands in the run with the
     * timestamp at the moment the user called {@code mark(...)}.
     *
     * <p>A blank note is still recorded (the timestamp alone is useful
     * for replay-synchronisation purposes).  The browser-side UI may
     * render blank notes as a neutral marker.
     *
     * <p>The writer (ChannelsCsv.sampleRow) canonicalises every EVENT row
     * to {@link ChannelsCsv#EVENT_CHANNEL_NAME} regardless of the channel
     * name passed in here, so this method is free to pass any non-empty
     * marker name and the wire contract remains stable.
     *
     * <p>The in-memory ChannelSample carries the placeholder name passed
     * by {@code mark()}; the canonical {@code __event__} wire name is
     * computed by ChannelsCsv.sampleRow at write time.  Introspection
     * sites that inspect ChannelSample before CSV serialisation will see
     * the placeholder, not the canonical wire name.
     */
    public void mark(String note) {
        if (hardwareMap == null) return;
        try {
            double nowMs = runClock != null ? (long) runClock.milliseconds() : 0L;
            String clamped = clamp(note, ChannelsCsv.MAX_NOTE_VALUE);
            ChannelSample sample = new ChannelSample(
                    (long) nowMs, "event", ChannelType.EVENT,
                    null, null, clamped,
                    null, null, null, clamped);
            synchronized (lock) {
                if (committedSamples.size() < channelSamplesCap) {
                    committedSamples.add(sample);
                    channelsFlushedAtLeastOnce = true;
                } else {
                    truncated = true;
                    truncatedChannels = true;
                }
            }
        } catch (Throwable t) {
            RobotLog.vv(TAG, "mark rejected: " + t.getMessage());
        }
    }

    /** True if any custom-channel sample was committed in this session. */
    public boolean hasChannels() {
        if (hardwareMap == null) return false;
        synchronized (lock) {
            return channelsFlushedAtLeastOnce || !committedSamples.isEmpty()
                    || !latestValuesByName.isEmpty();
        }
    }

    /** Returns a snapshot of the currently registered channel definitions.
     *  The order is preserved: insertion order from the first
     *  {@link #defineChannel} call. */
    public java.util.List<ChannelSpec> definedChannels() {
        if (hardwareMap == null) return java.util.Collections.emptyList();
        return channelRegistry.snapshot();
    }

    private static String clamp(String s, int max) {
        if (s == null) return "";
        if (s.length() <= max) return s;
        return s.substring(0, max);
    }

    // -------------------------------------------------------------- internals

    private final CopyOnWriteArrayList<MotorSample> buffer = new CopyOnWriteArrayList<>();

    private void bufferAdd(MotorSample s) {
        // CopyOnWriteArrayList is sufficient for our size; no contention hot path.
        buffer.add(s);
    }

    private List<MotorSample> snapshotBuffer() {
        // Defensive copy; COWList iter is safe but we make it explicit so
        // downstream code may iterate without surprises.
        List<MotorSample> out = new ArrayList<>(buffer.size());
        for (MotorSample s : buffer) out.add(s);
        return out;
    }

    private int totalSamples() { return buffer.size(); }

    private static List<DcMotorEx> discoverMotors(
            HardwareMap hardwareMap,
            java.util.Map<DcMotorEx, String> providedNames) {
        List<DcMotorEx> out = new ArrayList<>();
        if (providedNames != null && !providedNames.isEmpty()) {
            java.util.List<java.util.Map.Entry<DcMotorEx, String>> named =
                    new java.util.ArrayList<>(providedNames.entrySet());
            java.util.Collections.sort(named,
                    new java.util.Comparator<java.util.Map.Entry<DcMotorEx, String>>() {
                        @Override public int compare(
                                java.util.Map.Entry<DcMotorEx, String> a,
                                java.util.Map.Entry<DcMotorEx, String> b) {
                            String an = a.getValue() == null ? "" : a.getValue();
                            String bn = b.getValue() == null ? "" : b.getValue();
                            return an.compareToIgnoreCase(bn);
                        }
                    });
            for (java.util.Map.Entry<DcMotorEx, String> entry : named) {
                if (entry.getKey() != null) out.add(entry.getKey());
            }
            return out;
        }
        try {
            for (DcMotorEx ex : hardwareMap.getAll(DcMotorEx.class)) {
                if (ex == null) continue;
                out.add(ex);
            }
        } catch (Throwable t) {
            RobotLog.ww(TAG, "Motor discovery failed: " + t.getMessage());
        }
        return out;
    }

    private MotorSample readOneMotor(DcMotorEx motor, long tMs, Double batteryV) {
        try {
            String name;
            try {
                name = providedNames.get(motor);
                if (name == null || name.isEmpty()) {
                    name = ""; // documented: missing names render as blank
                }
            } catch (Throwable t) { name = ""; }

            Double power;
            try { power = motor.getPower(); }
            catch (Throwable t) { power = null; }

            Double vel;
            try { vel = motor.getVelocity(); }
            catch (Throwable t) { vel = null; }

            Double current;
            try { current = readMotorCurrentAmps(motor); }
            catch (Throwable t) { current = null; }

            String modeStr;
            try {
                DcMotor.RunMode mode = motor.getMode();
                if (mode == null) {
                    modeStr = null;
                } else {
                    String s = mode.name();
                    // FTC SDK RunMode enums include extra descriptor text in some
                    // versions; truncate to the documented suffix.
                    modeStr = s.toUpperCase(Locale.US);
                }
            } catch (Throwable t) {
                modeStr = null;
            }

            return new MotorSample(
                    runId, opmodeName, runStartedAt, tMs, name,
                    power, null, vel, current, modeStr, batteryV);
        } catch (Throwable t) {
            RobotLog.ww(TAG, "readOneMotor failed: " + t.getMessage());
            return null;
        }
    }

    // Replaced by providedNames lookup in readOneMotor().


    /**
     * Reads motor current in amps using whatever API the locally linked
     * FTC SDK exposes.  Tries the modern {@code getCurrent(CurrentUnit.AMPS)}
     * via reflection first; falls back to no-args {@code getCurrent()}; in
     * either case returns {@code null} on any failure.  Never throws.
     *
     * <p>This indirection exists because some local SDK builds do not expose
     * {@code com.qualcomm.robotcore.hardware.CurrentUnit}.  The reflection
     * guard makes the logger compile and run against multiple SDK versions.
     */
    static Double readMotorCurrentAmps(DcMotorEx motor) {
        if (motor == null) return null;
        // CurrentUnit lives in external.navigation in current FTC SDKs.
        // Keep the older candidate for compatibility with vendor forks.
        for (String className : new String[]{
                "org.firstinspires.ftc.robotcore.external.navigation.CurrentUnit",
                "com.qualcomm.robotcore.hardware.CurrentUnit"}) {
            try {
                Class<?> cu = Class.forName(className);
                Object amps = cu.getField("AMPS").get(null);
                Object v = motor.getClass().getMethod("getCurrent", cu).invoke(motor, amps);
                if (v instanceof Number) {
                    double d = ((Number) v).doubleValue();
                    return Double.isFinite(d) ? d : null;
                }
            } catch (Throwable ignore) {
                // Try the next SDK shape.
            }
        }
        // Legacy path: getCurrent() no-args returning amps directly.
        try {
            Object v = motor.getClass().getMethod("getCurrent").invoke(motor);
            if (v instanceof Number) {
                double d = ((Number) v).doubleValue();
                return Double.isFinite(d) ? d : null;
            }
            return null;
        } catch (Throwable ignore) {
            return null;
        }
    }

    private static String opmodeName(Object ctx) {
        if (ctx == null) return "OpMode";
        if (ctx instanceof CharSequence) {
            String s = ((CharSequence) ctx).toString();
            return s.isEmpty() ? "OpMode" : s;
        }
        if (ctx instanceof LinearOpMode) {
            return ((LinearOpMode) ctx).getClass().getSimpleName();
        }
        if (ctx instanceof OpMode) {
            return ((OpMode) ctx).getClass().getSimpleName();
        }
        // Best-effort: use simple class name.
        return ctx.getClass().getSimpleName();
    }

    private static String formatUtcIso(Date d) {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(d);
    }
}
