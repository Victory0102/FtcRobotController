/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import org.junit.Test;

import java.util.HashSet;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Pure-JVM tests for {@link RunId}.  Verifies UUID v4 shape, the
 * {@code shortId} filename-friendly projection, and uniqueness at scale.
 */
public class RunIdTest {

    @Test
    public void newId_hasCorrectLength() {
        String id = RunId.newId();
        assertEquals("uuid must be 36 chars", 36, id.length());
    }

    @Test
    public void newId_hasDashesAtCorrectPositions() {
        String id = RunId.newId();
        assertEquals('-', id.charAt(8));
        assertEquals('-', id.charAt(13));
        assertEquals('-', id.charAt(18));
        assertEquals('-', id.charAt(23));
    }

    @Test
    public void newId_includesV4Marker() {
        String id = RunId.newId();
        // Position 14 is the version digit; must be '4' for RFC 4122 v4.
        assertEquals('4', id.charAt(14));
        // Position 19 is the high nibble of variant; must be 8/9/a/b.
        char variantHigh = id.charAt(19);
        assertTrue("variant must be 8/9/a/b: " + variantHigh,
                variantHigh == '8' || variantHigh == '9'
                        || variantHigh == 'a' || variantHigh == 'b');
    }

    @Test
    public void newId_twoCallsAreDistinct() {
        // With high probability two adjacent SecureRandom draws collide never.
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 1000; i++) {
            seen.add(RunId.newId());
        }
        assertEquals("no collisions in 1000 ids", 1000, seen.size());
    }

    @Test
    public void shortId_extractsFirstTwelveHexChars() {
        String id = "00000000-aaaa-0000-0000-000000000001";
        String shortId = RunId.shortId(id);
        assertEquals(12, shortId.length());
        assertEquals("00000000aaaa", shortId);
    }

    @Test
    public void shortId_rejectsBadInput() {
        try {
            RunId.shortId("abc");
            fail("expected exception");
        } catch (IllegalArgumentException expected) { /* ok */ }
        try {
            RunId.shortId(null);
            fail("expected exception");
        } catch (IllegalArgumentException expected) { /* ok */ }
    }

    @Test
    public void newId_isLowercase() {
        String id = RunId.newId();
        assertEquals(id.toLowerCase(), id);
    }
}
