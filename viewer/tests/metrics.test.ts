/**
 * Pure-function tests for the metric primitives.
 *
 * No I/O, no fetch, no DOM — these tests run in milliseconds.
 */
import { describe, it, expect } from 'vitest';

import {
  median,
  percentile,
  medianAbsoluteVelocity,
  velocityPerEffectiveCommand,
  currentPerMovement,
  p95Current,
  possibleStallPercentage,
  percentChange,
  classifyChange,
  effectiveCommand,
  filterSamples,
  activeDuration,
  sampleCount,
  describePowerBand,
} from '../src/metrics.js';

import {
  DEFAULT_THRESHOLDS,
  Direction,
  FilterSelection,
  POWER_BANDS,
  Sample,
} from '../src/types.js';

function makeSample(p: Partial<Sample>): Sample {
  return {
    runId: 'r1',
    opmodeName: 'Op',
    runStartedAt: '2025-01-01T00:00:00Z',
    timestampMs: 0,
    deviceName: 'leftFront',
    commandedPower: null,
    encoderPositionTicks: null,
    encoderVelocity: null,
    currentAmps: null,
    motorMode: null,
    batteryVoltage: null,
    ...p,
  };
}

function buildRuns(samples: Sample[]): Sample[] {
  // sort by timestamp then return
  return [...samples].sort((a, b) => a.timestampMs - b.timestampMs);
}

describe('median', () => {
  it('empty returns null', () => {
    expect(median([])).toBe(null);
  });
  it('odd length returns middle', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it('even length averages middle two', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('ignores non-finite', () => {
    expect(median([1, Number.NaN, Number.POSITIVE_INFINITY, 3, 5])).toBe(3);
  });
});

describe('percentile', () => {
  it('returns null for empty', () => {
    expect(percentile([], 0.95)).toBe(null);
  });
  it('p=1 returns max', () => {
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
  });
  it('linear interpolation', () => {
    // sorted = [1,2,3,4,5]; idx = 4 * 0.5 = 2; lo = hi = 2 -> sorted[2] = 3
    expect(percentile([5, 3, 1, 2, 4], 0.5)).toBe(3);
  });
  it('rejects invalid p', () => {
    expect(() => percentile([1, 2], -1)).toThrow();
    expect(() => percentile([1, 2], 1.1)).toThrow();
  });
});

describe('effectiveCommand', () => {
  it('null commandedPower returns null', () => {
    expect(effectiveCommand(makeSample({ commandedPower: null, batteryVoltage: 12 }))).toBe(null);
  });
  it('null batteryVoltage returns null', () => {
    expect(effectiveCommand(makeSample({ commandedPower: 0.5, batteryVoltage: null }))).toBe(null);
  });
  it('zero or negative voltage returns null', () => {
    expect(effectiveCommand(makeSample({ commandedPower: 0.5, batteryVoltage: 0 }))).toBe(null);
    expect(effectiveCommand(makeSample({ commandedPower: 0.5, batteryVoltage: -1 }))).toBe(null);
  });
  it('multiplies by V/12', () => {
    expect(effectiveCommand(makeSample({ commandedPower: 0.5, batteryVoltage: 12 }))).toBeCloseTo(0.5);
    expect(effectiveCommand(makeSample({ commandedPower: 0.5, batteryVoltage: 6 }))).toBeCloseTo(0.25);
  });
});

describe('medianAbsoluteVelocity', () => {
  it('drops nulls', () => {
    const samples = [
      makeSample({ encoderVelocity: 1000, commandedPower: 0.5 }),
      makeSample({ encoderVelocity: null, commandedPower: 0.5 }),
      makeSample({ encoderVelocity: 2000, commandedPower: 0.5 }),
    ];
    const r = medianAbsoluteVelocity(samples, 2);
    expect(r.value).toBe(1500);
    expect(r.n).toBe(2);
  });
  it('uses absolute value', () => {
    const samples = [
      makeSample({ encoderVelocity: -2000, commandedPower: 0.5 }),
      makeSample({ encoderVelocity: 2000, commandedPower: 0.5 }),
    ];
    expect(medianAbsoluteVelocity(samples, 2).value).toBe(2000);
  });
  it('returns null when too few samples', () => {
    const samples = [
      makeSample({ encoderVelocity: 1500, commandedPower: 0.5 }),
      makeSample({ encoderVelocity: 1500, commandedPower: 0.5 }),
    ];
    expect(medianAbsoluteVelocity(samples, 10).value).toBe(null);
  });
});

describe('velocityPerEffectiveCommand', () => {
  it('drops missing voltage', () => {
    const samples = [
      makeSample({ encoderVelocity: 2000, commandedPower: 0.5, batteryVoltage: null }),
      makeSample({ encoderVelocity: 2000, commandedPower: 0.5, batteryVoltage: 12 }),
    ];
    const r = velocityPerEffectiveCommand(samples, 1);
    expect(r.n).toBe(1);
  });
  it('returns null when too few', () => {
    expect(velocityPerEffectiveCommand([], 1).value).toBe(null);
  });
});

describe('currentPerMovement', () => {
  it('respects velocity threshold', () => {
    const samples = [
      makeSample({ currentAmps: 1.0, encoderVelocity: 1000, commandedPower: 0.5 }),
      makeSample({ currentAmps: 1.0, encoderVelocity: 10, commandedPower: 0.5 }), // below threshold
    ];
    const r = currentPerMovement(samples, 50, 1);
    expect(r.n).toBe(1);
    // 1.0 * 1000 / 1000 = 1.0 amps per 1000 tps
    expect(r.value).toBeCloseTo(1.0);
  });
});

describe('p95Current', () => {
  it('returns 95th percentile current', () => {
    const samples: Sample[] = [];
    for (let i = 0; i < 100; i++) {
      samples.push(makeSample({ currentAmps: i + 1, commandedPower: 0.5 }));
    }
    const r = p95Current(samples, 20);
    // linear interp at p=0.95, idx = 99*0.95 = 94.05 -> sorted[94] + 0.05*(95-94)
    expect(r.value).toBeCloseTo(95.05, 1);
  });
});

describe('possibleStallPercentage', () => {
  it('reports stalls (high power + low velocity)', () => {
    const samples = [
      // high power, no velocity: stall
      makeSample({ commandedPower: 0.5, encoderVelocity: 10 }),
      // high power, high velocity: not a stall
      makeSample({ commandedPower: 0.5, encoderVelocity: 1000 }),
      // high power, no velocity: stall
      makeSample({ commandedPower: 0.5, encoderVelocity: 10 }),
      // high power, low velocity but >= threshold: borderline
      makeSample({ commandedPower: 0.7, encoderVelocity: 60 }),
    ];
    const r = possibleStallPercentage(samples, DEFAULT_THRESHOLDS, 4);
    expect(r.n).toBe(4);
    // 2/4 = 50%
    expect(r.value).toBeCloseTo(50);
  });
});

describe('activeDuration', () => {
  it('sums inter-sample dt below 1 second', () => {
    const samples = [
      makeSample({ timestampMs: 0 }),
      makeSample({ timestampMs: 100 }),
      makeSample({ timestampMs: 200 }),
      makeSample({ timestampMs: 1300 }), // gap of 1100ms (paused)
      makeSample({ timestampMs: 1400 }),
    ];
    expect(activeDuration(samples)).toBe(300 + 100);
  });
});

describe('percentChange', () => {
  it('returns null when reference is zero', () => {
    const r = percentChange(0, 100);
    expect(r.value).toBe(null);
    expect(r.available).toBe(false);
  });
  it('returns null when reference is null', () => {
    expect(percentChange(null, 100).available).toBe(false);
  });
  it('computes standard change', () => {
    expect(percentChange(100, 90).value).toBeCloseTo(-10);
    expect(percentChange(200, 220).value).toBeCloseTo(10);
  });
});

describe('classifyChange', () => {
  it('Stable at small changes', () => {
    expect(classifyChange(2, true)).toBe('Stable');
  });
  it('Changed at >= threshold', () => {
    expect(classifyChange(5, true)).toBe('Changed');
    expect(classifyChange(7, true)).toBe('Changed');
  });
  it('Large Change at >= large threshold', () => {
    expect(classifyChange(15, true)).toBe('Large Change');
    expect(classifyChange(50, true)).toBe('Large Change');
  });
  it('Insufficient when not available', () => {
    expect(classifyChange(null, false)).toBe('Insufficient Data');
  });
});

describe('filterSamples', () => {
  it('POSITIVE drops negative-command samples', () => {
    const samples = [
      makeSample({ commandedPower: 0.5, deviceName: 'leftFront' }),
      makeSample({ commandedPower: -0.5, deviceName: 'leftFront' }),
    ];
    const { matching } = filterSamples(samples, 'leftFront', { direction: 'POSITIVE', powerBand: 'ALL_ACTIVE' });
    expect(matching.length).toBe(1);
  });
  it('low band excludes medium-power samples', () => {
    const samples = [
      makeSample({ commandedPower: 0.2 }), // LOW
      makeSample({ commandedPower: 0.5 }), // MEDIUM
      makeSample({ commandedPower: 0.8 }), // HIGH
    ];
    const { matching } = filterSamples(samples, 'leftFront', { direction: 'BOTH', powerBand: 'LOW' });
    expect(matching.length).toBe(1);
  });
  it('ALL_ACTIVE drops below 0.15 absolute power', () => {
    const samples = [
      makeSample({ commandedPower: 0.1 }),
      makeSample({ commandedPower: 0.15 }),
      makeSample({ commandedPower: 0.5 }),
    ];
    const { matching } = filterSamples(samples, 'leftFront', { direction: 'BOTH', powerBand: 'ALL_ACTIVE' });
    expect(matching.length).toBe(2);
  });
  it('motorModeStrict rejects mismatched modes', () => {
    const samples = [
      makeSample({ motorMode: 'RUN_USING_ENCODER', commandedPower: 0.5 }),
      makeSample({ motorMode: 'RUN_WITHOUT_ENCODER', commandedPower: 0.5 }),
    ];
    const { matching, motorModeMismatch } = filterSamples(samples, 'leftFront',
      { direction: 'BOTH', powerBand: 'ALL_ACTIVE' }, 'RUN_USING_ENCODER');
    expect(matching.length).toBe(1);
    expect(motorModeMismatch).toBe(true);
  });
});

describe('sampleCount + describePowerBand', () => {
  it('sampleCount returns length', () => {
    expect(sampleCount([makeSample({}), makeSample({})])).toBe(2);
  });
  it('describePowerBand returns canonical string', () => {
    expect(describePowerBand('LOW')).toBe(POWER_BANDS ? '|p| ∈ [0.15, 0.35)' : '');
  });
});
