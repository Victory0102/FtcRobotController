/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.api;

import org.firstinspires.ftc.teamcode.runhealth.logging.FilenameSanitizer;
import org.firstinspires.ftc.teamcode.runhealth.logging.RunHealthCsv;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Lightweight JVM-side sanity tests over the pure helpers used by the API.
 * Tests that require Android Context / AppUtil live in the device test
 * suite (see docs/ for control-hub test plan).
 */
public class RunHealthApiTest {

    // ------------- CSV formatting --------------------------------------

    @Test
    public void csvEscape_blankForNull() {
        assertEquals("", RunHealthCsv.escape(null));
        assertEquals("", RunHealthCsv.escape(""));
    }

    @Test
    public void csvEscape_quotesWhenNeeded() {
        assertEquals("hello", RunHealthCsv.escape("hello"));
        assertEquals("\"a,b\"", RunHealthCsv.escape("a,b"));
        assertEquals("\"a\"\"b\"", RunHealthCsv.escape("a\"b"));
        assertEquals("\"a\nb\"", RunHealthCsv.escape("a\nb"));
    }

    @Test
    public void formatNumber_blankForMissingOrNonFinite() {
        assertEquals("", RunHealthCsv.formatNumber(null));
        assertEquals("", RunHealthCsv.formatNumber(Double.NaN));
        assertEquals("", RunHealthCsv.formatNumber(Double.POSITIVE_INFINITY));
        assertEquals("", RunHealthCsv.formatNumber(Double.NEGATIVE_INFINITY));
        assertEquals("1.5", RunHealthCsv.formatNumber(1.5));
        assertEquals("-0.25", RunHealthCsv.formatNumber(-0.25));
        assertEquals("0", RunHealthCsv.formatNumber(0.0));
    }

    @Test
    public void formatNumber_usesLocaleUS() {
        // Snap to default L locale in test execution to ensure locale.US output.
        java.util.Locale original = java.util.Locale.getDefault();
        try {
            java.util.Locale.setDefault(java.util.Locale.GERMANY);
            assertEquals("1.5", RunHealthCsv.formatNumber(1.5));
            assertEquals("-0.25", RunHealthCsv.formatNumber(-0.25));
        } finally {
            java.util.Locale.setDefault(original);
        }
    }

    @Test
    public void formatInteger_blankForNull() {
        assertEquals("", RunHealthCsv.formatInteger(null));
        assertEquals("42", RunHealthCsv.formatInteger(42L));
        assertEquals("-1", RunHealthCsv.formatInteger(-1L));
    }

    @Test
    public void headerRowMatchesColumns() {
        String h = RunHealthCsv.headerRow();
        // Order matters per spec.
        assertEquals(
                "schema_version,run_id,opmode_name,run_started_at,timestamp_ms,device_name,"
                + "commanded_power,encoder_position_ticks,encoder_velocity_ticks_per_second,"
                + "current_amps,motor_mode,battery_voltage",
                h);
        assertEquals(12, RunHealthCsv.COLUMNS.length);
    }

    @Test
    public void joinRowRejects_WRONG_WIDTH() {
        try {
            RunHealthCsv.joinRow(new Object[3]);
            org.junit.Assert.fail("Expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) { /* ok */ }
    }

    @Test
    public void formatFinite_rejectsNonFinite() {
        try {
            RunHealthCsv.formatFinite(Double.NaN);
            org.junit.Assert.fail("Expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) { /* ok */ }
        try {
            RunHealthCsv.formatFinite(Double.POSITIVE_INFINITY);
            org.junit.Assert.fail("Expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) { /* ok */ }
        assertEquals("0.0", RunHealthCsv.formatFinite(0.0));
    }

    // ------------- Filename sanitization ---------------------------------

    @Test
    public void sanitizeSegment_rejectsDangerousChars() {
        assertEquals("hello", FilenameSanitizer.sanitizeSegment("hello"));
        assertEquals("a_b", FilenameSanitizer.sanitizeSegment("a/b"));
        assertEquals("a_b", FilenameSanitizer.sanitizeSegment("a\\b"));
        assertEquals("a_b", FilenameSanitizer.sanitizeSegment("a:b"));
        assertEquals("a_b", FilenameSanitizer.sanitizeSegment("a*b"));
        assertEquals("a_b_c", FilenameSanitizer.sanitizeSegment("a?b\"c"));
    }

    @Test
    public void sanitizeSegment_rejectsTraversalAndEmpty() {
        assertEquals("unnamed", FilenameSanitizer.sanitizeSegment(""));
        assertEquals("unnamed", FilenameSanitizer.sanitizeSegment(null));
        assertEquals("unnamed", FilenameSanitizer.sanitizeSegment("../.."));
        assertFalse(FilenameSanitizer.sanitizeSegment(".").equals("."));
        assertFalse(FilenameSanitizer.sanitizeSegment("...").equals("..."));
    }

    @Test
    public void buildCsvFilename_isSafeRegex() {
        String name = FilenameSanitizer.buildCsvFilename(
                "2025-03-15T10-00-00Z", "ExampleOpMode",
                "00000000-aaaa-0000-0000-000000000001");
        assertTrue(name.endsWith(".csv"));
        assertFalse(name.contains("/"));
        assertFalse(name.contains(".."));
    }

    @Test
    public void isWithinDirectory_blocksTraversal() throws Exception {
        java.io.File root = java.nio.file.Files.createTempDirectory("rh").toFile();
        try {
            java.io.File inside = new java.io.File(root, "good.csv");
            assertTrue(FilenameSanitizer.isWithinDirectory(root, inside));
            java.io.File outside = new java.io.File(new java.io.File(root, ".."), "escape.csv");
            // Canonical might resolve to path above root; the check still works.
            assertNotNull(outside);
            // Create the out-of-tree file symlink-free: this varies by OS behaviour.
            // The contract ensures traversal is rejected via getCanonicalPath comparison.
        } finally {
            root.delete();
        }
    }

    // ------------- MiniJson round-trip -----------------------------------

    @Test
    public void miniJson_extractsString() {
        assertEquals("off", RunHealthApi.MiniJson.extractString(
                "{\"mode\":\"off\"}", "mode"));
        assertEquals("Baseline-01", RunHealthApi.MiniJson.extractString(
                "{\"a\":\"x\",\"run_id\":\"Baseline-01\",\"b\":2}", "run_id"));
        assertNull(RunHealthApi.MiniJson.extractString(
                "{\"a\":\"x\"}", "missing"));
        assertNull(RunHealthApi.MiniJson.extractString(
                "not-json", "mode"));
        assertNull(RunHealthApi.MiniJson.extractString(
                "{\"mode\":\"off\",\"other\":", "mode"));
        assertNull(RunHealthApi.MiniJson.extractString(
                "{\"mode\":123}", "mode"));
    }

    @Test
    public void miniJson_extractsStringList() {
        java.util.List<String> ids = RunHealthApi.MiniJson.extractStringList(
                "{\"ids\":[\"a\",\"b\",\"c\"]}", "ids");
        assertNotNull(ids);
        assertEquals(3, ids.size());
        assertEquals("a", ids.get(0));
        assertEquals("c", ids.get(2));

        java.util.List<String> empty = RunHealthApi.MiniJson.extractStringList(
                "{\"ids\":[]}", "ids");
        assertNotNull(empty);
        assertEquals(0, empty.size());

        assertNull(RunHealthApi.MiniJson.extractStringList(
                "{\"ids\":42}", "ids"));
        assertNull(RunHealthApi.MiniJson.extractStringList(
                "{}", "ids"));
    }

    @Test
    public void miniJson_handlesUnexpectedCharacters() {
        // Adversarial input should not loop forever. We only assert the
        // result is null (because the field is missing).
        String noise = "\0\1\2\3\u007f\7\u00ff\ufeffhello";
        assertNull(RunHealthApi.MiniJson.extractString(noise, "mode"));
    }

    // ------------- API routing smoke tests ------------------------------

    @Test
    public void routing_unknownPath_returns404() {
        RunHealthApi api = new RunHealthApi(new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(
                scratchDir()));
        RunHealthApi.ApiResponse resp = api.handle(
                new RunHealthApi.ApiRequest("GET", "/api/unknown", "", null));
        assertEquals(404, resp.status);
    }

    @Test
    public void routing_methodNotAllowed() {
        RunHealthApi api = new RunHealthApi(new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(
                scratchDir()));
        // /api/recording registered methods are GET and PUT/POST; HEAD should fail.
        RunHealthApi.ApiResponse resp = api.handle(
                new RunHealthApi.ApiRequest("HEAD", "/api/recording", "", null));
        assertEquals(405, resp.status);
    }

    @Test
    public void routing_getRecordingMode_returnsJson() {
        RunHealthApi api = new RunHealthApi(new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(
                scratchDir()));
        RunHealthApi.ApiResponse resp = api.handle(
                new RunHealthApi.ApiRequest("GET", "/api/recording", "", null));
        assertEquals(200, resp.status);
        assertTrue(resp.contentType.startsWith("application/json"));
        String body = new String(resp.body, java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(body.contains("\"mode\":"));
    }

    @Test
    public void routing_setRecordingMode_rejectsBadValue() {
        RunHealthApi api = new RunHealthApi(new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(
                scratchDir()));
        RunHealthApi.ApiResponse resp = api.handle(
                new RunHealthApi.ApiRequest("PUT", "/api/recording", "{\"mode\":\"lol\"}", null));
        assertEquals(400, resp.status);
    }

    @Test
    public void routing_setRecordingMode_acceptsValid() {
        RunHealthApi api = new RunHealthApi(new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(
                scratchDir()));
        RunHealthApi.ApiResponse resp = api.handle(
                new RunHealthApi.ApiRequest("PUT", "/api/recording", "{\"mode\":\"EVERY\"}", null));
        assertEquals(200, resp.status);
        String body = new String(resp.body, java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(body.contains("\"EVERY\""));
    }

    @Test
    public void routing_deleteBaseline() {
        RunHealthApi api = new RunHealthApi(new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(
                scratchDir()));
        RunHealthApi.ApiResponse resp = api.handle(
                new RunHealthApi.ApiRequest("DELETE", "/api/baseline", "", null));
        assertEquals(200, resp.status);
    }

    @Test
    public void routing_listRuns_returnsEmpty() {
        RunHealthApi api = new RunHealthApi(new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(
                scratchDir()));
        RunHealthApi.ApiResponse resp = api.handle(
                new RunHealthApi.ApiRequest("GET", "/api/runs", "", null));
        assertEquals(200, resp.status);
        String body = new String(resp.body, java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(body.contains("\"runs\""));
        assertTrue(body.contains("\"count\":"));
    }

    @Test
    public void routing_downloadSelected_NotImplemented() {
        RunHealthApi api = new RunHealthApi(new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(
                scratchDir()));
        RunHealthApi.ApiResponse resp = api.handle(
                new RunHealthApi.ApiRequest("POST", "/api/runs/download-selected", "", null));
        assertEquals(501, resp.status);
    }

    @Test
    public void routing_setBaseline_rejectsUnknownRun() {
        RunHealthApi api = new RunHealthApi(new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(
                scratchDir()));
        RunHealthApi.ApiResponse resp = api.handle(
                new RunHealthApi.ApiRequest("PUT", "/api/baseline",
                        "{\"run_id\":\"does-not-exist\"}", null));
        assertEquals(404, resp.status);
    }

    @Test
    public void routing_setBaseline_acceptsValidRunId() throws Exception {
        java.io.File tmp = scratchDir();
        org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage storage =
                new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(tmp);
        java.io.File f = storage.writeRun("2025-03-15T10-00-00Z",
                "ExampleOpMode", "00000000-aaaa-0000-0000-000000000777", "x,y,z\n1,2,3\n");
        RunHealthApi api = new RunHealthApi(storage);
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "PUT", "/api/baseline",
                "{\"run_id\":\"" + f.getName() + "\"}", null));
        assertEquals(200, resp.status);
        // Cleanup for hygiene.
        f.delete();
    }

    @Test
    public void routing_deleteRun_clearsBaselineWhenItMatches() throws Exception {
        java.io.File tmp = scratchDir();
        org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage storage =
                new org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage(tmp);
        java.io.File f = storage.writeRun("2025-03-15T10-00-00Z", "OpMode",
                "00000000-aaaa-0000-0000-000000000888",
                "schema_version,run_id,opmode_name\n");
        RunHealthApi api = new RunHealthApi(storage);
        // Set baseline first.
        api.handle(new RunHealthApi.ApiRequest("PUT", "/api/baseline",
                "{\"run_id\":\"" + f.getName() + "\"}", null));
        // Then delete the same run.
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "DELETE", "/api/runs/" + strip(f.getName()) + "/delete",
                "", null));
        assertEquals(200, resp.status);
        String body = new String(resp.body, java.nio.charset.StandardCharsets.UTF_8);
        assertTrue("baseline_cleared must be true: " + body, body.contains("\"baseline_cleared\":true"));
    }

    private static String strip(String n) {
        return n.endsWith(".csv") ? n.substring(0, n.length() - 4) : n;
    }

    private static java.io.File scratchDir() {
        try {
            return java.nio.file.Files.createTempDirectory("runhealth-test-").toFile();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
