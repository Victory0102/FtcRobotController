import { describe, it, expect } from 'vitest';
import {
  buildSampleSeries,
  computeDomain as _unused1, // not exported; covered via seriesDomain below
  downsample,
  seriesDomain,
  hoverLookup,
  timeToX,
  yToValue,
  valueToY,
  defaultColor,
  motorMetricSeries,
  DEFAULT_GAP_THRESHOLD_MS,
} from '../src/graphs.js';
import { Sample } from '../src/types.js';

function s(ts: number, p: number | null = 0.5, v: number | null = 2000, c: number | null = 1.0): Sample {
  return {
    runId: 'r1', opmodeName: 'Op', runStartedAt: '2025-01-01T00:00:00Z',
    timestampMs: ts, deviceName: 'm1',
    commandedPower: p, encoderPositionTicks: 0, encoderVelocity: v,
    currentAmps: c, motorMode: 'RUN', batteryVoltage: 12.0,
  };
}

describe('buildSampleSeries gap detection', () => {
  it('marks a gap when dt > threshold', () => {
    const samples = [s(0), s(100), s(2000)];
    const pts = buildSampleSeries(samples, (x) => x.commandedPower, 500);
    expect(pts.length).toBe(3);
    expect(pts[0].gap).toBe(false);
    expect(pts[1].gap).toBe(false);
    expect(pts[2].gap).toBe(true);
  });
  it('never marks a gap when below threshold', () => {
    const samples = [s(0), s(100), s(200)];
    const pts = buildSampleSeries(samples, (x) => x.commandedPower, 500);
    expect(pts.every((p) => !p.gap)).toBe(true);
  });
  it('skips non-finite and null values', () => {
    const samples = [s(0), { ...s(100, null) }, s(200)];
    const pts = buildSampleSeries(samples, (x) => x.commandedPower);
    expect(pts.length).toBe(2);
    expect(pts[0].t).toBe(0);
    expect(pts[1].t).toBe(200);
  });
});

describe('seriesDomain', () => {
  it('returns null when all series are invisible', () => {
    const series = [{
      id: 'x', label: 'x', color: '#fff', visible: false,
      points: [{ t: 0, v: 1, gap: false }],
    }];
    expect(seriesDomain(series)).toBe(null);
  });
  it('combines visible series into a single bounding domain', () => {
    const series = [
      { id: 'a', label: 'a', color: '#fff', visible: true,
        points: [{ t: 0, v: -2, gap: false }, { t: 50, v: 4, gap: false }] },
      { id: 'b', label: 'b', color: '#fff', visible: false,
        points: [{ t: 0, v: 9999, gap: false }] },
    ];
    const dom = seriesDomain(series);
    expect(dom).not.toBe(null);
    expect(dom!.tMin).toBe(0);
    expect(dom!.tMax).toBe(50);
    expect(dom!.yMin).toBeLessThan(-2);
    expect(dom!.yMax).toBeGreaterThan(4);
  });
});

describe('downsampling preserves first/last', () => {
  it('keeps first/last sample unchanged', () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({
      t: i, v: i, gap: false,
    }));
    const out = downsample(points, 25);
    expect(out.length).toBe(25);
    expect(out[0]).toEqual(points[0]);
    expect(out[out.length - 1]).toEqual(points[points.length - 1]);
  });
  it('returns input unchanged when length <= target', () => {
    const points = [{ t: 0, v: 1, gap: false }, { t: 1, v: 2, gap: false }];
    expect(downsample(points, 25)).toEqual(points);
  });
});

describe('timeToX / valueToY / yToValue', () => {
  const dom = { tMin: 0, tMax: 1000, yMin: 0, yMax: 100 };
  it('timeToX maps linearly', () => {
    expect(timeToX(0, dom, 200)).toBe(0);
    expect(timeToX(1000, dom, 200)).toBe(200);
    expect(timeToX(500, dom, 200)).toBe(100);
  });
  it('valueToY inverts (higher y at top)', () => {
    expect(valueToY(0, dom, 100)).toBe(100);
    expect(valueToY(100, dom, 100)).toBe(0);
    expect(valueToY(50, dom, 100)).toBe(50);
  });
  it('yToValue inverts valueToY', () => {
    expect(yToValue(valueToY(33, dom, 100), dom, 100)).toBeCloseTo(33, 5);
  });
});

describe('hoverLookup binary search', () => {
  const series = {
    id: 'a', label: 'a', color: '#fff', visible: true,
    points: Array.from({ length: 20 }, (_, i) => ({
      t: i * 100, v: i, gap: false,
    })),
  };
  it('finds latest-at-or-before', () => {
    const r = hoverLookup([series], 450);
    // 450 -> latest sample at or before is t=400 (index 4)
    expect(r.length).toBe(1);
    expect(r[0].point.t).toBe(400);
  });
  it('returns empty when t is before all samples', () => {
    expect(hoverLookup([series], -1)).toEqual([]);
  });
});

describe('defaultColor palette does not repeat sooner than 8', () => {
  it('cycles through 8 distinct colors before repeating', () => {
    const first8 = Array.from({ length: 8 }, (_, i) => defaultColor(i));
    expect(new Set(first8).size).toBe(8);
    expect(defaultColor(8)).toBe(defaultColor(0));
  });
});

describe('motorMetricSeries produces motor-performance series', () => {
  it('emits power, velocity, and current without position', () => {
    const samples = [s(0, 0.5, 2000, 1.0), s(100, 0.6, 2100, 1.1)];
    const series = motorMetricSeries('m1', samples, 0);
    expect(series.length).toBe(3);
    expect(series.map((s) => s.id)).toEqual([
      'm1.power', 'm1.velocity', 'm1.current',
    ]);
  });
});

describe('DEFAULT_GAP_THRESHOLD_MS is 500ms', () => {
  it('default threshold is 500', () => {
    expect(DEFAULT_GAP_THRESHOLD_MS).toBe(500);
  });
});
