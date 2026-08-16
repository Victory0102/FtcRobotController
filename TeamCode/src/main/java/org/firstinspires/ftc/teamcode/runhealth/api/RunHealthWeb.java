/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.api;

import android.content.Context;
import android.content.res.AssetManager;

import com.qualcomm.robotcore.util.WebHandlerManager;

import org.firstinspires.ftc.ftccommon.external.WebHandlerRegistrar;
import org.firstinspires.ftc.robotcore.internal.webserver.WebHandler;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;

/** Hooks Run Health into the FTC Robot Controller web server and serves the
 * bundled SPA plus JSON API from the APK assets. */
public final class RunHealthWeb {

    private static final String ASSET_INDEX = "runhealth/index.html";
    // Keep inline responses comfortably below the APK asset cap.
    private static final int MAX_ASSET_BYTES = 8 * 1024 * 1024;

    private RunHealthWeb() { /* utility */ }

    @WebHandlerRegistrar
    public static void registerRunHealthRoutes(Context context, WebHandlerManager webHandlerManager) {
        try {
            RunHealthWebHandler handler = new RunHealthWebHandler(context);
            for (String path : MOUNT_PATHS) {
                webHandlerManager.register(path, handler);
            }
            int assetRoutes = 0;
            String[] bundledAssets = context.getApplicationContext().getAssets()
                    .list("runhealth/assets");
            if (bundledAssets != null) {
                for (String name : bundledAssets) {
                    if (name == null || name.isEmpty()) continue;
                    webHandlerManager.register("/runhealth/assets/" + name, handler);
                    assetRoutes++;
                }
            }
            System.out.println("[RunHealthWeb] Registered "
                    + (MOUNT_PATHS.length + assetRoutes) + " Run Health routes.");
        } catch (Throwable t) {
            // Never propagate; the OpMode must continue even if registration fails.
            System.err.println("[RunHealthWeb] Registration failed: " + t);
        }
    }

    // Exact URIs the viewer requests.
    private static final String[] MOUNT_PATHS = {
            "/runhealth",                            // bare mount -> 301 to /runhealth/
            "/runhealth/",                           // index page
            "/runhealth/index.html",
            "/runhealth/styles.css",
            "/runhealth/manifest.json",
            "/runhealth/api/live/snapshot",
            "/runhealth/api/recording",
            "/runhealth/api/baseline",
            "/runhealth/api/runs",
            "/runhealth/api/runs/download-selected",
            "/runhealth/api/runs/delete-selected",
    };

    /**
     * Serves the Run Health SPA entry page and the JSON API.  One instance
     * is shared by every registered path (the web server is multi-threaded,
     * so the handler must be stateless apart from thread-safe members).
     */
    private static final class RunHealthWebHandler implements WebHandler {

        private final AssetManager assets;
        private RunHealthApi api;

        RunHealthWebHandler(Context context) {
            this.assets = context.getApplicationContext().getAssets();
        }

        // Lazy because the registrar can run before storage is ready.
        private RunHealthApi api() {
            RunHealthApi a = api;
            if (a == null) {
                api = a = new RunHealthApi();
            }
            return a;
        }

        @Override
        public NanoHTTPD.Response getResponse(NanoHTTPD.IHTTPSession session)
                throws IOException, NanoHTTPD.ResponseException {
            final String uri = session.getUri();
            if (uri == null) {
                return notFound();
            }
            if (uri.equals("/runhealth")) {
                return redirect("/runhealth/");
            }
            String rel = relative(uri);
            if (rel.isEmpty() || rel.equals("index.html")) {
                return servePage();
            }
            if (rel.equals("styles.css")) {
                return serveAsset("runhealth/styles.css", "text/css; charset=utf-8");
            }
            if (rel.equals("manifest.json")) {
                return serveAsset("runhealth/manifest.json", "application/json; charset=utf-8");
            }
            if (rel.startsWith("assets/") && isSafeAssetPath(rel)) {
                return serveAsset("runhealth/" + rel, mimeTypeFor(rel));
            }
            if (rel.startsWith("api/")) {
                return serveApi(session, "/" + rel);
            }
            return notFound();
        }

        private static boolean isSafeAssetPath(String rel) {
            return rel.indexOf("..") < 0
                    && rel.indexOf('\\') < 0
                    && rel.matches("assets/[A-Za-z0-9_.-]+");
        }

        private static String mimeTypeFor(String path) {
            if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
            if (path.endsWith(".css")) return "text/css; charset=utf-8";
            if (path.endsWith(".json") || path.endsWith(".map")) {
                return "application/json; charset=utf-8";
            }
            return "application/octet-stream";
        }

        private static String relative(String uri) {
            String p = uri;
            while (p.startsWith("/")) {
                p = p.substring(1);
            }
            if (p.equals("runhealth") || p.equals("runhealth/")) return "";
            if (p.startsWith("runhealth/")) return p.substring("runhealth/".length());
            return p;
        }

        private NanoHTTPD.Response servePage() {
            return serveAsset(ASSET_INDEX, "text/html; charset=utf-8");
        }

        private NanoHTTPD.Response serveAsset(String assetPath, String mimeType) {
            try (InputStream in = assets.open(assetPath)) {
                byte[] data = readFully(in, MAX_ASSET_BYTES);
                NanoHTTPD.Response response = NanoHTTPD.newFixedLengthResponse(
                        NanoHTTPD.Response.Status.OK, mimeType,
                        new ByteArrayInputStream(data), data.length);
                // APK updates must take effect without asking teams to clear a
                // laptop browser cache. The bundle is local and small, so
                // freshness is more valuable than asset caching here.
                response.addHeader("Cache-Control", "no-store, no-cache, must-revalidate");
                response.addHeader("Pragma", "no-cache");
                return response;
            } catch (IOException e) {
                // Keep the page responsive if the bundle is missing.
                if (ASSET_INDEX.equals(assetPath)) {
                    return toResponse(api().handle(
                            new RunHealthApi.ApiRequest("GET", "/", "", null)));
                }
                return notFound();
            }
        }

        private NanoHTTPD.Response serveApi(NanoHTTPD.IHTTPSession session, String path)
                throws IOException, NanoHTTPD.ResponseException {
            String method = session.getMethod() == null ? "GET" : session.getMethod().name();
            // NanoHTTPD body parsing is only valid for methods that can carry
            // a body. Calling parseBody() for GET can wait for bytes that will
            // never arrive on some Control Hub/Chrome combinations.
            String body = ("POST".equals(method) || "PUT".equals(method)
                    || "PATCH".equals(method)) ? readBody(session) : "";
            RunHealthApi.ApiRequest req = new RunHealthApi.ApiRequest(
                    method, path, body, firstValues(session.getParameters()));
            return toResponse(api().handle(req));
        }

        private static Map<String, String> firstValues(Map<String, java.util.List<String>> multi) {
            Map<String, String> out = new HashMap<>();
            if (multi == null) return out;
            for (Map.Entry<String, java.util.List<String>> e : multi.entrySet()) {
                java.util.List<String> v = e.getValue();
                if (v != null && !v.isEmpty()) out.put(e.getKey(), v.get(0));
            }
            return out;
        }

        // Read the request body from NanoHTTPD's parsed temp data.
        private static String readBody(NanoHTTPD.IHTTPSession session) {
            try {
                Map<String, String> files = new HashMap<>();
                session.parseBody(files);
                String postData = files.get("postData");
                if (postData != null) return postData;
                String content = files.get("content");
                if (content != null && !content.isEmpty()) {
                    try (InputStream in = new java.io.FileInputStream(
                            new java.io.File(content))) {
                        return new String(readFully(in, MAX_ASSET_BYTES), StandardCharsets.UTF_8);
                    }
                }
                return "";
            } catch (Throwable t) {
                // Malformed or absent body: the API returns a structured error.
                return "";
            }
        }

        private static NanoHTTPD.Response toResponse(RunHealthApi.ApiResponse resp) {
            NanoHTTPD.Response.Status status = NanoHTTPD.Response.Status.lookup(resp.status);
            if (status == null) {
                status = NanoHTTPD.Response.Status.INTERNAL_ERROR;
            }
            byte[] body = resp.body == null ? new byte[0] : resp.body;
            String mime = resp.contentType == null ? "text/plain; charset=utf-8" : resp.contentType;
            NanoHTTPD.Response out = NanoHTTPD.newFixedLengthResponse(
                    status, mime, new ByteArrayInputStream(body), body.length);
            for (Map.Entry<String, String> h : resp.headers.entrySet()) {
                out.addHeader(h.getKey(), h.getValue());
            }
            return out;
        }

        private static NanoHTTPD.Response redirect(String location) {
            NanoHTTPD.Response r = NanoHTTPD.newFixedLengthResponse(
                    NanoHTTPD.Response.Status.REDIRECT, "text/plain; charset=utf-8",
                    "Moved Permanently");
            r.addHeader("Location", location);
            return r;
        }

        private static NanoHTTPD.Response notFound() {
            return NanoHTTPD.newFixedLengthResponse(
                    NanoHTTPD.Response.Status.NOT_FOUND, "text/plain; charset=utf-8",
                    "Not Found");
        }

        private static byte[] readFully(InputStream in, int max) throws IOException {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > max) {
                    throw new IOException("asset exceeds size cap");
                }
            }
            return out.toByteArray();
        }
    }
}
