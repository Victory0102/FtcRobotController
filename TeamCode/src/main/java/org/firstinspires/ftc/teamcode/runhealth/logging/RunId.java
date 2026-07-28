/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import java.security.SecureRandom;

/**
 * RFC 4122 v4-style UUID generator used for run IDs.
 *
 * <p>The intent is uniqueness across:
 * <ul>
 *   <li>Multiple Robot Controllers on the same network.</li>
 *   <li>Multiple runs within a single OpMode restart cycle.</li>
 *   <li>Files stored on the Control Hub filesystem over many sessions.</li>
 * </ul>
 *
 * <p>Uses {@link SecureRandom} where available so two Control Hubs brought
 * online simultaneously will not collide.  Falls back to a deterministic-but-
 * unique (timestamp + hostname hash) scheme if SecureRandom is unavailable.
 */
public final class RunId {

    private static final SecureRandom RNG = createRng();

    private RunId() { /* utility */ }

    private static SecureRandom createRng() {
        try {
            return new SecureRandom();
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * Returns a 36-character lowercase RFC 4122 v4 UUID string.
     */
    public static String newId() {
        byte[] bytes;
        if (RNG != null) {
            bytes = new byte[16];
            RNG.nextBytes(bytes);
        } else {
            // Last-resort: time-based with manual entropy from Object.hash().
            long ms = System.currentTimeMillis();
            long ns = System.nanoTime();
            int extra = System.identityHashCode(new Object());
            bytes = new byte[16];
            for (int i = 0; i < 8; i++) {
                bytes[i] = (byte) (ms >>> (8 * (7 - i)));
                bytes[8 + i] = (byte) (ns >>> (8 * (7 - i)));
            }
            bytes[12] = (byte) extra;
            bytes[13] = (byte) (extra >>> 8);
            bytes[14] = (byte) (extra >>> 16);
            bytes[15] = (byte) (extra >>> 24);
        }
        // RFC 4122 v4 marker bits.
        bytes[6] = (byte) ((bytes[6] & 0x0F) | 0x40);
        bytes[8] = (byte) ((bytes[8] & 0x3F) | 0x80);
        return format(bytes);
    }

    private static String format(byte[] b) {
        StringBuilder sb = new StringBuilder(36);
        appendHex(sb, b[0], b[1], b[2], b[3]); sb.append('-');
        appendHex(sb, b[4], b[5]); sb.append('-');
        appendHex(sb, b[6], b[7]); sb.append('-');
        appendHex(sb, b[8], b[9]); sb.append('-');
        appendHex(sb, b[10], b[11], b[12], b[13], b[14], b[15]);
        return sb.toString();
    }

    private static void appendHex(StringBuilder sb, byte... bs) {
        for (byte b : bs) {
            sb.append(HEX[(b >>> 4) & 0x0F]);
            sb.append(HEX[b & 0x0F]);
        }
    }

    private static final char[] HEX = "0123456789abcdef".toCharArray();

    /**
     * Test helper: short 12-character identifier derived from the full UUID.
     * Suitable for filenames.
     */
    public static String shortId(String fullUuid) {
        if (fullUuid == null || fullUuid.length() < 12) {
            throw new IllegalArgumentException("invalid uuid: " + fullUuid);
        }
        return fullUuid.replace("-", "").substring(0, 12);
    }
}
