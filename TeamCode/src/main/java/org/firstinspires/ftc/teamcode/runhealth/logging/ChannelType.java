/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

/**
 * Supported Run Health custom channel data types.
 *
 * <p>Every custom channel a team publishes through
 * {@link RunHealthSession#put(String, double)},
 * {@link RunHealthSession#putBoolean(String, boolean)},
 * {@link RunHealthSession#putText(String, String)},
 * {@link RunHealthSession#mark(String)}, or
 * {@link RunHealthSession#putPose(String, double, double, double)} is
 * recorded as one of these types.  The on-disk encoding for each is
 * documented in {@link ChannelsCsv}.
 *
 * <p>{@link #POSE} is stored as three numeric fields (x, y, heading) in a
 * single CSV row in deterministic order.  {@link #NUMBER}, {@link #BOOLEAN},
 * and {@link #TEXT} are simple scalar values.  {@link #EVENT} is a string
 * marker with a separate timestamp.
 */
public enum ChannelType {
    NUMBER,
    BOOLEAN,
    TEXT,
    EVENT,
    POSE;

    /**
     * Returns the canonical wire string used in the channel-samples CSV
     * {@code kind} column and the {@link RunManifest}.  Stable across
     * schema versions.
     */
    public String wireName() {
        switch (this) {
            case NUMBER: return "number";
            case BOOLEAN: return "boolean";
            case TEXT: return "text";
            case EVENT: return "event";
            case POSE: return "pose";
            default: throw new IllegalStateException("unreachable: " + this);
        }
    }

    /**
     * Parses a wire name back into a {@link ChannelType}.  Returns
     * {@code null} on unknown input rather than throwing, so a malformed
     * record can be safely skipped.
     */
    public static ChannelType fromWireName(String s) {
        if (s == null) return null;
        String n = s.trim().toLowerCase(java.util.Locale.US);
        if (n.isEmpty()) return null;
        switch (n) {
            case "number": return NUMBER;
            case "boolean": return BOOLEAN;
            case "text": return TEXT;
            case "event": return EVENT;
            case "pose": return POSE;
            default: return null;
        }
    }
}
