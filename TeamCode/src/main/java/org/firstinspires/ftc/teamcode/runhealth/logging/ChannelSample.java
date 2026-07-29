/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

/**
 * Immutable in-memory representation of one custom channel sample.
 *
 * <p>Most fields are nullable; only the cells relevant to the channel's
 * {@link ChannelType} are populated.  The class is intentionally
 * over-specified for the simple scalar cases so the writer can keep a
 * single code path.
 */
public final class ChannelSample {

    public final long timestampMs;
    public final String channelName;
    public final ChannelType type;
    public final Double valueNumber;
    public final Boolean valueBoolean;
    public final String valueText;
    public final Double valueX;
    public final Double valueY;
    public final Double valueHeading;
    public final String note;

    public ChannelSample(long timestampMs,
                         String channelName,
                         ChannelType type,
                         Double valueNumber,
                         Boolean valueBoolean,
                         String valueText,
                         Double valueX,
                         Double valueY,
                         Double valueHeading,
                         String note) {
        this.timestampMs = timestampMs;
        this.channelName = channelName == null ? "" : channelName;
        this.type = type == null ? ChannelType.NUMBER : type;
        this.valueNumber = sanitizeFinite(valueNumber);
        this.valueBoolean = valueBoolean;
        this.valueText = sanitizeText(valueText, ChannelsCsv.MAX_TEXT_VALUE);
        this.valueX = sanitizeFinite(valueX);
        this.valueY = sanitizeFinite(valueY);
        this.valueHeading = sanitizeFinite(valueHeading);
        this.note = sanitizeText(note, ChannelsCsv.MAX_NOTE_VALUE);
    }

    /** Renders this sample to one CSV row using {@link ChannelsCsv}. */
    public String toCsvRow() {
        return ChannelsCsv.sampleRow(
                timestampMs, channelName, type,
                valueNumber, valueBoolean, valueText,
                valueX, valueY, valueHeading, note);
    }

    private static Double sanitizeFinite(Double v) {
        if (v == null) return null;
        if (!Double.isFinite(v)) return null;
        return v;
    }

    private static String sanitizeText(String s, int maxLen) {
        if (s == null) return "";
        if (s.length() <= maxLen) return s;
        return s.substring(0, maxLen);
    }
}
