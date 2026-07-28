/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import com.qualcomm.robotcore.hardware.HardwareMap;
import com.qualcomm.robotcore.hardware.VoltageSensor;

/**
 * Helpers for sampling the Control Hub battery voltage.
 *
 * <p>Strategy (per spec):
 * <ol>
 *     <li>Iterate every {@link VoltageSensor} reported by
 *         {@code hardwareMap.voltageSensor}.</li>
 *     <li>Skip any reading that is {@code null}, infinite, NaN,
 *         zero, or negative.</li>
 *     <li>Return the lowest <em>finite positive</em> reading; this is the
 *         common FTC convention when multiple sensors exist.</li>
 *     <li>If no valid reading exists, return {@code null}.  Run Health never
 *         substitutes 12 V when voltage is missing.</li>
 * </ol>
 *
 * <p>All exceptions thrown by a faulty sensor are caught and treated as if
 * that sensor returned an invalid value.
 */
public final class BatteryVoltageReader {

    private BatteryVoltageReader() { /* utility */ }

    /**
     * Returns the lowest positive finite battery voltage from {@code hwMap},
     * or {@code null} if no sensor produced a valid reading.
     */
    public static Double read(HardwareMap hwMap) {
        if (hwMap == null) return null;
        HardwareMap.DeviceMapping<VoltageSensor> sensors;
        try {
            sensors = hwMap.voltageSensor;
        } catch (Throwable t) {
            return null;
        }
        if (sensors == null) return null;
        Double best = null;
        for (VoltageSensor sensor : sensors) {
            if (sensor == null) continue;
            Double reading;
            try {
                double v = sensor.getVoltage();
                reading = Double.isFinite(v) && v > 0 ? v : null;
            } catch (Throwable t) {
                reading = null;
            }
            if (reading == null) continue;
            if (best == null || reading < best) {
                best = reading;
            }
        }
        return best;
    }
}
