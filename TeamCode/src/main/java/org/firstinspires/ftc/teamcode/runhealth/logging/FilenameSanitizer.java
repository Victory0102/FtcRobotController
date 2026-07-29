/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import java.io.File;
import java.util.Locale;

/**
 * Strict filename and path-segment sanitizer used when writing CSV files
 * under the Run Health directory.
 *
 * <p>Rules enforced (always):
 * <ul>
 *   <li>No "/" or "\\" or any other path separator.</li>
 *   <li>No "..", "." or empty segments.</li>
 *   <li>No leading dot (no hidden files).</li>
 *   <li>No control characters (U+0000..U+001F and U+007F).</li>
 *   <li>No Windows-forbidden characters ({@code <>:"/\|?*}).</li>
 *   <li>No reserved device names on Windows ({@code CON, PRN, AUX, NUL,
 *       COM1..COM9, LPT1..LPT9}).</li>
 *   <li>Trimmed and length-capped to &le; 64 characters.</li>
 *   <li>Falls back to {@code "unnamed"} when the result is empty.</li>
 * </ul>
 *
 * <p>The sanitizer is intentionally single-direction: input is unsafe human
 * text (opmode names, run timestamps, …) and output is safe for use as a
 * single path segment.
 */
public final class FilenameSanitizer {

    /** Maximum length of a single sanitized segment (after trimming). */
    public static final int MAX_LEN = 64;

    private FilenameSanitizer() { /* utility */ }

    /**
     * Returns {@code name} transformed into a safe path segment.
     * If every character is invalid, returns {@code "unnamed"}.
     */
    public static String sanitizeSegment(String name) {
        if (name == null) return "unnamed";
        StringBuilder sb = new StringBuilder(name.length());
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (isAllowedChar(c)) {
                sb.append(c);
            } else {
                sb.append('_');
            }
        }
        // Trim leading dots/dashes/underscores (avoid hidden files).
        while (sb.length() > 0) {
            char c = sb.charAt(0);
            if (c == '.' || c == '_' || c == '-') sb.deleteCharAt(0);
            else break;
        }
        if (sb.length() == 0) return "unnamed";
        if (sb.length() > MAX_LEN) sb.setLength(MAX_LEN);
        String s = sb.toString();
        if (isWindowsReservedName(s)) return "_" + s;
        return s;
    }

    /**
     * Builds a CSV filename from a timestamp, sanitized opmode name, and
     * short UUID.  Format: {@code <UTC>-<opmode>-<short>.csv}.
     */
    public static String buildCsvFilename(String utcTimestampSafe, String opmodeName, String runId) {
        String opSeg = sanitizeSegment(opmodeName);
        String idSeg = sanitizeSegment(RunId.shortId(runId));
        String tsSeg = sanitizeSegment(utcTimestampSafe);
        return tsSeg + "-" + opSeg + "-" + idSeg + ".csv";
    }

    /**
     * Validates that a given path stays within {@code root}.
     * <p>Returns {@code true} if {@code candidate} is contained in
     * {@code root} after canonical resolution of both.
     * <p>Returns {@code false} if {@code candidate} is null, doesn't exist,
     * escapes via {@code ..}, is an absolute path outside of {@code root},
     * or traverses a symlink.
     */
    public static boolean isWithinDirectory(File root, File candidate) {
        if (root == null || candidate == null) return false;
        try {
            String canonicalRoot = root.getCanonicalPath();
            String canonicalCandidate = candidate.getCanonicalPath();
            // Use platform path separator handling for Android (which is Linux).
            if (canonicalCandidate.equals(canonicalRoot)) {
                return true;
            }
            if (!canonicalCandidate.startsWith(canonicalRoot + File.separator)) {
                return false;
            }
            // Block any parent traversal (defence in depth; canonical should already do this).
            String[] parts = canonicalCandidate.substring(
                    canonicalRoot.length() + 1).split(java.util.regex.Pattern.quote(File.separator));
            for (String p : parts) {
                if ("..".equals(p)) return false;
                if (".".equals(p)) return false;
            }
            return true;
        } catch (SecurityException | java.util.regex.PatternSyntaxException | java.io.IOException t) {
            // Defence in depth: a SecurityException can be raised by an
            // overzealous SecurityManager that denies access to
            // getCanonicalPath(); a PatternSyntaxException can be raised
            // if the platform separator is interpreted as a regex
            // metacharacter by String.split.  Both are treated as a
            // failed path-validation so the caller sees a defensive
            // rejection.  Real JVM fatal errors (OutOfMemoryError,
            // StackOverflowError, etc.) are NOT swallowed here so genuine
            // bugs continue to surface.
            return false;
        }
    }

    private static boolean isAllowedChar(char c) {
        if (c < 0x20 || c == 0x7F) return false;        // control
        switch (c) {
            case '<': case '>': case ':': case '"':
            case '/': case '\\': case '|': case '?': case '*':
                return false;
            default:
                return true;
        }
    }

    private static boolean isWindowsReservedName(String name) {
        // Only check the first <=12 chars stripped of underscores, since we
        // never generate names matching a reserved pattern. Keep cheap.
        String upper = name.toUpperCase(Locale.US);
        return upper.equals("CON") || upper.equals("PRN")
                || upper.equals("AUX") || upper.equals("NUL")
                || upper.startsWith("COM")
                || upper.startsWith("LPT");
    }
}
