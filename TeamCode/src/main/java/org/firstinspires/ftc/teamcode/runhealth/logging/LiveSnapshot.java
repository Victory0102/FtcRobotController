/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Immutable bounded live-snapshot POJO consumed by the read-only
 * {@code GET /api/live/snapshot} endpoint.
 *
 * <p>Contract enforced by design (not by convention):
 * <ul>
 *   <li>Every numeric/double/long field is nullable so we can preserve
 *       "missing" rather than coercing to zero.  The browser treats
 *       JSON {@code null} as "no measured value" and never as 0.</li>
 *   <li>Lists are unmodifiable.  Constructors defensively copy.</li>
 *   <li>{@link #encodeMap()} always returns the same logical shape,
 *       independent of which sub-fields are populated.</li>
 *   <li>The {@link Factory} settable builder is the only sanctioned way
 *       to produce an instance; it never throws on partial input.</li>
 * </ul>
 *
 * <p>No setter reference is reachable from any UI / API / tester thread:
 * the public factory returns a fully built immutable instance in one
 * step, so once a reference is assigned to
 * {@link LiveSnapshotRegistry#latest} no other thread can see a
 * half-built state.
 */
public final class LiveSnapshot {

    public final boolean active;
    public final String sessionId;        // nullable
    public final String opMode;           // nullable
    public final String recordingMode;    // nullable
    public final long sequence;
    public final long timestampMs;
    public final long elapsedMs;
    public final Double batteryVoltage;   // nullable
    public final Double loopTimeMs;       // nullable
    public final List<MotorView> motors;
    public final List<ChannelView> channels;
    public final List<EventView> events;

    private LiveSnapshot(boolean active,
                         String sessionId,
                         String opMode,
                         String recordingMode,
                         long sequence,
                         long timestampMs,
                         long elapsedMs,
                         Double batteryVoltage,
                         Double loopTimeMs,
                         List<MotorView> motors,
                         List<ChannelView> channels,
                         List<EventView> events) {
        this.active = active;
        this.sessionId = sessionId;
        this.opMode = opMode;
        this.recordingMode = recordingMode;
        this.sequence = sequence;
        this.timestampMs = timestampMs;
        this.elapsedMs = elapsedMs;
        this.batteryVoltage = batteryVoltage;
        this.loopTimeMs = loopTimeMs;
        this.motors = motors == null ? Collections.emptyList()
                : Collections.unmodifiableList(new ArrayList<>(motors));
        this.channels = channels == null ? Collections.emptyList()
                : Collections.unmodifiableList(new ArrayList<>(channels));
        this.events = events == null ? Collections.emptyList()
                : Collections.unmodifiableList(new ArrayList<>(events));
    }

    /**
     * Returns a snapshot encoding-safe Map.  Missing values emit
     * {@code null} (which {@link org.firstinspires.ftc.teamcode.runhealth.api.RunHealthApi.MiniJson#encodeValue(StringBuilder, Object)}
     * serialises as {@code null}); never 0.
     */
    public Map<String, Object> encodeMap() {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("schema_version", 1);
        root.put("active", active);
        root.put("session_id", sessionId);
        root.put("op_mode", opMode);
        root.put("recording_mode", recordingMode);
        root.put("sequence", sequence);
        root.put("timestamp_ms", timestampMs);
        root.put("elapsed_ms", elapsedMs);
        root.put("battery_voltage", batteryVoltage);
        root.put("loop_time_ms", loopTimeMs);

        List<Map<String, Object>> ms = new ArrayList<>();
        for (MotorView mv : motors) {
            Map<String, Object> j = new LinkedHashMap<>();
            j.put("device_name", mv.deviceName);
            j.put("power", mv.power);
            j.put("velocity_ticks_per_second", mv.velocity);
            j.put("current_amps", mv.currentAmps);
            j.put("mode", mv.mode);
            ms.add(j);
        }
        root.put("motors", ms);

        List<Map<String, Object>> cs = new ArrayList<>();
        for (ChannelView cv : channels) {
            Map<String, Object> j = new LinkedHashMap<>();
            j.put("name", cv.name);
            j.put("kind", cv.kind);
            j.put("value_number", cv.valueNumber);
            j.put("value_boolean", cv.valueBoolean);
            j.put("value_text", cv.valueText);
            j.put("pose_x", cv.poseX);
            j.put("pose_y", cv.poseY);
            j.put("pose_heading", cv.poseHeading);
            j.put("unit", cv.unit);
            j.put("group", cv.group);
            j.put("description", cv.description);
            cs.add(j);
        }
        root.put("channels", cs);

        List<Map<String, Object>> es = new ArrayList<>();
        for (EventView ev : events) {
            Map<String, Object> j = new LinkedHashMap<>();
            j.put("timestamp_ms", ev.timestampMs);
            j.put("label", ev.label);
            es.add(j);
        }
        root.put("events", es);
        return root;
    }

    public static final class Factory {
        private boolean active = true;
        private String sessionId;
        private String opMode;
        private String recordingMode;
        private long sequence;
        private long timestampMs;
        private long elapsedMs;
        private Double batteryVoltage;
        private Double loopTimeMs;
        private final List<MotorView> motors = new ArrayList<>();
        private final List<ChannelView> channels = new ArrayList<>();
        private final List<EventView> events = new ArrayList<>();

        public Factory active(boolean v) { this.active = v; return this; }
        public Factory sessionId(String v) { this.sessionId = v; return this; }
        public Factory opMode(String v) { this.opMode = v; return this; }
        public Factory recordingMode(String v) { this.recordingMode = v; return this; }
        public Factory sequence(long v) { this.sequence = v; return this; }
        public Factory timestampMs(long v) { this.timestampMs = v; return this; }
        public Factory elapsedMs(long v) { this.elapsedMs = v; return this; }
        public Factory batteryVoltage(Double v) { this.batteryVoltage = v; return this; }
        public Factory loopTimeMs(Double v) { this.loopTimeMs = v; return this; }
        public Factory addMotor(MotorView v) { if (v != null) motors.add(v); return this; }
        public Factory addChannel(ChannelView v) { if (v != null) channels.add(v); return this; }
        public Factory addEvent(EventView v) { if (v != null) events.add(v); return this; }

        public LiveSnapshot build() {
            return new LiveSnapshot(active, sessionId, opMode, recordingMode,
                    sequence, timestampMs, elapsedMs, batteryVoltage, loopTimeMs,
                    motors, channels, events);
        }
    }

    public static LiveSnapshot empty(long sequence, long timestampMs) {
        return new Factory()
                .active(false)
                .sequence(sequence)
                .timestampMs(timestampMs)
                .elapsedMs(0L)
                .build();
    }

    /**
     * Inner view record for a single motor.  Every measurable field is
     * nullable; {@link #deviceName} is always present.
     */
    public static final class MotorView {
        public final String deviceName;
        public final Double power;
        public final Double velocity;
        public final Double currentAmps;
        public final String mode;

        public MotorView(String deviceName, Double power, Double velocity,
                         Double currentAmps, String mode) {
            this.deviceName = deviceName;
            this.power = power;
            this.velocity = velocity;
            this.currentAmps = currentAmps;
            this.mode = mode;
        }
    }

    /**
     * Inner view record for a single channel sample.  {@link #name} and
     * {@link #kind} are always present; everything else is nullable.
     * {@code kind} is one of {@code number|boolean|text|pose|event}.
     */
    public static final class ChannelView {
        public final String name;
        public final String kind;
        public final Double valueNumber;
        public final Boolean valueBoolean;
        public final String valueText;
        public final Double poseX;
        public final Double poseY;
        public final Double poseHeading;
        public final String unit;
        public final String group;
        public final String description;

        public ChannelView(String name, String kind,
                           Double valueNumber, Boolean valueBoolean, String valueText,
                           Double poseX, Double poseY, Double poseHeading,
                           String unit, String group, String description) {
            this.name = name;
            this.kind = (kind == null) ? "number" : kind;
            this.valueNumber = valueNumber;
            this.valueBoolean = valueBoolean;
            this.valueText = valueText;
            this.poseX = poseX;
            this.poseY = poseY;
            this.poseHeading = poseHeading;
            this.unit = unit;
            this.group = group;
            this.description = description;
        }
    }

    public static final class EventView {
        public final long timestampMs;
        public final String label;
        public EventView(long timestampMs, String label) {
            this.timestampMs = timestampMs;
            this.label = label == null ? "" : label;
        }
    }

    /** One-line diagnostic for RobotLog. */
    public String summarise(Locale locale) {
        return String.format(locale,
                "snap[active=%b seq=%d t=%d motors=%d channels=%d events=%d]",
                active, sequence, timestampMs, motors.size(), channels.size(), events.size());
    }
}
