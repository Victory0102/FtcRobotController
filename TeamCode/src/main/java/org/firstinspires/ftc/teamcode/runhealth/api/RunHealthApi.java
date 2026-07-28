/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.api;

import org.firstinspires.ftc.teamcode.runhealth.logging.FilenameSanitizer;
import org.firstinspires.ftc.teamcode.runhealth.logging.RunHealthConfig;
import org.firstinspires.ftc.teamcode.runhealth.logging.RunHealthCsv;
import org.firstinspires.ftc.teamcode.runhealth.logging.RunStorage;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * Pure-Java HTTP-style API for Run Health.  No dependency on the FTC SDK;
 * a thin Run Health web registration shim invokes this through reflection
 * so we are not coupled to any specific {@code WebHandler} interface
 * signature.
 *
 * <p>Requests and responses are simple {@code Map<String,String>} plus
 * an {@code InputStream} for body handling.  This keeps the API easy to
 * unit-test without an Android device.
 *
 * <p>Security:
 * <ul>
 *     <li>Every run id is sanitized and verified to lie inside the
 *         {@code runs/} directory using
 *         {@link FilenameSanitizer#isWithinDirectory(File, File)}.</li>
 *     <li>No request body is ever executed; we only parse JSON ourselves.</li>
 *     <li>Stack traces are never returned to the client.  Structured
 *         {@code {"error":...,"message":...,"code":...}} JSON is emitted.</li>
 *     <li>All file operations touch only the Run Health storage.</li>
 * </ul>
 */
public final class RunHealthApi {

    /** Byte threshold above which we recommend users download/delete runs. */
    public static final long LARGE_STORAGE_BYTES = 50L * 1024 * 1024;

    private final RunStorage storage;

    public RunHealthApi() {
        this(new RunStorage());
    }

    public RunHealthApi(RunStorage storage) {
        this.storage = storage;
    }

    // -------------------------------------------------------------- routing

    public ApiResponse handle(ApiRequest req) {
        try {
            String path = req.path == null ? "" : req.path;
            String method = req.method == null ? "GET" : req.method.toUpperCase(Locale.US);

            if (path.equals("/") || path.equals("/index.html") || path.isEmpty()) {
                return serveIndex();
            }
            if (path.startsWith("/assets/")) {
                return notFound("Unknown asset", path);
            }

            if (path.equals("/api/recording")) {
                if ("GET".equals(method)) return getRecordingMode();
                if ("PUT".equals(method) || "POST".equals(method)) return setRecordingMode(req);
                return methodNotAllowed();
            }
            if (path.equals("/api/baseline")) {
                if ("GET".equals(method)) return getBaseline();
                if ("PUT".equals(method) || "POST".equals(method)) return setBaseline(req);
                if ("DELETE".equals(method)) return clearBaseline();
                return methodNotAllowed();
            }
            if (path.equals("/api/runs")) {
                if ("GET".equals(method)) return listRuns(req);
                return methodNotAllowed();
            }
            if (path.equals("/api/runs/download-selected")) {
                if ("POST".equals(method)) return notImplemented();
                return methodNotAllowed();
            }
            if (path.equals("/api/runs/delete-selected")) {
                if ("POST".equals(method)) return deleteSelected(req);
                return methodNotAllowed();
            }

            // /api/runs/{id}/{action}
            Map<String, String> segs = splitRunSegments(path);
            if (segs == null) {
                return notFound("Unknown path", path);
            }
            String action = segs.get("action");
            String runId = segs.get("id");
            if (action == null) {
                if ("GET".equals(method)) return getRun(runId);
                return methodNotAllowed();
            }
            if (action.equals("download")) {
                if ("GET".equals(method)) return downloadRun(runId);
                return methodNotAllowed();
            }
            if (action.startsWith("delete")) {
                if ("DELETE".equals(method) || "POST".equals(method)) return deleteRun(runId);
                return methodNotAllowed();
            }
            return notFound("Unknown run action", action);
        } catch (Throwable t) {
            return ApiResponse.jsonError(500, "Internal error", "internal_error", safeMessage(t));
        }
    }

    private static Map<String, String> splitRunSegments(String path) {
        // Expected forms:
        //   /api/runs/<id>
        //   /api/runs/<id>/download
        //   /api/runs/<id>/delete
        String[] parts = path.split("/");
        // ['', 'api', 'runs', '<id>', '<action>?]
        if (parts.length < 4 || !"api".equals(parts[1]) || !"runs".equals(parts[2])) return null;
        Map<String, String> out = new LinkedHashMap<>();
        out.put("id", parts[3]);
        if (parts.length >= 5) out.put("action", parts[4]);
        return out;
    }

    // -------------------------------------------------------------- handlers

    private ApiResponse serveIndex() {
        // The browser UI is served from TeamCode assets; this fallback HTML
        // is returned if the bundled assets file is unavailable for any
        // reason.  It links to /api/runs for content.
        String html = "<!doctype html><html><head><meta charset=\"utf-8\">"
                + "<title>FTC Run Health</title></head>"
                + "<body><h1>FTC Run Health</h1>"
                + "<p>The browser UI assets are not bundled. "
                + "Use the JSON API at <a href=\"/api/runs\">/api/runs</a>.</p>"
                + "</body></html>";
        return ApiResponse.html(html);
    }

    private ApiResponse getRecordingMode() {
        Map<String, Object> obj = new LinkedHashMap<>();
        obj.put("mode", RunHealthConfig.getRecordingMode());
        return ApiResponse.jsonObject(obj);
    }

    private ApiResponse setRecordingMode(ApiRequest req) {
        String mode = req.jsonString("mode");
        if (mode == null) return ApiResponse.jsonError(400, "Missing 'mode'", "bad_request", "field 'mode' required");
        switch (mode) {
            case RunHealthConfig.MODE_OFF:
            case RunHealthConfig.MODE_NEXT:
            case RunHealthConfig.MODE_EVERY:
                break;
            default:
                return ApiResponse.jsonError(400, "Unknown mode", "bad_request", "mode must be OFF, NEXT, or EVERY");
        }
        RunHealthConfig.setRecordingMode(mode);
        return getRecordingMode();
    }

    private ApiResponse getBaseline() {
        Map<String, Object> obj = new LinkedHashMap<>();
        String id = RunHealthConfig.getBaselineRunId();
        obj.put("run_id", id);
        obj.put("available", id != null && storage.findRunById(id) != null);
        return ApiResponse.jsonObject(obj);
    }

    private ApiResponse setBaseline(ApiRequest req) {
        String id = req.jsonString("run_id");
        if (id == null || id.isEmpty()) {
            return ApiResponse.jsonError(400, "Missing 'run_id'", "bad_request", "field 'run_id' required");
        }
        // Validate the run id (or file basename) is actually a saved run.
        File f = storage.findRunById(id);
        if (f == null) {
            return ApiResponse.jsonError(404, "Run not found", "not_found", "no saved run with id " + id);
        }
        String safeId = stripCsv(f.getName());
        RunHealthConfig.setBaselineRunId(safeId);
        return getBaseline();
    }

    private ApiResponse clearBaseline() {
        RunHealthConfig.setBaselineRunId(null);
        return getBaseline();
    }

    private ApiResponse listRuns(ApiRequest req) {
        List<Map<String, Object>> rows = new ArrayList<>();
        long totalBytes = 0;
        for (File f : storage.listRuns()) {
            boolean truncated = isTruncatedRun(f.getName());
            Map<String, Object> row = new LinkedHashMap<>();
            String id = stripCsv(f.getName());
            row.put("run_id", id);
            row.put("filename", f.getName());
            row.put("size_bytes", f.length());
            row.put("last_modified_ms", f.lastModified());
            row.put("truncated", truncated);
            row.put("schema_version", RunHealthCsv.SCHEMA_VERSION);
            row.put("url_download", "/api/runs/" + id + "/download");
            row.put("url_delete", "/api/runs/" + id + "/delete");
            rows.add(row);
            totalBytes += f.length();
        }
        Map<String, Object> obj = new LinkedHashMap<>();
        obj.put("runs", rows);
        obj.put("count", rows.size());
        obj.put("total_bytes", totalBytes);
        obj.put("warning_large", totalBytes > LARGE_STORAGE_BYTES);
        obj.put("storage_root", storage.rootDirectory().getAbsolutePath());
        obj.put("schema_version", RunHealthCsv.SCHEMA_VERSION);
        return ApiResponse.jsonObject(obj);
    }

    private ApiResponse getRun(String runId) {
        if (runId == null) return ApiResponse.jsonError(400, "Missing run id", "bad_request", "");
        File f = storage.findRunById(runId);
        if (f == null) {
            return ApiResponse.jsonError(404, "Run not found", "not_found", runId);
        }
        try {
            // Cap at 32 MB; treat larger files as errors so a single request
            // cannot exhaust the heap. The Run Health route is a Control-Hub
            // internal endpoint, not a streaming proxy.
            long size = f.length();
            if (size > MAX_INLINED_BYTES) {
                return ApiResponse.jsonError(413, "Run too large for inline read", "too_large",
                        "size_bytes=" + size + " limit=" + MAX_INLINED_BYTES);
            }
            byte[] data = new byte[(int) size];
            int off = 0;
            try (java.io.InputStream in = java.nio.file.Files.newInputStream(f.toPath())) {
                while (off < data.length) {
                    int n = in.read(data, off, data.length - off);
                    if (n < 0) break;
                    off += n;
                }
            }
            return ApiResponse.csv(java.util.Arrays.copyOf(data, off),
                    isTruncatedRun(f.getName()));
        } catch (IOException e) {
            return ApiResponse.jsonError(500, "Failed to read run", "io_error", safeMessage(e));
        }
    }

    private ApiResponse downloadRun(String runId) {
        if (runId == null) return ApiResponse.jsonError(400, "Missing run id", "bad_request", "");
        File f = storage.findRunById(runId);
        if (f == null) {
            return ApiResponse.jsonError(404, "Run not found", "not_found", runId);
        }
        try {
            // Stream the file in 8 KB chunks, capping at MAX_INLINED_BYTES.
            // For runs larger than the cap we surface the same error as getRun
            // because the FTC SDK does not expose a chunked-response API for
            // arbitrary input sizes.
            long size = f.length();
            if (size > MAX_INLINED_BYTES) {
                return ApiResponse.jsonError(413, "Run too large for inline download", "too_large",
                        "size_bytes=" + size + " limit=" + MAX_INLINED_BYTES);
            }
            byte[] data = new byte[(int) size];
            int off = 0;
            try (java.io.InputStream in = java.nio.file.Files.newInputStream(f.toPath())) {
                while (off < data.length) {
                    int n = in.read(data, off, data.length - off);
                    if (n < 0) break;
                    off += n;
                }
            }
            return ApiResponse.attachment(f.getName(), "text/csv",
                    java.util.Arrays.copyOf(data, off), isTruncatedRun(f.getName()));
        } catch (IOException e) {
            return ApiResponse.jsonError(500, "Failed to stream run", "io_error", safeMessage(e));
        }
    }

    /** Documented limit on inlined responses (same value used by get/run/download). */
    private static final int MAX_INLINED_BYTES = 32 * 1024 * 1024;

    /** Returns true if a stored file name corresponds to a truncated run. */
    private static boolean isTruncatedRun(String filename) {
        if (filename == null) return false;
        if (filename.endsWith(".csv")) {
            String stem = filename.substring(0, filename.length() - 4);
            // Names look like <ts>-<opmode>-truncated-<id>.csv; check trailing segments.
            return stem.endsWith("-truncated")
                    || stem.contains("-truncated-");
        }
        return false;
    }

    private ApiResponse deleteRun(String runId) {
        if (runId == null) return ApiResponse.jsonError(400, "Missing run id", "bad_request", "");
        // Validate it first.
        File f = storage.findRunById(runId);
        if (f == null) {
            return ApiResponse.jsonError(404, "Run not found", "not_found", runId);
        }
        // If this run was the baseline, clear the baseline.
        String baseline = RunHealthConfig.getBaselineRunId();
        if (baseline != null && baseline.equals(stripCsv(f.getName()))) {
            RunHealthConfig.setBaselineRunId(null);
        }
        boolean ok = storage.deleteRun(runId);
        if (!ok) {
            return ApiResponse.jsonError(500, "Could not delete run", "delete_failed", runId);
        }
        Map<String, Object> obj = new LinkedHashMap<>();
        obj.put("deleted", runId);
        obj.put("baseline_cleared", baseline != null && baseline.equals(stripCsv(f.getName())));
        return ApiResponse.jsonObject(obj);
    }

    private ApiResponse deleteSelected(ApiRequest req) {
        List<String> ids = req.jsonStringList("ids");
        if (ids == null || ids.isEmpty()) {
            // Special case: empty list is idempotent success.
            Map<String, Object> obj = new LinkedHashMap<>();
            obj.put("deleted_count", 0);
            obj.put("requested_count", 0);
            return ApiResponse.jsonObject(obj);
        }
        // Dedupe defensively.
        List<String> unique = new ArrayList<>(new java.util.LinkedHashSet<>(ids));
        int requested = unique.size();
        String baseline = RunHealthConfig.getBaselineRunId();
        int deleted = 0;
        List<String> failed = new ArrayList<>();
        boolean baselineCleared = false;
        for (String id : unique) {
            try {
                File f = storage.findRunById(id);
                if (f == null) {
                    failed.add(id);
                    continue;
                }
                if (baseline != null && baseline.equals(stripCsv(f.getName()))) {
                    baselineCleared = true;
                }
                if (storage.deleteRun(id)) {
                    deleted++;
                } else {
                    failed.add(id);
                }
            } catch (Throwable t) {
                failed.add(id);
            }
        }
        if (baselineCleared) {
            // The API caller may have deleted some but not all; we only clear
            // the baseline if the deleted list actually deleted it.
            if (findRunOrNull(storage, baseline) == null) {
                RunHealthConfig.setBaselineRunId(null);
            }
        }
        Map<String, Object> obj = new LinkedHashMap<>();
        obj.put("deleted_count", deleted);
        obj.put("requested_count", requested);
        obj.put("failed", failed);
        obj.put("baseline_cleared", baselineCleared);
        return ApiResponse.jsonObject(obj);
    }

    private ApiResponse notImplemented() {
        return ApiResponse.jsonError(501, "Not implemented", "not_implemented",
                "Downloading multiple runs as a ZIP is not supported in this MVP; "
                        + "download each run individually.");
    }

    // -------------------------------------------------------------- helpers

    private static ApiResponse methodNotAllowed() {
        return ApiResponse.jsonError(405, "Method not allowed", "method_not_allowed", "");
    }

    private static ApiResponse notFound(String message, String detail) {
        return ApiResponse.jsonError(404, message, "not_found", detail);
    }

    private static String safeMessage(Throwable t) {
        if (t == null) return "";
        String m = t.getMessage();
        return m == null ? t.getClass().getSimpleName() : m;
    }

    private static String stripCsv(String name) {
        if (name == null) return "";
        return name.endsWith(".csv")
                ? name.substring(0, name.length() - 4)
                : name;
    }

    /** Helper for the deleteSelected baseline logic. */
    private static File findRunOrNull(RunStorage store, String id) {
        return store == null || id == null ? null : store.findRunById(id);
    }

    // -------------------------------------------------------------- request/response

    /** Request handed to the API by the web registration shim. */
    public static final class ApiRequest {
        public final String method;     // GET/POST/PUT/DELETE
        public final String path;       // e.g. "/api/runs/<id>/download"
        public final String body;       // raw body, UTF-8 text; empty if none
        public final Map<String, String> queryParams;

        public ApiRequest(String method, String path, String body, Map<String, String> queryParams) {
            this.method = method;
            this.path = path;
            this.body = body == null ? "" : body;
            this.queryParams = queryParams == null ? Collections.emptyMap() : queryParams;
        }

        /** Minimal JSON string extractor; used to keep the API dependency-free. */
        public String jsonString(String field) {
            return MiniJson.extractString(body, field);
        }

        /** Extract {@code ids: ["a","b"]} into a list. */
        public List<String> jsonStringList(String field) {
            return MiniJson.extractStringArray(body, field);
        }
    }

    /**
     * Lightweight response wrapper.  We avoid external JSON libraries so the
     * API compiles against Android API level 24 with no extra deps.
     */
    public static final class ApiResponse {

        public final int status;
        public final String contentType;
        public final byte[] body;
        public final Map<String, String> headers;

        private ApiResponse(int status, String contentType, byte[] body, Map<String, String> headers) {
            this.status = status;
            this.contentType = contentType;
            this.body = body == null ? new byte[0] : body;
            this.headers = headers == null ? Collections.emptyMap() : headers;
        }

        public static ApiResponse jsonObject(Map<String, Object> obj) {
            byte[] b = MiniJson.encodeObject(obj).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            return new ApiResponse(200, "application/json; charset=utf-8", b, null);
        }

        public static ApiResponse jsonError(int status, String message, String code, String detail) {
            Map<String, Object> obj = new LinkedHashMap<>();
            obj.put("error", message);
            obj.put("code", code);
            if (detail != null && !detail.isEmpty()) obj.put("detail", detail);
            return jsonObject(obj);
        }

        public static ApiResponse html(String html) {
            return new ApiResponse(200, "text/html; charset=utf-8",
                    html.getBytes(java.nio.charset.StandardCharsets.UTF_8), null);
        }

        public static ApiResponse csv(byte[] data, boolean truncated) {
            Map<String, String> h = new LinkedHashMap<>();
            h.put("X-Run-Health-Schema", RunHealthCsv.SCHEMA_VERSION);
            h.put("X-Run-Health-Truncated", truncated ? "1" : "0");
            return new ApiResponse(200, "text/csv; charset=utf-8", data, h);
        }

        public static ApiResponse attachment(String filename, String contentType, byte[] data, boolean truncated) {
            Map<String, String> h = new LinkedHashMap<>();
            h.put("Content-Disposition", "attachment; filename=\"" + sanitizeHeader(filename) + "\"");
            h.put("X-Run-Health-Schema", RunHealthCsv.SCHEMA_VERSION);
            h.put("X-Run-Health-Truncated", truncated ? "1" : "0");
            return new ApiResponse(200, contentType, data, h);
        }

        private static String sanitizeHeader(String s) {
            if (s == null) return "run.csv";
            // Strip CR/LF and quotes; keep path-segment characters.
            StringBuilder sb = new StringBuilder(s.length());
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c > 0x20 && c != '"' && c != '\\') sb.append(c);
            }
            return sb.toString();
        }
    }

    // -------------------------------------------------------------- tiny JSON

    /**
     * Minimal JSON helpers so we keep the API self-contained.  Supports
     * strings, numbers, booleans, null, objects and arrays.  Sufficient
     * for our request/response payloads.
     *
     * <p>The parser is hardened against:
     * <ul>
     *     <li>Truncated input (any malformed input yields {@code null},
     *         never throws to the caller).</li>
     *     <li>Unknown characters (the parser advances one byte at a
     *         time and finally returns {@code END}; it never loops
     *         infinitely).</li>
     *     <li>peek() / rewind() semantics implemented with a saved
     *         position instead of token-by-token rewind.</li>
     * </ul>
     */
    static final class MiniJson {

        enum Tk { STR, NUM, BOOL, NULL, LBRACE, RBRACE, LBRACKET, RBRACKET, COMMA, COLON, END }

        static String extractString(String body, String field) {
            try {
                Parser p = new Parser(body);
                p.skipValue();
                if (p.peek().type != Tk.LBRACE) return null;
                p.consume(Tk.LBRACE);
                while (true) {
                    p.skipValue();
                    Tk next = p.peekType();
                    if (next == Tk.RBRACE) return null;
                    Token k = p.consume(Tk.STR);
                    if (field.equals(k.text)) {
                        p.consume(Tk.COLON);
                        p.skipValue();
                        Token v = p.consumeAny();
                        if (v.type == Tk.STR) return v.text;
                        return null;
                    }
                    p.consume(Tk.COLON);
                    p.skipValue();
                    p.consumeAny();
                    Tk sep = p.peekType();
                    if (sep == Tk.RBRACE) return null;
                    if (sep == Tk.COMMA) p.consume(Tk.COMMA);
                }
            } catch (Throwable t) {
                return null;
            }
        }

        static List<String> extractStringArray(String body, String field) {
            try {
                Parser p = new Parser(body);
                p.skipValue();
                if (p.peek().type != Tk.LBRACE) return null;
                p.consume(Tk.LBRACE);
                while (true) {
                    p.skipValue();
                    Tk next = p.peekType();
                    if (next == Tk.RBRACE) return null;
                    Token k = p.consume(Tk.STR);
                    if (field.equals(k.text)) {
                        p.consume(Tk.COLON);
                        p.skipValue();
                        Token v = p.consumeAny();
                        if (v.type != Tk.LBRACKET) return null;
                        List<String> list = new ArrayList<>();
                        Tk peek2 = p.peekType();
                        if (peek2 == Tk.RBRACKET) {
                            p.consume(Tk.RBRACKET);
                            return list;
                        }
                        while (true) {
                            p.skipValue();
                            Token item = p.consumeAny();
                            if (item.type == Tk.STR) list.add(item.text);
                            Tk endPeek = p.peekType();
                            if (endPeek == Tk.RBRACKET) {
                                p.consume(Tk.RBRACKET);
                                return list;
                            }
                            if (endPeek == Tk.COMMA) p.consume(Tk.COMMA);
                            else return list;
                        }
                    }
                    p.consume(Tk.COLON);
                    p.skipValue();
                    p.consumeAny();
                    Tk sep = p.peekType();
                    if (sep == Tk.RBRACE) return null;
                    if (sep == Tk.COMMA) p.consume(Tk.COMMA);
                }
            } catch (Throwable t) {
                return null;
            }
        }

        static String encodeObject(Map<String, Object> obj) {
            StringBuilder sb = new StringBuilder(64);
            encodeObject(sb, obj);
            return sb.toString();
        }

        private static void encodeObject(StringBuilder sb, Map<String, Object> m) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : m.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append('"').append(escapeString(e.getKey())).append('"').append(':');
                encodeValue(sb, e.getValue());
            }
            sb.append('}');
        }

        @SuppressWarnings("unchecked")
        private static void encodeValue(StringBuilder sb, Object v) {
            if (v == null) { sb.append("null"); return; }
            if (v instanceof Boolean) { sb.append(((Boolean) v) ? "true" : "false"); return; }
            if (v instanceof Number) {
                double d = ((Number) v).doubleValue();
                if (Double.isNaN(d) || Double.isInfinite(d)) { sb.append("null"); return; }
                if (v instanceof Long || v instanceof Integer) {
                    sb.append(v.toString());
                } else {
                    sb.append(String.format(Locale.US, "%.6f", d));
                }
                return;
            }
            if (v instanceof Map) { encodeObject(sb, (Map<String, Object>) v); return; }
            if (v instanceof List) {
                sb.append('[');
                boolean first = true;
                for (Object item : (List<?>) v) {
                    if (!first) sb.append(',');
                    first = false;
                    encodeValue(sb, item);
                }
                sb.append(']');
                return;
            }
            sb.append('"').append(escapeString(v.toString())).append('"');
        }

        private static String escapeString(String s) {
            StringBuilder sb = new StringBuilder(s.length() + 4);
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': sb.append("\\\""); break;
                    case '\\': sb.append("\\\\"); break;
                    case '\n': sb.append("\\n"); break;
                    case '\r': sb.append("\\r"); break;
                    case '\t': sb.append("\\t"); break;
                    default:
                        if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                        else sb.append(c);
                }
            }
            return sb.toString();
        }

        // ---------------------- tokenizer ----------------------

        static final class Token {
            final Tk type; final String text;
            Token(Tk t, String s) { this.type = t; this.text = s; }
            @Override public String toString() { return type + (text == null ? "" : "(" + text + ")"); }
        }

        static final class Parser {
            private final String src;
            private int i;
            private int peekPos = -1;
            private Token peeked;
            Parser(String src) { this.src = src == null ? "" : src; }
            Tk peekType() { return peek().type; }
            Token peek() {
                if (peeked != null) return peeked;
                peekPos = i;
                peeked = next();
                return peeked;
            }
            Token consume(Tk expected) {
                Token t = next();
                if (t.type != expected) {
                    throw new IllegalStateException("want " + expected + " got " + t);
                }
                return t;
            }
            Token consumeAny() { return next(); }
            void skipValue() {
                Token t = next();
                if (t.type == Tk.LBRACE) skipBalanced(Tk.LBRACE, Tk.RBRACE);
                else if (t.type == Tk.LBRACKET) skipBalanced(Tk.LBRACKET, Tk.RBRACKET);
            }
            private void skipBalanced(Tk open, Tk close) {
                int depth = 1;
                while (depth > 0) {
                    Token t = next();
                    if (t.type == Tk.END) return;
                    if (t.type == open) depth++;
                    else if (t.type == close) depth--;
                }
            }
            private Token next() {
                // Reuse peeked token if any.
                if (peeked != null) {
                    Token t = peeked;
                    peeked = null;
                    peekPos = -1;
                    return t;
                }
                String s = src;
                int start = i;
                while (i < s.length()) {
                    char c = s.charAt(i);
                    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { i++; start = i; continue; }
                    if (c == '"') {
                        int j = i + 1; StringBuilder b = new StringBuilder();
                        boolean ok = true;
                        while (j < s.length()) {
                            char d = s.charAt(j);
                            if (d == '\\') {
                                if (j + 1 >= s.length()) { ok = false; break; }
                                char e = s.charAt(j + 1);
                                switch (e) {
                                    case '"': b.append('"');  break;
                                    case '\\': b.append('\\'); break;
                                    case '/': b.append('/'); break;
                                    case 'b': b.append('\b'); break;
                                    case 'f': b.append('\f'); break;
                                    case 'n': b.append('\n'); break;
                                    case 'r': b.append('\r'); break;
                                    case 't': b.append('\t'); break;
                                    case 'u':
                                        if (j + 5 >= s.length()) { ok = false; break; }
                                        String hex = s.substring(j + 2, j + 6);
                                        try { b.append((char) Integer.parseInt(hex, 16)); }
                                        catch (NumberFormatException ex) { b.append('?'); }
                                        j += 4;
                                        break;
                                    default: b.append(e);
                                }
                                j += 2;
                                continue;
                            } else if (d == '"') {
                                i = j + 1;
                                return new Token(Tk.STR, b.toString());
                            } else {
                                b.append(d);
                                j++;
                            }
                        }
                        if (!ok) {
                            i = s.length();
                            return new Token(Tk.STR, b.toString());
                        }
                        i = s.length();
                        return new Token(Tk.STR, b.toString());
                    }
                    if (c == '{') { i++; return new Token(Tk.LBRACE, "{"); }
                    if (c == '}') { i++; return new Token(Tk.RBRACE, "}"); }
                    if (c == '[') { i++; return new Token(Tk.LBRACKET, "["); }
                    if (c == ']') { i++; return new Token(Tk.RBRACKET, "]"); }
                    if (c == ',') { i++; return new Token(Tk.COMMA, ","); }
                    if (c == ':') { i++; return new Token(Tk.COLON, ":"); }
                    if (c == '-' || (c >= '0' && c <= '9')) {
                        int j = i; boolean isFloat = false;
                        if (c == '-') j++;
                        while (j < s.length()) {
                            char d = s.charAt(j);
                            if ((d >= '0' && d <= '9')) { j++; continue; }
                            if (d == '.' || d == 'e' || d == 'E' || d == '+' || d == '-') { isFloat = true; j++; continue; }
                            break;
                        }
                        String num = s.substring(i, j);
                        i = j;
                        if (!isFloat) {
                            if (num.equals("true")) return new Token(Tk.BOOL, "true");
                            if (num.equals("false")) return new Token(Tk.BOOL, "false");
                            if (num.equals("null")) return new Token(Tk.NULL, "null");
                        }
                        return new Token(Tk.NUM, num);
                    }
                    if (s.startsWith("true", i)) { i += 4; return new Token(Tk.BOOL, "true"); }
                    if (s.startsWith("false", i)) { i += 5; return new Token(Tk.BOOL, "false"); }
                    if (s.startsWith("null", i)) { i += 4; return new Token(Tk.NULL, "null"); }
                    i++;
                }
                if (start != i) i = start;
                return new Token(Tk.END, "");
            }
        }
    }
}
