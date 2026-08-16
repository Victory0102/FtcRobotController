/**
 * Live telemetry tests — LivePoller, LiveStore, liveSnapshotStats, safeText.
 *
 * <p>These tests are pure-logic; they do not touch the network.  fetch is
 * mocked via {@code vi.fn()}; backoff math is exercised deterministically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  LivePoller,
  LiveStore,
  liveSnapshotStats,
  safeText,
  LIVE_LIMITS,
} from '../src/live.js';
import type { LiveSnapshot } from '../src/types.js';

function snap(seq: number, active = true): LiveSnapshot {
  return {
    schema_version: 1,
    active,
    session_id: 's',
    op_mode: 'Op',
    recording_mode: 'OFF',
    sequence: seq,
    timestamp_ms: 1000 + seq,
    elapsed_ms: seq * 10,
    battery_voltage: 12.4,
    loop_time_ms: null,
    motors: [],
    channels: [],
    events: [],
  };
}

describe('LivePoller scheduling', () => {
  it('schedules exactly one in-flight request at a time', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      // Wait for the abort signal before resolving (so overlapping prevention can fire).
      await new Promise<void>((resolve, reject) => {
        const sig = init?.signal;
        if (!sig) { resolve(); return; }
        if (sig.aborted) { reject(new Error('AbortError')); return; }
        sig.addEventListener('abort', () => reject(new Error('AbortError')));
        // Failsafe to keep the test bounded.
        setTimeout(resolve, 25);
      });
      inflight -= 1;
      return new Response(JSON.stringify(snap(1)), { status: 200 });
    });
    const docLike = { visibilityState: 'visible' };
    const poller = new LivePoller({
      url: '/x', pollMs: 10, maxBackoffMs: 50, fetchImpl: fetchImpl as unknown as typeof fetch,
      documentLike: docLike,
    });
    const onSnap = vi.fn();
    poller.start(onSnap, () => {});
    // Give it room for several ticks.
    await new Promise(r => setTimeout(r, 200));
    poller.stop();
    expect(maxInflight).toBe(1);
  });

  it('stops on stop() and does not schedule further ticks', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(snap(1)), { status: 200 }));
    const poller = new LivePoller({
      url: '/x', pollMs: 10, fetchImpl: fetchImpl as unknown as typeof fetch,
      documentLike: { visibilityState: 'visible' },
    });
    poller.start(() => {}, () => {});
    await new Promise(r => setTimeout(r, 30));
    poller.stop();
    const calls = fetchImpl.mock.calls.length;
    await new Promise(r => setTimeout(r, 80));
    expect(fetchImpl.mock.calls.length).toBe(calls); // no further calls after stop
  });
});

describe('LivePoller backoff', () => {
  it('successful response resets backoff to pollMs', async () => {
    const seqs: number[] = [];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(snap(1)), { status: 200 }));
    const poller = new LivePoller({
      url: '/x', pollMs: 10, maxBackoffMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      documentLike: { visibilityState: 'visible' },
    });
    const onSnap = (_s: LiveSnapshot) => { seqs.push(Date.now()); };
    poller.start(onSnap, () => {});
    await new Promise(r => setTimeout(r, 80));
    poller.stop();
    // The success path runs \u2265 3 ticks within 80ms; should be way more than the
    // backoff-elevated minimum would allow on the failure path.
    expect(seqs.length).toBeGreaterThanOrEqual(3);
  });

  it('persistently failing fetch does not flood (clamped)', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const poller = new LivePoller({
      url: '/x', pollMs: 10, maxBackoffMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      documentLike: { visibilityState: 'visible' },
    });
    const onErr = vi.fn();
    poller.start(() => {}, onErr);
    await new Promise(r => setTimeout(r, 350));
    poller.stop();
    // With 50ms clamp and 350ms, plus the 10ms base, the failure path must
    // produce far fewer calls than the success path would.
    expect(fetchImpl.mock.calls.length).toBeLessThan(20);
    expect(onErr.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('LivePoller visibility', () => {
  it('hidden visibility slows polling', async () => {
    let count = 0;
    const fetchImpl = vi.fn(async () => {
      count += 1;
      return new Response(JSON.stringify(snap(count)), { status: 200 });
    });
    const docLike = { visibilityState: 'hidden' as 'hidden' | 'visible' };
    const poller = new LivePoller({
      url: '/x', pollMs: 10, maxBackoffMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      documentLike: docLike,
    });
    poller.start(() => {}, () => {});
    await new Promise(r => setTimeout(r, 200));
    poller.stop();
    // At visibilityFactor=5, base 10ms, clamp 50ms: hidden slows mean wait
    // \u2265 50ms per tick; 200ms / 50ms ~= \u22644.  Visible baseline 200/10 ~= 20.
    expect(count).toBeLessThanOrEqual(8);
  });
});

describe('LiveStore trim and dedup', () => {
  it('drops out-of-order sequences', () => {
    const s = new LiveStore();
    s.apply(snap(5));
    s.apply(snap(3));
    s.apply(snap(7));
    expect(s.acceptedCount()).toBe(2);
  });

  it('drops duplicate sequences', () => {
    const s = new LiveStore();
    s.apply(snap(1));
    s.apply(snap(1));
    s.apply(snap(2));
    expect(s.acceptedCount()).toBe(2);
  });

  it('bounded buffers trim oldest when over MAX_POINTS_PER_GRAPH', () => {
    const s = new LiveStore();
    for (let i = 0; i < LIVE_LIMITS.MAX_POINTS_PER_GRAPH + 200; i++) {
      // Sequence increments mean we never get duplicates.
      s.apply({
        ...snap(i + 1),
        battery_voltage: 12.0 + i * 0.001,
      });
    }
    // Battery history is bounded.
    expect(s.getBatteryHistory().length).toBeLessThanOrEqual(LIVE_LIMITS.MAX_POINTS_PER_GRAPH);
  });

  it('trim respects MAX_HISTORY_MS for in-graph points', () => {
    const s = new LiveStore();
    // Issue a snapshot at very-old timestamp, then a recent one.
    s.apply({ ...snap(1), timestamp_ms: 1 });
    s.apply({ ...snap(2), timestamp_ms: 1_000_000 });
    // The old point's t is below cutoff = 1_000_000 - MAX_HISTORY_MS, so it
    // should be trimmed on the most-recent apply.
    const hist = s.getBatteryHistory();
    expect(hist.length).toBeLessThanOrEqual(1);
    expect(hist[0].t).toBe(1_000_000);
  });

  it('trims path to MAX_PATH_POINTS', () => {
    const s = new LiveStore();
    for (let i = 0; i < LIVE_LIMITS.MAX_PATH_POINTS + 50; i++) {
      s.apply({
        ...snap(i + 1),
        channels: [
          {
            name: 'robot.pose', kind: 'pose',
            value_number: null, value_boolean: null, value_text: null,
            pose_x: i * 0.1, pose_y: 0,
            pose_heading: 0, unit: null, group: null, description: null,
          },
        ],
      });
    }
    expect(s.getPrimaryPath().length).toBeLessThanOrEqual(LIVE_LIMITS.MAX_PATH_POINTS);
  });

  it('motor history honoured separately per device', () => {
    const s = new LiveStore();
    const withMotors = (seq: number) => ({
      ...snap(seq),
      motors: [
        { device_name: 'left', power: 0.3, velocity_ticks_per_second: null, current_amps: null, mode: 'RUN_USING_ENCODER' },
        { device_name: 'right', power: -0.2, velocity_ticks_per_second: null, current_amps: null, mode: 'RUN_USING_ENCODER' },
      ],
    });
    s.apply(withMotors(1));
    s.apply(withMotors(2));
    s.apply(withMotors(3));
    expect(s.getMotor('left')?.powerHistory.length).toBe(3);
    expect(s.getMotor('right')?.powerHistory.length).toBe(3);
  });
});

describe('liveSnapshotStats', () => {
  it('observedHz \u2248 accepted / duration seconds', () => {
    const s = new LiveStore();
    const baseTs = 10_000;
    for (let i = 0; i < 10; i++) {
      s.apply({ ...snap(i + 1), timestamp_ms: baseTs + i * 100 });
    }
    const stats = liveSnapshotStats(s);
    expect(stats.accepted).toBe(10);
    expect(stats.observedHz).toBeGreaterThan(0);
    // 10 snapshots over 0.9s \u2248 11 Hz.
    expect(Math.abs(stats.observedHz - 10 / 0.9)).toBeLessThan(0.5);
  });

  it('reports zeros when no snapshots accepted', () => {
    const s = new LiveStore();
    const stats = liveSnapshotStats(s);
    expect(stats.accepted).toBe(0);
    expect(stats.observedHz).toBe(0);
  });
});

describe('safeText', () => {
  it('renders <script> as literal text (JSON-roundtripped)', () => {
    expect(safeText('<script>alert(1)</script>')).not.toContain('<script>');
    // The unsafe "<" is escaped by JSON.stringify.
    expect(safeText('<script>alert(1)</script>')).toContain('\\u003c');
  });

  it('returns empty string for null / undefined', () => {
    expect(safeText(null)).toBe('');
    expect(safeText(undefined)).toBe('');
  });
});
