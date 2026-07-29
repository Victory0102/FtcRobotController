/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Pure-JVM tests for {@link RunManifest}.  Verifies the documented JSON
 * schema, fingerprint determinism, and the channel-list integration.
 */
public class RunManifestTest {

    @Test
    public void build_minimalFieldsArePresent() {
        RunManifest mf = RunManifest.builder()
                .runId("rid-1")
                .opmodeName("OpMode")
                .runStartedAt("2025-01-01T00:00:00Z")
                .durationMs(1234L)
                .truncated(false)
                .build();
        String json = mf.toJson();
        assertNotNull(json);
        assertTrue("schema_version: " + json, json.contains("\"schema_version\":\"2\""));
        assertTrue("run_id: " + json, json.contains("\"run_id\":\"rid-1\""));
        assertTrue("opmode_name: " + json, json.contains("\"opmode_name\":\"OpMode\""));
        assertTrue("duration_ms: " + json, json.contains("\"duration_ms\":1234"));
        assertTrue("truncated: " + json, json.contains("\"truncated\":false"));
    }

    @Test
    public void build_includesFilesBlock() {
        RunManifest mf = RunManifest.builder()
                .runId("rid-1")
                .opmodeName("OpMode")
                .runStartedAt("2025-01-01T00:00:00Z")
                .durationMs(0L)
                .motorsFile("stem.csv")
                .channelsFile("stem.channels.csv")
                .build();
        String json = mf.toJson();
        assertTrue(json.contains("\"files\""));
        assertTrue(json.contains("\"motors\":\"stem.csv\""));
        assertTrue(json.contains("\"channels\":\"stem.channels.csv\""));
    }

    @Test
    public void build_emitsConfigFingerprint() {
        RunManifest mf = RunManifest.builder()
                .runId("rid-1")
                .opmodeName("OpMode")
                .runStartedAt("2025-01-01T00:00:00Z")
                .durationMs(0L)
                .configFingerprint("deadbeef")
                .deviceNames(Arrays.asList("leftFront", "rightFront"))
                .build();
        String json = mf.toJson();
        assertTrue(json.contains("\"fingerprint\":\"deadbeef\""));
        assertTrue(json.contains("\"device_names\":["));
        assertTrue(json.contains("\"leftFront\""));
        assertTrue(json.contains("\"rightFront\""));
    }

    @Test
    public void build_includesChannelsList() {
        RunManifest mf = RunManifest.builder()
                .runId("rid-1")
                .opmodeName("OpMode")
                .runStartedAt("2025-01-01T00:00:00Z")
                .durationMs(0L)
                .addChannel(ChannelSpec.number("vel"))
                .addChannel(new ChannelSpec("enabled", ChannelType.BOOLEAN, null, null, null))
                .build();
        String json = mf.toJson();
        assertTrue(json.contains("\"channels\":["));
        assertTrue(json.contains("\"name\":\"vel\""));
        assertTrue(json.contains("\"kind\":\"number\""));
        assertTrue(json.contains("\"name\":\"enabled\""));
        assertTrue(json.contains("\"kind\":\"boolean\""));
    }

    @Test
    public void build_omitsRobotNameWhenEmpty() {
        RunManifest mf = RunManifest.builder()
                .runId("rid-1")
                .opmodeName("OpMode")
                .runStartedAt("t")
                .durationMs(0L)
                .build();
        String json = mf.toJson();
        assertFalse("must not contain robot_name: " + json, json.contains("robot_name"));
    }

    @Test
    public void build_includesRobotNameWhenSet() {
        RunManifest mf = RunManifest.builder()
                .runId("rid-1")
                .opmodeName("OpMode")
                .runStartedAt("t")
                .durationMs(0L)
                .robotName("myrobot")
                .build();
        String json = mf.toJson();
        assertTrue(json.contains("\"robot_name\":\"myrobot\""));
    }

    @Test
    public void toMap_returnsDocumentedShape() {
        RunManifest mf = RunManifest.builder()
                .runId("rid-1")
                .opmodeName("OpMode")
                .runStartedAt("t")
                .durationMs(0L)
                .build();
        Map<String, Object> root = mf.toMap();
        assertEquals("2", root.get("schema_version"));
        assertEquals("1", root.get("spec_format"));
        Map<String, Object> cfg = (Map<String, Object>) root.get("robot_config");
        assertNotNull(cfg);
        List<?> devices = (List<?>) cfg.get("device_names");
        assertNotNull(devices);
        Map<String, Object> files = (Map<String, Object>) root.get("files");
        assertNotNull(files);
        assertEquals("", files.get("motors"));
    }

    @Test
    public void json_escapesControlCharsInStrings() {
        RunManifest mf = RunManifest.builder()
                .runId("rid\nbad")
                .opmodeName("a\"b")
                .runStartedAt("t")
                .durationMs(0L)
                .build();
        String json = mf.toJson();
        // \n is escaped.
        assertTrue("newline escaped: " + json, json.contains("\\n"));
        // Embedded quote is escaped.
        assertTrue("quote escaped: " + json, json.contains("\\\""));
    }
}
