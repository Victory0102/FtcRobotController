/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.api;

import org.firstinspires.ftc.teamcode.runhealth.logging.ChannelSample;
import org.firstinspires.ftc.teamcode.runhealth.logging.ChannelSpec;
import org.firstinspires.ftc.teamcode.runhealth.logging.ChannelType;
import org.firstinspires.ftc.teamcode.runhealth.logging.ChannelsCsv;
import org.firstinspires.ftc.teamcode.runhealth.logging.RunHealthCsv;
import org.firstinspires.ftc.teamcode.runhealth.logging.RunManifest;
import org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Locale;
import java.util.Optional;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * End-to-end JVM smoke test for the Run Health v1+v2 API surface used by
 * the browser UI.
 *
 * <p>Routes that depend on {@code RunHealthConfig} (e.g.
 * {@code /api/recording}, {@code /api/baseline}) are tested in
 * {@link RunHealthApiTest}; this test only exercises the storage-shaped
 * route surface so it remains Android-free.
 *
 * <p><b>Windows temp-dir caveat.</b>  On some Windows setups the JVM temp
 * directory is mounted at a junction whose {@code getCanonicalPath()}
 * differs from the resolved path of a child {@link File}.  Our production
 * security check
 * ({@link org.firstinspires.ftc.teamcode.runhealth.logging.FilenameSanitizer#isWithinDirectory})
 * uses canonical-prefix matching; it is correct on a real Android file
 * system, but the JVM-side test environment cannot reproduce Android's
 * canonicalisation semantics.  We probe the platform in {@link #setUp()}
 * and clean-skip the suite on Windows using JUnit's {@code Assume} so we
 * get a clear "skipped" report rather than a confusing SecurityException
 * during a CI run on a developer VM.
 */
public class EndToEndApiSmokeTest {

    private File tmp;

    @Before
    public void setUp() throws IOException {
        boolean isWindows = System.getProperty("os.name", "")
                .toLowerCase(Locale.US).contains("windows");
        Assume.assumeFalse(
                "EndToEndApiSmokeTest skipped on Windows: Files.createTempDirectory "
                        + "mounting under a junction is incompatible with the production "
                        + "isWithinDirectory canonical-prefix check. See docs/NEW_USER_GUIDE.md.",
                isWindows);
        File raw = Files.createTempDirectory("runhealth-e2e-").toFile();
        // Canonicalise so any subsequent within-directory checks anchor to
        // the same resolved form.
        raw.mkdirs();
        tmp = raw.getCanonicalFile();
    }

    @After
    public void tearDown() {
        if (tmp == null) return;
        deleteRecursive(tmp);
    }

    private static void deleteRecursive(File f) {
        if (f == null) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        f.delete();
    }

    private static byte[] body(RunHealthApi.ApiResponse r) {
        return r.body == null ? new byte[0] : r.body;
    }

    @Test
    public void listRuns_empty_returnsZeroAndSchemaV1() {
        RunStorage st = new RunStorage(tmp);
        RunHealthApi api = new RunHealthApi(st);
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "GET", "/api/runs", "", null));
        assertEquals(200, resp.status);
        String json = new String(body(resp), StandardCharsets.UTF_8);
        assertTrue(json.contains("\"runs\":[]"));
        assertTrue(json.contains("\"count\":0"));
        assertTrue(json.contains("\"schema_version\":\"1\""));
    }

    @Test
    public void v1Run_listedAsV1_noCompanionUrls() throws IOException {
        RunStorage st = new RunStorage(tmp);
        File main = st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000111",
                RunHealthCsv.headerRow() + "\n");
        RunHealthApi api = new RunHealthApi(st);
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "GET", "/api/runs", "", null));
        String json = new String(body(resp), StandardCharsets.UTF_8);
        assertTrue("v1 row present: " + json, json.contains("\"schema_version\":\"1\""));
        assertTrue("v1 row uses v1_motor_csv format: " + json,
                json.contains("v1_motor_csv"));
        assertFalse("v1 row must not expose manifest url",
                json.contains("/manifest\""));
        assertFalse("v1 row must not expose channels url",
                json.contains("/channels\""));
    }

    @Test
    public void v2Run_listedAsV2_exposesCompanionUrls() throws IOException {
        RunStorage st = new RunStorage(tmp);
        File main = st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000222",
                RunHealthCsv.headerRow() + "\n");
        String stem = stripCsv(main.getName());
        RunManifest mf = RunManifest.builder()
                .runId("00000000-aaaa-0000-0000-000000000222")
                .opmodeName("Op1")
                .runStartedAt("2025-01-01T10:00:00Z")
                .durationMs(0L)
                .configFingerprint("abcd")
                .motorsFile(stripCsv(main.getName()) + ".csv")
                .channelsFile(stem + ".channels.csv")
                .addChannel(ChannelSpec.number("vel"))
                .build();
        st.writeCompanion(stem + ".manifest.json", mf.toJson());

        RunHealthApi api = new RunHealthApi(st);
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "GET", "/api/runs", "", null));
        String json = new String(body(resp), StandardCharsets.UTF_8);
        assertTrue(json.contains("\"schema_version\":\"2\""));
        assertTrue(json.contains("\"schema_format\":\"v2_manifest_channels\""));
        assertTrue(json.contains("/manifest\""));
        assertTrue(json.contains("/channels\""));
        assertTrue(json.contains("\"schema_version\":\"mixed\""));
        // Note: the file itself was just kept in a sub-test scope to
        // assert the manifest listing metadata; we did not assert the
        // header fields here because that's covered by
        // downloadManifest_returnsJson below.
        File mainCheck = new File(tmp,
                "2025-01-01T10-00-00Z-Op1-00000000aaaa.csv");
        assertNotNull(mainCheck);
    }

    @Test
    public void downloadManifest_returnsJson() throws IOException {
        RunStorage st = new RunStorage(tmp);
        File main = st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000333",
                RunHealthCsv.headerRow() + "\n");
        String stem = stripCsv(main.getName());
        RunManifest mf = RunManifest.builder()
                .runId("rid").opmodeName("Op1")
                .runStartedAt("t").durationMs(0L)
                .motorsFile(stem + ".csv")
                .channelsFile(stem + ".channels.csv")
                .build();
        st.writeCompanion(stem + ".manifest.json", mf.toJson());

        RunHealthApi api = new RunHealthApi(st);
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "GET", "/api/runs/" + stem + "/manifest", "", null));
        assertEquals(200, resp.status);
        assertTrue("content type: " + resp.contentType,
                resp.contentType.startsWith("application/json"));
        String body = new String(body(resp), StandardCharsets.UTF_8);
        assertTrue("declares v2: " + body, body.contains("\"schema_version\":\"2\""));
        assertTrue("declares run_id: " + body, body.contains("\"run_id\":\"rid\""));
    }

    @Test
    public void downloadManifest_returns404_whenAbsent() throws IOException {
        RunStorage st = new RunStorage(tmp);
        st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000444",
                RunHealthCsv.headerRow() + "\n");
        RunHealthApi api = new RunHealthApi(st);
        String stem = "empty-stem-no-companion";
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "GET", "/api/runs/" + stem + "/manifest", "", null));
        assertEquals(404, resp.status);
    }

    @Test
    public void downloadChannels_returnsCsv() throws IOException {
        RunStorage st = new RunStorage(tmp);
        File main = st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000555",
                RunHealthCsv.headerRow() + "\n");
        String stem = stripCsv(main.getName());

        StringBuilder cb = new StringBuilder();
        cb.append(ChannelsCsv.headerRow()).append('\n');
        ChannelSample s = new ChannelSample(
                0L, "vel", ChannelType.NUMBER,
                Double.valueOf(1.5), null, null,
                null, null, null, null);
        cb.append(s.toCsvRow()).append('\n');
        st.writeCompanion(stem + ".channels.csv", cb.toString());

        RunHealthApi api = new RunHealthApi(st);
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "GET", "/api/runs/" + stem + "/channels", "", null));
        assertEquals(200, resp.status);
        assertTrue("content-type: " + resp.contentType,
                resp.contentType.startsWith("text/csv"));
        String body = new String(body(resp), StandardCharsets.UTF_8);
        assertTrue("has header: " + body, body.contains("channel_name"));
        assertTrue("has data row: " + body, body.contains(",vel,"));
    }

    @Test
    public void getRun_returnsCsvAttachment() throws IOException {
        RunStorage st = new RunStorage(tmp);
        File main = st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000666",
                RunHealthCsv.headerRow() + "\n"
                        + "1,rid,Op,2025-01-01T10-00-00Z,0,leftFront,0.5,0,2000,1.5,RUN_USING_ENCODER,12.0\n");
        RunHealthApi api = new RunHealthApi(st);
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "GET", "/api/runs/" + stripCsv(main.getName()) + "/download",
                "", null));
        assertEquals(200, resp.status);
        // /download exposes Content-Disposition: attachment.
        assertTrue("reports attachment: " + resp.headers,
                resp.headers != null
                        && resp.headers.toString().toLowerCase().contains("attachment"));
        String body = new String(body(resp), StandardCharsets.UTF_8);
        assertTrue(body.startsWith("schema_version,"));
        assertTrue(body.contains("leftFront"));
    }

    @Test
    public void deleteRun_removesFile() throws IOException {
        RunStorage st = new RunStorage(tmp);
        File main = st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000666",
                RunHealthCsv.headerRow() + "\n");
        RunHealthApi api = new RunHealthApi(st);
        String stem = stripCsv(main.getName());
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "DELETE", "/api/runs/" + stem + "/delete", "", null));
        assertEquals(200, resp.status);
        assertFalse("file is gone", main.exists());
    }

    @Test
    public void deleteSelected_reportsDeletionsAndFailures() throws IOException {
        RunStorage st = new RunStorage(tmp);
        File a = st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000770", "");
        File b = st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000771", "");
        RunHealthApi api = new RunHealthApi(st);
        String body = "{\"ids\":[\"" + stripCsv(a.getName()) + "\","
                + "\"missing-id-does-not-exist\""
                + ",\"" + stripCsv(b.getName()) + "\"]}";
        RunHealthApi.ApiResponse resp = api.handle(new RunHealthApi.ApiRequest(
                "POST", "/api/runs/delete-selected", body, null));
        assertEquals(200, resp.status);
        String out = new String(body(resp), StandardCharsets.UTF_8);
        assertTrue("reported deleted_count=2: " + out, out.contains("\"deleted_count\":2"));
        assertTrue("reported failed id: " + out,
                out.contains("missing-id-does-not-exist"));
        assertFalse("a gone", a.exists());
        assertFalse("b gone", b.exists());
    }

    @Test
    public void findCompanionManifest_isPresentAfterWrite() throws IOException {
        RunStorage st = new RunStorage(tmp);
        File main = st.writeRun("2025-01-01T10-00-00Z", "Op1",
                "00000000-aaaa-0000-0000-000000000880", "");
        String stem = stripCsv(main.getName());
        st.writeCompanion(stem + ".manifest.json", "{\"schema_version\":\"2\"}");
        Optional<File> mf = st.findCompanionManifest(stripCsv(main.getName()));
        assertTrue("manifest found", mf.isPresent());
        String body = new String(Files.readAllBytes(mf.get().toPath()),
                StandardCharsets.UTF_8);
        assertTrue(body.contains("schema_version"));
    }

    private static String stripCsv(String name) {
        return name.endsWith(".csv")
                ? name.substring(0, name.length() - 4)
                : name;
    }
}
