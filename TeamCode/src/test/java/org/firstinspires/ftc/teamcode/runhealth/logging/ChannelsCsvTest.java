/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Pure-JVM tests for {@link ChannelsCsv}.  Verifies column ordering, type
 * dispatch, numeric formatting rules, and the {@code __event__} reserved
 * channel-name exception path.
 */
public class ChannelsCsvTest {

    @Test
    public void headerRow_columnOrderIsStable() {
        String expected = "timestamp_ms,channel_name,kind,value_number,value_boolean,"
                + "value_text,value_x,value_y,value_heading,note";
        assertEquals(expected, ChannelsCsv.headerRow());
    }

    @Test
    public void sampleRow_numberType_writesNumber() {
        String row = ChannelsCsv.sampleRow(
                100L, "vel", ChannelType.NUMBER,
                Double.valueOf(12.5), null, null,
                null, null, null, null);
        // 12.5 is non-integer → "%.6f" → "12.500000"
        assertTrue("number cell populated: " + row, row.contains("12.500000"));
        assertTrue("channel name present: " + row, row.contains("vel"));
        assertTrue("kind column: " + row, row.contains(",number,"));
    }

    @Test
    public void sampleRow_booleanType_writesCanonicalValue() {
        assertTrue(ChannelsCsv.sampleRow(
                100L, "is_ready", ChannelType.BOOLEAN,
                null, Boolean.TRUE, null,
                null, null, null, null).contains(",true,"));
        assertTrue(ChannelsCsv.sampleRow(
                100L, "is_ready", ChannelType.BOOLEAN,
                null, Boolean.FALSE, null,
                null, null, null, null).contains(",false,"));
    }

    @Test
    public void sampleRow_textType_quotesCommas() {
        String row = ChannelsCsv.sampleRow(
                0L, "msg", ChannelType.TEXT,
                null, null, "hello, world",
                null, null, null, null);
        assertTrue("commas must be quoted: " + row, row.contains("\"hello, world\""));
    }

    @Test
    public void sampleRow_poseType_writesThreeCoords() {
        String row = ChannelsCsv.sampleRow(
                0L, "pose", ChannelType.POSE,
                null, null, null,
                Double.valueOf(1.0), Double.valueOf(2.5),
                Double.valueOf(Math.PI / 2), null);
        // 1.0 is integer-valued → "%.1f" → "1.0"
        assertTrue("x present (integer-valued): " + row, row.contains(",1.0,"));
        // 2.5 is non-integer → "%.6f" → "2.500000"
        assertTrue("y present (non-integer): " + row, row.contains(",2.500000,"));
        // Heading π/2 is non-integer; six fractional digits
        assertTrue("heading present: " + row, row.contains(",1.570796,"));
    }

    @Test
    public void sampleRow_eventType_clampedNote() {
        String note = "abcdefghij";
        String row = ChannelsCsv.sampleRow(
                0L, "vel", ChannelType.EVENT,
                null, null, note,
                null, null, null, note);
        assertTrue("note in note columns: " + row, row.contains(note));
    }

    @Test
    public void sampleRow_eventType_writesReservedLiteralChannelName() {
        // The writer contract: every EVENT row must carry the literal
        // reserved-prefix name "__event__" in the channel column,
        // regardless of what name the caller passed in.  This is what
        // makes browser-side event filtering stable across runs.
        String row = ChannelsCsv.sampleRow(
                0L, "this-is-ignored", ChannelType.EVENT,
                null, null, "started",
                null, null, null, "started");
        assertTrue("row begins with timestamp: " + row, row.startsWith("0,"));
        assertTrue("EVENT row MUST carry the reserved literal: " + row,
                row.contains("__event__"));
        // Structural sanity: 10 columns (channels CSV width).
        String[] parts = row.split(",", -1);
        assertEquals("row has 10 columns: " + row, 10, parts.length);
        // parts[1] is the channel_name column (after timestamp_ms).
        assertEquals("channel_name column is the literal: " + row,
                "__event__", parts[1]);
        // parts[2] is the kind column.
        assertEquals("kind column is 'event': " + row, "event", parts[2]);
    }

    @Test
    public void formatNumber_blankForNullAndNonFinite() {
        assertEquals("", ChannelsCsv.formatNumber(null));
        assertEquals("", ChannelsCsv.formatNumber(Double.NaN));
        assertEquals("", ChannelsCsv.formatNumber(Double.POSITIVE_INFINITY));
        assertEquals("", ChannelsCsv.formatNumber(Double.NEGATIVE_INFINITY));
        // The channels schema caps precision at 6 fractional
        // digits.  Integer-valued doubles get one fractional digit; the rest
        // get six.  This locks in the documented behaviour so the test
        // fails the day someone tightens it.
        assertEquals("1.500000", ChannelsCsv.formatNumber(1.5));
        assertEquals("-0.250000", ChannelsCsv.formatNumber(-0.25));
        assertEquals("0.0", ChannelsCsv.formatNumber(0.0));
        assertEquals("12.0", ChannelsCsv.formatNumber(12.0));
    }

    @Test
    public void formatNumber_usesLocaleUS() {
        java.util.Locale original = java.util.Locale.getDefault();
        try {
            java.util.Locale.setDefault(java.util.Locale.GERMANY);
            assertEquals("1.500000", ChannelsCsv.formatNumber(1.5));
        } finally {
            java.util.Locale.setDefault(original);
        }
    }

    @Test
    public void formatBoolean_canonicalWireValues() {
        assertEquals("", ChannelsCsv.formatBoolean(null));
        assertEquals("true", ChannelsCsv.formatBoolean(Boolean.TRUE));
        assertEquals("false", ChannelsCsv.formatBoolean(Boolean.FALSE));
    }

    @Test
    public void maxConstants_areStable() {
        assertEquals(128, ChannelsCsv.MAX_TEXT_VALUE);
        assertEquals(256, ChannelsCsv.MAX_NOTE_VALUE);
    }

    @Test
    public void sampleRow_handlesEmptyChannelName() {
        // channel="" → strict path returns "" → emitted as empty cell.
        // 2.0 is integer-valued → "%.1f" → "2.0".
        String row = ChannelsCsv.sampleRow(
                42L, "", ChannelType.NUMBER,
                Double.valueOf(2.0), null, null,
                null, null, null, null);
        assertTrue("timestamp_ms present: " + row, row.startsWith("42,"));
        assertTrue("kind column specifies number: " + row, row.contains(",number,"));
        assertTrue("number column has the value: " + row, row.contains(",2.0,"));
    }

    @Test
    public void headerRow_isExactlyTenColumns() {
        // Locks in the structural contract: channels CSV is 10 columns,
        // distinct from the motor CSV's 12 columns.  A regression that
        // accidentally aligns the two would surface here.
        String header = ChannelsCsv.headerRow();
        String[] parts = header.split(",");
        assertEquals(10, parts.length);
    }
}
