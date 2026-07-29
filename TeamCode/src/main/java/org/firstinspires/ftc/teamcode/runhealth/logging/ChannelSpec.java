/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import java.util.Locale;

/**
 * Immutable definition of a Run Health custom channel.
 *
 * <p>Declared via
 * {@code session.defineChannel(name, RunHealthChannel.number().group("Slide").unit("ticks"))}.
 * Stored in the run manifest so the browser can render units, grouping, and
 * description consistently across runs.
 *
 * <p>Channel names must:
 * <ul>
 *   <li>Be non-empty and at most {@link #MAX_NAME_LENGTH} ASCII characters.</li>
 *   <li>Contain only letters, digits, dots, hyphens and underscores.</li>
 *   <li>Not start with {@code __} (reserved for system tags).</li>
 * </ul>
 *
 * <p>Bulk string fields ({@code group}, {@code unit}, {@code description})
 * are length-capped and JSON-escaped by the manifest writer.  The class
 * itself is immutable and thread-safe.
 */
public final class ChannelSpec {

    public static final int MAX_NAME_LENGTH = 64;
    public static final int MAX_GROUP_LENGTH = 32;
    public static final int MAX_UNIT_LENGTH = 16;
    public static final int MAX_DESCRIPTION_LENGTH = 256;

    public final String name;
    public final ChannelType type;
    public final String group;       // may be null or empty
    public final String unit;        // may be null or empty
    public final String description; // may be null or empty

    public ChannelSpec(String name, ChannelType type,
                      String group, String unit, String description) {
        if (name == null) throw new IllegalArgumentException("name required");
        if (type == null) throw new IllegalArgumentException("type required");
        String trimmedName = name.trim();
        validateName(trimmedName);
        this.name = trimmedName;
        this.type = type;
        this.group = clamp(group, MAX_GROUP_LENGTH);
        this.unit = clamp(unit, MAX_UNIT_LENGTH);
        this.description = clamp(description, MAX_DESCRIPTION_LENGTH);
    }

    /**
     * Convenience: a single required field plus type.  Optional metadata
     * defaults to empty.
     */
    public static ChannelSpec number(String name) {
        return new ChannelSpec(name, ChannelType.NUMBER, null, null, null);
    }

    /** Validates a channel name without constructing a spec; returns
     *  the normalised name.  Useful for early validation in hot paths. */
    public static String validateName(String name) {
        if (name == null) throw new IllegalArgumentException("channel name required");
        String trimmed = name.trim();
        if (trimmed.length() == 0) throw new IllegalArgumentException("channel name empty");
        if (trimmed.length() > MAX_NAME_LENGTH) {
            throw new IllegalArgumentException("channel name too long: " + trimmed.length()
                    + " > " + MAX_NAME_LENGTH);
        }
        if (trimmed.startsWith("__")) {
            throw new IllegalArgumentException("channel name reserved prefix: __");
        }
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z')
                    || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9')
                    || c == '.' || c == '-' || c == '_';
            if (!ok) {
                throw new IllegalArgumentException(
                        "channel name has invalid character '" + c + "' in '" + trimmed + "'");
            }
        }
        return trimmed;
    }

    private static String clamp(String s, int maxLen) {
        if (s == null) return "";
        String trimmed = s.trim();
        if (trimmed.length() == 0) return "";
        if (trimmed.length() > maxLen) {
            // Truncate at maxLen.  We never log this truncation; it is a
            // documented contract.
            return trimmed.substring(0, maxLen);
        }
        return trimmed;
    }

    @Override public String toString() {
        return "ChannelSpec{" + name + ":" + type.wireName()
                + (group == null || group.isEmpty() ? "" : " group=" + group)
                + (unit == null || unit.isEmpty() ? "" : " unit=" + unit)
                + "}";
    }

    // Identity is case-insensitive name + ChannelType only; the supplemental
    // metadata fields (group / unit / description) are intentionally excluded
    // so that redefining a channel with the same name and type remains
    // idempotent (the registry refines metadata in place rather than refusing).
    //
    // equals and hashCode stay in agreement: equals uses locale-independent
    // equalsIgnoreCase (safe because validateName enforces the ASCII alphabet
    // [a-zA-Z0-9._-]); hashCode and key()/keyFor() use Locale.US lower-case for
    // the canonical key.  Both produce the same answer for ASCII inputs.
    @Override public boolean equals(Object o) {
        if (o == this) return true;
        if (!(o instanceof ChannelSpec)) return false;
        ChannelSpec c = (ChannelSpec) o;
        return name.equalsIgnoreCase(c.name) && type == c.type;
    }

    @Override public int hashCode() {
        return name.toLowerCase(Locale.US).hashCode() * 31 + type.hashCode();
    }

    /** Canonical key for this spec: lowercased name under {@link Locale#US}.
     *  Use this anywhere a {@code ChannelSpec} is being looked up by name so
     *  the same key shape is used everywhere. */
    public String key() {
        return name.toLowerCase(Locale.US);
    }

    /** Null-safe canonical key for callers that only have a raw name string
     *  (e.g. {@code ChannelRegistry.has(String)}).
     *  <p>Returns {@code null} when {@code rawName} is {@code null}; otherwise
     *  returns the lower-cased canonical key under {@link Locale#US}.  This
     *  method never throws, including for {@code null} input.
     *  <p>The {@code null}-returning contract for {@code null} input is part
     *  of the public API: caller code may rely on it.  Refactors that switch
     *  to {@code Objects.requireNonNullElseGet} or similar must preserve the
     *  exact null-on-null behaviour. */
    public static String keyFor(String rawName) {
        if (rawName == null) return null;
        return rawName.toLowerCase(Locale.US);
    }
}
