/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

/**
 * Immutable representation of one row in the Run Health CSV file.
 *
 * <p>Each field is nullable, and {@code null} means "not measured" - rendered
 * as an empty CSV cell.  Run Health never silently substitutes zero for
 * missing values.
 *
 * <p>Floating-point fields are validated to be finite at construction;
 * non-finite values become blank (rejected to {@code null}) so that we never
 * persist {@code NaN}, {@code +Infinity} or {@code -Infinity} into a CSV.
 */
public final class MotorSample {

    public final String runId;
    public final String opmodeName;
    public final String runStartedAt;
    public final long timestampMs;
    public final String deviceName;

    public final Double commandedPower;       // [-1, 1] inclusive
    public final Long encoderPositionTicks;
    public final Double encoderVelocity;      // ticks / second
    public final Double currentAmps;
    public final String motorMode;
    public final Double batteryVoltage;

    public MotorSample(
            String runId,
            String opmodeName,
            String runStartedAt,
            long timestampMs,
            String deviceName,
            Double commandedPower,
            Long encoderPositionTicks,
            Double encoderVelocity,
            Double currentAmps,
            String motorMode,
            Double batteryVoltage) {
        this.runId = runId;
        this.opmodeName = opmodeName;
        this.runStartedAt = runStartedAt;
        this.timestampMs = timestampMs;
        this.deviceName = deviceName;
        this.commandedPower = sanitizePower(commandedPower);
        this.encoderPositionTicks = encoderPositionTicks;
        this.encoderVelocity = sanitizeFinite(encoderVelocity);
        this.currentAmps = sanitizeFinite(currentAmps);
        this.motorMode = motorMode;
        this.batteryVoltage = sanitizePositiveFinite(batteryVoltage);
    }

    /** Build the CSV row for this sample using the stable column order. */
    public String toCsvRow() {
        Object[] values = new Object[RunHealthCsv.COLUMNS.length];
        values[0] = RunHealthCsv.SCHEMA_VERSION;
        values[1] = runId;
        values[2] = opmodeName;
        values[3] = runStartedAt;
        values[4] = timestampMs;       // CSV integer formatter handles longs
        values[5] = deviceName;
        values[6] = commandedPower;
        values[7] = encoderPositionTicks;
        values[8] = encoderVelocity;
        values[9] = currentAmps;
        values[10] = motorMode;
        values[11] = batteryVoltage;
        return RunHealthCsv.joinRow(values);
    }

    private static Double sanitizePower(Double v) {
        if (v == null) return null;
        if (!Double.isFinite(v)) return null;
        // Clip to the documented commanded-power domain [-1, 1].
        if (v > 1.0) v = 1.0;
        if (v < -1.0) v = -1.0;
        return v;
    }

    private static Double sanitizeFinite(Double v) {
        if (v == null) return null;
        if (!Double.isFinite(v)) return null;
        return v;
    }

    /** Battery must be positive and finite; 0/NaN/Inf become blank. */
    private static Double sanitizePositiveFinite(Double v) {
        if (v == null) return null;
        if (!Double.isFinite(v)) return null;
        if (v <= 0.0) return null;
        return v;
    }
}
