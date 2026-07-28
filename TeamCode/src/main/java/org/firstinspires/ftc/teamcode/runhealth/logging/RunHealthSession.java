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
 * state.  Only reads of {@code getPower()}, {@code getCurrentPosition()},
 * {@code getVelocity()}, {@code getCurrent(CurrentUnit)}, and
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
    // Volatile so concurrent observers (rare but possible in some driver
    // stations) see consistent state across reads.
    private volatile boolean truncated = false;
    private volatile boolean finished = false;
    /** True once we have consumed the persisted NEXT claim. */
    private volatile boolean consumedNext = false;
    /**
     * Set to true after the very first successful capture. If the OpMode is
     * initialized and canceled before this happens, the claim is held and
     * {@link #finish()} will release it so a subsequent OpMode can claim.
     */
    private volatile boolean armedAndUnconsumed = false;

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

        this.motors = discoverMotors(hardwareMap);
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
                return;
            }
            int total = totalSamples();
            if (total == 0) {
                RobotLog.ii(TAG, "No samples captured; no file written for opmode=" + opmodeName);
                return;
            }

            try {
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
                String utcTs = runStartedAt;           // ISO-8601 already
                String safeTs = utcTs.replace(':', '-');
                String opSeg = truncated
                        ? org.firstinspires.ftc.teamcode.runhealth.logging.FilenameSanitizer
                                .sanitizeSegment(opmodeName) + "-truncated"
                        : org.firstinspires.ftc.teamcode.runhealth.logging.FilenameSanitizer
                                .sanitizeSegment(opmodeName);
                java.io.File out = storage.writeRun(safeTs, opSeg, runId, sb.toString());
                RobotLog.ii(TAG, "Run written: " + out.getAbsolutePath()
                        + " samples=" + total
                        + " truncated=" + truncated);
            } catch (Throwable t) {
                RobotLog.ee(TAG, t, "Failed to persist Run Health CSV");
            }
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

    private static List<DcMotorEx> discoverMotors(HardwareMap hardwareMap) {
        List<DcMotorEx> out = new ArrayList<>();
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

            Long pos;
            try {
                int p = motor.getCurrentPosition();
                pos = (long) p;
            } catch (Throwable t) { pos = null; }

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
                    power, pos, vel, current, modeStr, batteryV);
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
        // Modern path: getCurrent(CurrentUnit.AMPS)
        try {
            Class<?> cu = Class.forName("com.qualcomm.robotcore.hardware.CurrentUnit");
            Object amps = cu.getField("AMPS").get(null);
            Object v = motor.getClass().getMethod("getCurrent", cu).invoke(motor, amps);
            if (v instanceof Number) {
                double d = ((Number) v).doubleValue();
                return Double.isFinite(d) ? d : null;
            }
            return null;
        } catch (Throwable ignore) {
            // Fall through.
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
