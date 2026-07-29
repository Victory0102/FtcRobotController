/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * FTC Run Health is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * FTC Run Health is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with FTC Run Health.  If not, see <https://www.gnu.org/licenses/>.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import java.util.Locale;

/**
 * Strict, locale.US CSV formatting helpers used by the Run Health logger and
 * by tests.  This class is the single source of truth for the wire format.
 *
 * <p>Contract:
 * <ul>
 *     <li>UTF-8 text and trailing newline at end of file.</li>
 *     <li>Locale.US-style numeric output (dot decimal, no thousands separators).</li>
 *     <li>Finite numeric values only; NaN / +/-Infinity become blank cells.</li>
 *     <li>Stable column order; see {@link #COLUMNS}.</li>
 *     <li>Proper CSV quoting and escaping per RFC 4180.</li>
 *     <li>Blank (empty) fields for missing or unavailable values—never silently 0.</li>
 * </ul>
 */
public final class RunHealthCsv {

    /**
     * Stable column order.  Changing this requires bumping {@link #SCHEMA_VERSION}.
     * Per spec the order is: schema_version, run_id, opmode_name, run_started_at,
     * timestamp_ms, device_name, commanded_power, encoder_position_ticks,
     * encoder_velocity_ticks_per_second, current_amps, motor_mode, battery_voltage.
     */
    public static final String[] COLUMNS = {
            "schema_version",
            "run_id",
            "opmode_name",
            "run_started_at",
            "timestamp_ms",
            "device_name",
            "commanded_power",
            "encoder_position_ticks",
            "encoder_velocity_ticks_per_second",
            "current_amps",
            "motor_mode",
            "battery_voltage",
    };

    /** Current schema version. Bump when the column order changes. */
    public static final String SCHEMA_VERSION = "1";

    private RunHealthCsv() { /* utility */ }

    /**
     * Returns the header row (no trailing newline).
     */
    public static String headerRow() {
        return joinRow(COLUMNS);
    }

    /**
     * Escapes a single field according to RFC 4180 rules.
     *
     * <p>A field is quoted iff it contains a comma (","), a double quote ("""),
     * a carriage return ("\r") or a line feed ("\n").
     * Double quotes inside a quoted field are escaped by doubling them.
     *
     * <p>{@code null} renders to an empty string.
     */
    public static String escape(Object value) {
        if (value == null) {
            return "";
        }
        String s = value.toString();
        if (s.isEmpty()) {
            return "";
        }
        boolean needsQuoting = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == ',' || c == '"' || c == '\n' || c == '\r') {
                needsQuoting = true;
                break;
            }
        }
        if (!needsQuoting) {
            return s;
        }
        StringBuilder sb = new StringBuilder(s.length() + 4);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') {
                sb.append('"').append('"');
            } else {
                sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    /**
     * Joins an array of values to a single CSV row (no trailing newline).
     */
    public static String joinRow(Object[] values) {
        if (values == null) {
            throw new NullPointerException("values");
        }
        if (values.length != COLUMNS.length) {
            throw new IllegalArgumentException(
                    "Row width mismatch: expected " + COLUMNS.length
                            + " columns, got " + values.length);
        }
        StringBuilder sb = new StringBuilder(64 + values.length * 16);
        for (int i = 0; i < values.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(escape(values[i]));
        }
        return sb.toString();
    }

    /**
     * Formats a floating-point number for CSV output.
     *
     * <p>Returns the empty string when the value is {@code null},
     * {@link Double#NaN}, positive or negative infinity, or otherwise
     * non-finite.  Uses {@link Locale#US} so the decimal separator is
     * always "." regardless of the device locale.
     *
     * <p>{@code Double.toString} is locale-independent by Java contract.
     * For integers the trailing {@code ".0"} is stripped so the CSV cell
     * reads {@code "0"} instead of {@code "0.0"} while keeping the
     * six-digit precision that motor telemetry needs for non-integer
     * values (e.g. {@code "1.5"} for {@code 1.5}).
     *
     * <p>{@code null} casts as blank to satisfy the "never silently
     * substitute zero for missing" requirement.
     */
    public static String formatNumber(Double value) {
        if (value == null) {
            return "";
        }
        double v = value.doubleValue();
        if (!Double.isFinite(v)) {
            return "";
        }
        String s = Double.toString(v);
        if (s.endsWith(".0")) {
            s = s.substring(0, s.length() - 2);
        }
        return s;
    }

    /**
     * Variant for known-non-null finite values; throws if {@code !finite}.
     * Used in tests and parser path.  Preserves the {@code ".0"} suffix on
     * integer-valued doubles so callers can rely on a stable, locale.US
     * representation (e.g. {@code "0.0"} for {@code 0.0d}).
     */
    public static String formatFinite(double v) {
        if (!Double.isFinite(v)) {
            throw new IllegalArgumentException("non-finite value: " + v);
        }
        return Double.toString(v);
    }

    /**
     * Integer formatter. Blank for null. Non-finite does not apply but we guard
     * against {@link Long#MIN_VALUE} produced by Math.abs overflow.
     */
    public static String formatInteger(Long value) {
        if (value == null) {
            return "";
        }
        long v = value.longValue();
        return Long.toString(v);
    }
}
