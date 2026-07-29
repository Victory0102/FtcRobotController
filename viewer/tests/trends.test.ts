import { describe, it, expect } from 'vitest';
import {
  batteryMinTrend,
  batteryMedianTrend,
  medianVelocityTrend,
  velocityEfficiencyTrend,
  currentCostTrend,
  p95CurrentTrend,
  possibleStallPctTrend,
  applyDeltas,
  customChannelTrend,
  loopTimeTrend,
} from '../src/trends.js';
import { Run, Sample, ChannelSample, FilterSelection } from '../src/types.js';

function mkSample(device: string, t: number, vel: number | null, p: number | null): Sample {
  return {
    runId: 'r1', opmodeName: 'Op', runStartedAt: '2025-01-01T00:00:00Z',
    timestampMs: t, deviceName: device,
    commandedPower: p, encoderPositionTicks: vel, encoderVelocity: vel,
    currentAmps: vel === null ? null : 1.0,
    motorMode: 'RUN', batteryVoltage: 12.0,
  };
}

function mkRun(runId: string, startIso: string, samples: Sample[]): Run {
  return {
    schemaVersion: '1',
    runId, opmodeName: 'Op', runStartedAt: startIso,
    deviceNames: Array.from(new Set(samples.map((s) => s.deviceName))).sort(),
    samples,
    truncated: false, invalidRowCount: 0,
    sourceFileName: runId + '.csv',
  };
}

const filter: FilterSelection = { direction: 'BOTH', powerBand: 'ALL_ACTIVE' };

describe('per-motor trend builders use comparison.perMotorTrend', () => {
  it('medianVelocityTrend returns chronological ChronoPoint[]', () => {
    const runs = [
      mkRun('a', '2025-01-01T00:00:00Z',
        Array.from({ length: 50 }, (_, i) => mkSample('m', i * 100, 2000, 0.5))),
      mkRun('b', '2025-01-02T00:00:00Z',
        Array.from({ length: 50 }, (_, i) => mkSample('m', i * 100, 2200, 0.6))),
    ];
    const out = medianVelocityTrend(runs, 'm', filter);
    expect(out.length).toBe(2);
    expect(out[0].runId).toBe('a');
    expect(out[1].runId).toBe('b');
    expect(out[0].value).toBeGreaterThan(0); // median velocity
    expect(out[1].value).toBeGreaterThan(out[0].value!); // b is faster
  });
  it('all five motor builders produce a non-empty chronological array', () => {
    const runs = [
      mkRun('a', '2025-01-01T00:00:00Z',
        Array.from({ length: 30 }, (_, i) => mkSample('m', i * 100, 2000, 0.5))),
    ];
    expect(medianVelocityTrend(runs, 'm', filter).length).toBe(1);
    expect(velocityEfficiencyTrend(runs, 'm', filter).length).toBe(1);
    expect(currentCostTrend(runs, 'm', filter).length).toBe(1);
    expect(p95CurrentTrend(runs, 'm', filter).length).toBe(1);
    expect(possibleStallPctTrend(runs, 'm', filter).length).toBe(1);
  });
});

describe('battery trends', () => {
  it('batteryMinTrend finds the minimum positive voltage', () => {
    const samples = [
      mkSample('m', 0, 2000, 0.5), { ...mkSample('m', 100, 2000, 0.5), batteryVoltage: 11.0 },
      { ...mkSample('m', 200, 2000, 0.5), batteryVoltage: 9.0 },
      { ...mkSample('m', 300, 2000, 0.5), batteryVoltage: 12.0 },
    ];
    const run = mkRun('r', '2025-01-01T00:00:00Z', samples);
    const out = batteryMinTrend([run]);
    expect(out[0].value).toBe(9.0);
  });
  it('batteryMinTrend ignores non-positive voltages', () => {
    const samples = [
      mkSample('m', 0, 2000, 0.5),
      { ...mkSample('m', 100, 2000, 0.5), batteryVoltage: 0 },
      { ...mkSample('m', 200, 2000, 0.5), batteryVoltage: -1 },
    ];
    const run = mkRun('r', '2025-01-01T00:00:00Z', samples);
    const out = batteryMinTrend([run]);
    expect(out[0].value).toBe(12.0); // Only the first one's voltage remains.
  });
  it('batteryMedianTrend returns null for runs with < 5 samples', () => {
    const samples = [mkSample('m', 0, 2000, 0.5)];
    const run = mkRun('r', '2025-01-01T00:00:00Z', samples);
    const out = batteryMedianTrend([run]);
    expect(out[0].value).toBe(null);
    expect(out[0].insufficient).toBe(true);
  });
});

describe('loopTimeTrend', () => {
  it('produces median + p95 ms deltas per run', () => {
    const samples = Array.from({ length: 20 }, (_, i) =>
      mkSample('m', i * 50, 2000, 0.5));
    const run = mkRun('r', '2025-01-01T00:00:00Z', samples);
    const out = loopTimeTrend([run]);
    expect(out.median[0].value).toBe(50);
    expect(out.p95[0].value).toBe(50);
  });
});

describe('customChannelTrend reads from Run.channels', () => {
  it('returns median numeric values across runs', () => {
    const ch: ChannelSample = {
      timestampMs: 0, channelName: 'a.b', kind: 'number',
      valueNumber: 10, valueBoolean: null, valueText: null,
      valueX: null, valueY: null, valueHeading: null, note: null,
    };
    const run: Run = {
      schemaVersion: '1', runId: 'r', opmodeName: 'Op',
      runStartedAt: '2025-01-01T00:00:00Z', deviceNames: [],
      samples: [], truncated: false, invalidRowCount: 0,
      sourceFileName: 'r.csv',
      channels: { byChannel: { 'a.b': [ch] }, totalCount: 1, channelNames: ['a.b'] },
    };
    const out = customChannelTrend([run], 'a.b');
    expect(out[0].value).toBe(10);
  });
});

describe('applyDeltas', () => {
  it('baselineDelta is null when value is missing', () => {
    const runs: Run[] = [
      mkRun('a', '2025-01-01T00:00:00Z',
        Array.from({ length: 30 }, (_, i) => mkSample('m', i * 100, 2000, 0.5))),
    ];
    const series = medianVelocityTrend(runs, 'm', filter);
    series[0].value = null;
    const out = applyDeltas(series, { baselineRunId: runs[0].runId });
    expect(out[0].value).toBe(null);
    expect(out[0].baselineDelta).toBe(null);
    expect(out[0].previousDelta).toBe(null);
  });
  it('previousDelta is computed from previous chronological point', () => {
    const runs = [
      mkRun('a', '2025-01-01T00:00:00Z',
        Array.from({ length: 30 }, (_, i) => mkSample('m', i * 100, 2000, 0.5))),
      mkRun('b', '2025-01-02T00:00:00Z',
        Array.from({ length: 30 }, (_, i) => mkSample('m', i * 100, 2200, 0.5))),
    ];
    const series = medianVelocityTrend(runs, 'm', filter);
    const out = applyDeltas(series, { baselineRunId: null });
    expect(out[0].previousDelta).toBe(null); // first point has none
    expect(out[1].previousDelta).not.toBe(null);
  });
  it('baselineDelta is null when no baselineRunId is provided', () => {
    const runs = [
      mkRun('a', '2025-01-01T00:00:00Z',
        Array.from({ length: 30 }, (_, i) => mkSample('m', i * 100, 2000, 0.5))),
      mkRun('b', '2025-01-02T00:00:00Z',
        Array.from({ length: 30 }, (_, i) => mkSample('m', i * 100, 2200, 0.5))),
    ];
    const series = medianVelocityTrend(runs, 'm', filter);
    const out = applyDeltas(series, { baselineRunId: null });
    expect(out[0].baselineDelta).toBe(null);
    expect(out[1].baselineDelta).toBe(null);
  });
});
