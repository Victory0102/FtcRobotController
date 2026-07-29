/*
 * Copyright (c) 2025 FTC Run Health contributors
 *
 * Licensed under the GNU General Public License v3.0 or later.
 * See the top-level LICENSE file for details.
 */
package org.firstinspires.ftc.teamcode.runhealth.logging;

import java.util.concurrent.atomic.AtomicLong;

/**
 * Thread-safe singleton registry of the most-recent
 * {@link LiveSnapshot}.  All readers see ONE of:
 * <ul>
 *   <li>{@code null}, before the very first publish;</li>
 *   <li>an immutable, fully-built {@link LiveSnapshot}.</li>
 * </ul>
 *
 * <p><strong>Concurrency contract.</strong>  Reads from
 * {@link #current()} are O(1) and lock-free (the {@code latest} field
 * is {@code volatile} and always assigned a fully-built immutable
 * instance, so a reader can never observe a half-constructed object).
 * Writes (publish/markInactive/clear) are {@code synchronized} on the
 * class object, sequence number is bumped via {@link AtomicLong}.
 *
 * <p><strong>Bounded memory.</strong>  At most ONE {@link LiveSnapshot}
 * is reachable from this object between writes.  10,000 calls to
 * {@link #publish(LiveSnapshot)} still result in O(1) reachable
 * objects; the previous snapshot becomes unreferenced as soon as the
 * volatile field is reassigned.
 *
 * <p>This class is intentionally side-effect-free beyond the volatile
 * field and AtomicLong: it does no file I/O, never logs, never blocks
 * the caller for I/O, never creates threads.
 */
public final class LiveSnapshotRegistry {

    private static final LiveSnapshotRegistry INSTANCE = new LiveSnapshotRegistry();

    private volatile LiveSnapshot latest;
    private final AtomicLong sequence = new AtomicLong(0L);

    private LiveSnapshotRegistry() { /* singleton */ }

    public static LiveSnapshotRegistry getInstance() { return INSTANCE; }

    /**
     * Atomically replaces the live snapshot.  The caller is expected to
     * have assembled a fully-built immutable {@link LiveSnapshot};
     * readers cannot observe a partially mutated object because
     * assignment of a single reference to a {@code volatile} field is
     * atomic on the JVM memory model.  Sequence number is not modified
     * here; the supplied snapshot's {@link LiveSnapshot#sequence} field
     * is the authoritative value.
     */
    public synchronized void publish(LiveSnapshot snap) {
        if (snap == null) return;
        this.latest = snap;
    }

    /**
     * Returns the most-recent {@link LiveSnapshot} or {@code null} if
     * nothing has been published yet and no inactive marker exists.
     * O(1), lock-free.
     */
    public LiveSnapshot current() {
        return latest;
    }

    /**
     * Returns an "empty" inactive snapshot when nothing has been
     * published yet.  Useful for the API endpoint so the browser always
     * sees a structured response rather than {@code null}.
     */
    public synchronized LiveSnapshot currentOrEmpty(long timestampMs) {
        LiveSnapshot s = latest;
        if (s != null) return s;
        LiveSnapshot empty = LiveSnapshot.empty(0L, timestampMs);
        return empty;
    }

    /**
     * Atomically publishes an inactive snapshot (sequence bumped by one),
     * preserving the most-recent field values so the browser can show
     * "last seen" data after a session ends.
     */
    public synchronized void markInactive() {
        LiveSnapshot prev = latest;
        if (prev == null) {
            latest = LiveSnapshot.empty(sequence.incrementAndGet(), System.currentTimeMillis());
            return;
        }
        // Re-emit the previous values but flip active=false so callers
        // can render "session finished" while still showing the last
        // branch readings.
        BuilderInline b = new BuilderInline();
        b.copyFrom(prev);
        b.active = false;
        b.sequence = sequence.incrementAndGet();
        b.timestampMs = System.currentTimeMillis();
        latest = b.build();
    }

    /**
     * Removes the live snapshot entirely.  Used by tests.
     */
    public synchronized void clear() {
        latest = null;
    }

    /**
     * Returns the diagnostic sequence counter; monotonic over the
     * lifetime of this singleton.
     */
    public long currentSequence() {
        return sequence.get();
    }

    /**
     * Internal copy-helper that builds a new immutable
     * {@link LiveSnapshot} while preserving the previous values.
     * Encapsulated here so {@link LiveSnapshot} can keep its strict
     * public immutability without sacrificing the "mark inactive"
     * convenience mutation.
     */
    private static final class BuilderInline {
        boolean active = true;
        String sessionId;
        String opMode;
        String recordingMode;
        long sequence;
        long timestampMs;
        long elapsedMs;
        Double batteryVoltage;
        Double loopTimeMs;
        final java.util.List<LiveSnapshot.MotorView> motors = new java.util.ArrayList<>();
        final java.util.List<LiveSnapshot.ChannelView> channels = new java.util.ArrayList<>();
        final java.util.List<LiveSnapshot.EventView> events = new java.util.ArrayList<>();

        void copyFrom(LiveSnapshot s) {
            this.active = s.active;
            this.sessionId = s.sessionId;
            this.opMode = s.opMode;
            this.recordingMode = s.recordingMode;
            this.sequence = s.sequence;
            this.timestampMs = s.timestampMs;
            this.elapsedMs = s.elapsedMs;
            this.batteryVoltage = s.batteryVoltage;
            this.loopTimeMs = s.loopTimeMs;
            this.motors.addAll(s.motors);
            this.channels.addAll(s.channels);
            this.events.addAll(s.events);
        }

        LiveSnapshot build() {
            LiveSnapshot.Factory f = new LiveSnapshot.Factory();
            f.active(active)
                    .sessionId(sessionId).opMode(opMode).recordingMode(recordingMode)
                    .sequence(sequence).timestampMs(timestampMs).elapsedMs(elapsedMs)
                    .batteryVoltage(batteryVoltage).loopTimeMs(loopTimeMs);
            for (LiveSnapshot.MotorView m : motors) f.addMotor(m);
            for (LiveSnapshot.ChannelView c : channels) f.addChannel(c);
            for (LiveSnapshot.EventView e : events) f.addEvent(e);
            return f.build();
        }
    }
}
