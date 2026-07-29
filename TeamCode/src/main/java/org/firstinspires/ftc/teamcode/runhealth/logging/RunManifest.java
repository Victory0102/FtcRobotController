/*
 * Copyright (c) 2026 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Writer-side serialiser for the v2 run manifest (companion JSON file
 * for an extended recording).  The manifest is what the browser reads
 * first when classifying a run.
 *
 * <p>Schema (key order is preserved):
 * <pre>
 * {
 *   "schema_version": "2",
 *   "spec_format": "1",
 *   "run_id": "&lt;uuid&gt;",
 *   "opmode_name": "&lt;opmode&gt;",
 *   "run_started_at": "&lt;iso8601 utc&gt;",
 *   "duration_ms": &lt;long&gt;,
 *   "build_identifier": "&lt;free text, may be empty&gt;",
 *   "robot_config": {
 *     "fingerprint": "&lt;sha-256-ish of device names&gt;",
 *     "device_names": [ ... ],
 *     "robot_name": "&lt;team-provided&gt;"
 *   },
 *   "channels": [
 *     {"name":"..."", "kind":"number|boolean|text|event|pose",
 *      "group":"...", "unit":"...", "description":"..."},
 *     ...
 *   ],
 *   "files": {
 *     "motors": "&lt;filename&gt;",
 *     "channels": "&lt;filename&gt;"
 *   },
 *   "truncated": &lt;bool&gt;
 * }
 * </pre>
 *
 * <p>The class deliberately uses the same custom JSON encoder style as
 * {@link RunHealthApi.MiniJson} to avoid pulling in any HTTP/JSON
 * dependency on Android API 24.  The output is sanitised for control
 * characters and never contains stack traces.
 */
public final class RunManifest {

    public static final String SCHEMA_VERSION = "2";

    private final Map<String, Object> data;

    private RunManifest(Map<String, Object> data) {
        this.data = data;
    }

    public static Builder builder() {
        return new Builder();
    }

    /** JSON text representation (UTF-8).  No trailing newline. */
    public String toJson() {
        return encode(data);
    }

    /** Returns the in-memory object graph (used by tests). */
    public Map<String, Object> toMap() {
        return data;
    }

    // -----------------------------------------------------------------------

    public static final class Builder {
        private String runId;
        private String opmodeName;
        private String runStartedAt;
        private long durationMs;
        private String buildIdentifier;
        private String configFingerprint;
        private final List<String> deviceNames = new ArrayList<>();
        private String robotName;
        private final List<Map<String, Object>> channels = new ArrayList<>();
        private String motorsFile;
        private String channelsFile;
        private boolean truncated;

        public Builder runId(String v) { this.runId = v; return this; }
        public Builder opmodeName(String v) { this.opmodeName = v; return this; }
        public Builder runStartedAt(String v) { this.runStartedAt = v; return this; }
        public Builder durationMs(long v) { this.durationMs = v; return this; }
        public Builder buildIdentifier(String v) { this.buildIdentifier = v == null ? "" : v; return this; }
        public Builder configFingerprint(String v) { this.configFingerprint = v; return this; }
        public Builder deviceNames(List<String> list) {
            if (list != null) deviceNames.addAll(list);
            return this;
        }
        public Builder robotName(String v) { this.robotName = v; return this; }
        public Builder addChannel(ChannelSpec spec) {
            if (spec == null) return this;
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", spec.name);
            entry.put("kind", spec.type.wireName());
            entry.put("group", spec.group == null ? "" : spec.group);
            entry.put("unit", spec.unit == null ? "" : spec.unit);
            entry.put("description", spec.description == null ? "" : spec.description);
            channels.add(entry);
            return this;
        }
        public Builder motorsFile(String v) { this.motorsFile = v; return this; }
        public Builder channelsFile(String v) { this.channelsFile = v; return this; }
        public Builder truncated(boolean v) { this.truncated = v; return this; }

        public RunManifest build() {
            Map<String, Object> root = new LinkedHashMap<>();
            root.put("schema_version", SCHEMA_VERSION);
            root.put("spec_format", "1");
            root.put("run_id", runId == null ? "" : runId);
            root.put("opmode_name", opmodeName == null ? "" : opmodeName);
            root.put("run_started_at", runStartedAt == null ? "" : runStartedAt);
            root.put("duration_ms", Long.valueOf(durationMs));
            root.put("build_identifier", buildIdentifier == null ? "" : buildIdentifier);
            root.put("truncated", Boolean.valueOf(truncated));

            Map<String, Object> cfg = new LinkedHashMap<>();
            cfg.put("fingerprint", configFingerprint == null ? "" : configFingerprint);
            cfg.put("device_names", deviceNames);
            if (robotName != null && !robotName.isEmpty()) cfg.put("robot_name", robotName);
            root.put("robot_config", cfg);

            root.put("channels", channels);

            Map<String, Object> files = new LinkedHashMap<>();
            files.put("motors", motorsFile == null ? "" : motorsFile);
            files.put("channels", channelsFile == null ? "" : channelsFile);
            root.put("files", files);
            return new RunManifest(root);
        }
    }

    // ---------- pure-JVM JSON ----------------------------------------------

    private static String encode(Object value) {
        StringBuilder sb = new StringBuilder(256);
        encodeValue(sb, value);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void encodeValue(StringBuilder sb, Object v) {
        if (v == null) { sb.append("null"); return; }
        if (v instanceof Boolean) { sb.append(((Boolean) v) ? "true" : "false"); return; }
        if (v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte) {
            sb.append(v.toString());
            return;
        }
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (!Double.isFinite(d)) { sb.append("null"); return; }
            sb.append(String.format(Locale.US, "%s", d));
            return;
        }
        if (v instanceof Map) {
            encodeObject(sb, (Map<String, Object>) v);
            return;
        }
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
        sb.append('"').append(escape(v.toString())).append('"');
    }

    private static void encodeObject(StringBuilder sb, Map<String, Object> m) {
        sb.append('{');
        boolean first = true;
        for (Map.Entry<String, Object> e : m.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append('"').append(escape(e.getKey())).append('"').append(':');
            encodeValue(sb, e.getValue());
        }
        sb.append('}');
    }

    private static String escape(String s) {
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
                    if (c < 0x20) sb.append(String.format(Locale.US, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }
}
