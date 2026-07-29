/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import java.util.Locale;

/**
 * Writer-side of the Run Health v2 custom-channels CSV.
 *
 * <p>Stable column order (do not reorder without bumping the run manifest
 * schema; this file is the value-side of {@code recorder_schema_version = 2}):
 *
 * <pre>
 *   timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note
 * </pre>
 *
 * <p>Each row carries one logical sample for one channel, regardless of
 * {@link ChannelType}.  For {@link ChannelType#NUMBER}, only
 * {@code value_number} is non-blank.  For {@link ChannelType#BOOLEAN}, only
 * {@code value_boolean} is non-blank.  For {@link ChannelType#TEXT} and
 * {@link ChannelType#EVENT}, {@code value_text} holds the string.  For
 * {@link ChannelType#POSE}, {@code value_x}, {@code value_y},
 * {@code value_heading} are populated.  All other cells must remain blank.
 *
 * <p>Encoding rules (per spec):
 * <ul>
 *   <li>UTF-8, RFC 4180 quoting for commas, quotes, and newlines.</li>
 *   <li>Locale.US floating-point.</li>
 *   <li>NaN / Infinity / non-finite → blank.</li>
 *   <li>String fields are length-capped and CSV-quoted.</li>
 *   <li>Rows are sorted by {@code (timestamp_ms, channel_name)} in the
 *       writer.</li>
 * </ul>
 */
public final class ChannelsCsv {

    public static final String[] COLUMNS = {
            "timestamp_ms",
            "channel_name",
            "kind",
            "value_number",
            "value_boolean",
            "value_text",
            "value_x",
            "value_y",
            "value_heading",
            "note",
    };

    /**
     * Canonical channel-name column value for {@link ChannelType#EVENT} rows.
     * Reserved-prefix rows always carry this literal so browser-side event
     * filtering (e.g. {@code channel_name === "__event__"}) stays stable
     * across runs.  Never localised, never sanitised away.
     */
    public static final String EVENT_CHANNEL_NAME = "__event__";

    private ChannelsCsv() { /* utility */ }

    public static String headerRow() {
        return joinRow(toStrings(COLUMNS));
    }

    /** Serialises a logical channel sample into a single CSV row. */
    public static String sampleRow(long timestampMs,
                                   String channelName,
                                   ChannelType type,
                                   Double valueNumber,
                                   Boolean valueBoolean,
                                   String valueText,
                                   Double valueX,
                                   Double valueY,
                                   Double valueHeading,
                                   String note) {
        Object[] values = new Object[COLUMNS.length];
        values[0] = Long.valueOf(timestampMs);
        // EVENT rows always carry the literal reserved-prefix column value so
        // browser-side event filtering is not subject to the safety-driven
        // clampChannel rewrite.  All other types go through the standard
        // user-channel sanitiser.
        values[1] = (type == ChannelType.EVENT)
                ? EVENT_CHANNEL_NAME
                : clampChannel(channelName);
        values[2] = type == null ? ChannelType.NUMBER.wireName() : type.wireName();
        values[3] = valueNumber;
        values[4] = valueBoolean;
        values[5] = clampText(valueText, MAX_TEXT_VALUE);
        values[6] = valueX;
        values[7] = valueY;
        values[8] = valueHeading;
        values[9] = clampText(note, MAX_NOTE_VALUE);
        return joinRow(values);
    }

    /**
     * Joins an array of values into a single channel-CSV row (10 columns).
     *
     * <p>The v2 channels CSV has its own 10-column width; it is not the
     * 12-column motor CSV.  We therefore do NOT reuse
     * {@link RunHealthCsv#joinRow(Object[])} which is strict against the
     * motor width and would throw {@code IllegalArgumentException} on
     * any channels row.
     *
     * <p>Per-column formatting mirrors {@link RunHealthCsv}: numbers go
     * through {@link RunHealthCsv#formatNumber(Double)} (Locale.US, blank
     * for non-finite), booleans become {@code true}/{@code false}, and
     * strings are RFC-4180 escaped via {@link RunHealthCsv#escape(Object)}.
     */
    private static String joinRow(Object[] values) {
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
            sb.append(formatCell(values[i]));
        }
        return sb.toString();
    }

    private static String formatCell(Object v) {
        if (v == null) return "";
        // Dispatch numeric values through {@link #formatNumber(Double)} so
        // the channels CSV sticks to its documented six-fractional-digit
        // Locale.US contract rather than falling back to the motor-CSV
        // compact form.  The motor CSV's formatter is for a different
        // schema and produces e.g. "1.5" where this CSV needs "1.500000".
        if (v instanceof Double) return formatNumber((Double) v);
        if (v instanceof Float)  return formatNumber((double) (Float) v);
        if (v instanceof Boolean) return ((Boolean) v) ? "true" : "false";
        if (v instanceof Long || v instanceof Integer
                || v instanceof Short || v instanceof Byte) {
            return v.toString();
        }
        // Generic fallback: stringify then RFC-4180 escape.
        return RunHealthCsv.escape(v);
    }

    private static String channelsColumnName(String s) {
        if (s == null) return "";
        String trimmed = s.trim();
        if (trimmed.isEmpty()) return "";
        ChannelSpec.validateName(trimmed);
        return trimmed;
    }

    /**
     * Wraps {@link #channelsColumnName(String)} so the writer path never
     * throws on an invalid channel name (e.g. {@code __event__} from
     * {@code mark()} which intentionally bypasses the reserved-prefix
     * rule).  When the strict validation rejects the name, we replace
     * every bad character with {@code _} and trim leading punctuation
     * so the CSV column stays well-formed.
     */
    private static String clampChannel(String s) {
        try {
            return channelsColumnName(s);
        } catch (Throwable t) {
            // Permissive rewrite.  We DO NOT use {@code s} directly because
            // it would feed potential garbage (commas, quotes, newlines)
            // back into the CSV; we sanitise into a safe sub-segment.
            String trimmed = s == null ? "" : s.trim();
            StringBuilder sb = new StringBuilder(trimmed.length());
            for (int i = 0; i < trimmed.length(); i++) {
                char c = trimmed.charAt(i);
                boolean ok = (c >= 'a' && c <= 'z')
                        || (c >= 'A' && c <= 'Z')
                        || (c >= '0' && c <= '9')
                        || c == '.' || c == '-' || c == '_';
                sb.append(ok ? c : '_');
            }
            // Trim leading dots/dashes/underscores so we never emit a
            // hidden-file-like segment.
            while (sb.length() > 0) {
                char c = sb.charAt(0);
                if (c == '.' || c == '_' || c == '-') sb.deleteCharAt(0);
                else break;
            }
            return sb.length() == 0 ? "_" : sb.toString();
        }
    }

    private static String clampText(String s, int maxLen) {
        if (s == null) return "";
        if (s.length() <= maxLen) return s;
        return s.substring(0, maxLen);
    }

    private static Object[] toStrings(String[] arr) {
        Object[] out = new Object[arr.length];
        for (int i = 0; i < arr.length; i++) out[i] = arr[i];
        return out;
    }

    /**
     * Locale.US formatter used by both the number and heading columns
     * to keep alignment with the browser-side CSV parsers.
     */
    public static String formatNumber(Double v) {
        if (v == null || Double.isNaN(v) || Double.isInfinite(v)) return "";
        return localeUS(v);
    }

    /**
     * Canonical boolean wire string used in the {@code value_boolean}
     * column.  Anything else in that cell is treated as {@code null}.
     */
    public static String formatBoolean(Boolean v) {
        if (v == null) return "";
        return Boolean.TRUE.equals(v) ? "true" : "false";
    }

    /** Cap helper for the maximum text size a browser may send back. */
    public static final int MAX_TEXT_VALUE = 128;
    public static final int MAX_NOTE_VALUE = 256;

    /**
     * Used by unit tests as a clean Locale.US formatter.  Integer-valued
     * doubles receive one fractional digit ({@code "0.0"} for {@code 0.0d});
     * non-integers receive six ({@code "1.500000"} for {@code 1.5d}).  This
     * matches the documented {@code CSV_SCHEMA.md} contract for the
     * channels CSV.
     */
    public static String localeUS(double v) {
        if (v == Math.floor(v) && !Double.isInfinite(v)
                && Math.abs(v) < 1e15) {
            return String.format(Locale.US, "%.1f", v);
        }
        return String.format(Locale.US, "%.6f", v);
    }
}
