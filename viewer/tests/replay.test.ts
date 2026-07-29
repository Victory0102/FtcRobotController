import { describe, it, expect } from 'vitest';
import {
  lookupNumeric,
  lookupBoolean,
  lookupText,
  lookupPose,
  latestIndexAtOrBefore,
  runDurationMs,
  ReplayClock,
  PLAYBACK_SPEEDS,
  DEFAULT_SPEED,
  DEFAULT_MAX_GAP_MS,
} from '../src/replay.js';
import { ChannelSample } from '../src/types.js';

function numSample(t: number, v: number): ChannelSample {
  return {
    timestampMs: t,
    channelName: 'vel',
    kind: 'number',
    valueNumber: v, valueBoolean: null, valueText: null,
    valueX: null, valueY: null, valueHeading: null, note: null,
  };
}
function boolSample(t: number, v: boolean): ChannelSample {
  return {
    timestampMs: t,
    channelName: 'flag',
    kind: 'boolean',
    valueNumber: null, valueBoolean: v, valueText: null,
    valueX: null, valueY: null, valueHeading: null, note: null,
  };
}
function textSample(t: number, v: string): ChannelSample {
  return {
    timestampMs: t,
    channelName: 'state',
    kind: 'text',
    valueNumber: null, valueBoolean: null, valueText: v,
    valueX: null, valueY: null, valueHeading: null, note: null,
  };
}
function poseSample(t: number, x: number, y: number): ChannelSample {
  return {
    timestampMs: t,
    channelName: 'pose',
    kind: 'pose',
    valueNumber: null, valueBoolean: null, valueText: null,
    valueX: x, valueY: y, valueHeading: 0, note: null,
  };
}

describe('numeric lookup', () => {
  it('returns null before the first sample', () => {
    expect(lookupNumeric([numSample(100, 5)], 50)).toBe(null);
  });
  it('returns the latest previous sample when t is between samples', () => {
    const samples = [numSample(0, 10), numSample(100, 20), numSample(200, 30)];
    expect(lookupNumeric(samples, 150)).toBe(20);
    expect(lookupNumeric(samples, 100)).toBe(20); // inclusive boundary
  });
  it('interpolates within maxGapMs', () => {
    const samples = [numSample(0, 0), numSample(100, 100)];
    expect(lookupNumeric(samples, 50, 500, /* interpolate */ true)).toBeCloseTo(50, 5);
  });
  it('does NOT interpolate across gaps larger than maxGapMs', () => {
    const samples = [numSample(0, 0), numSample(2000, 100)];
    // 2000 - 0 = 2000ms, larger than 500ms default - returns the prev value flatly.
    expect(lookupNumeric(samples, 1500)).toBe(0);
  });
});

describe('boolean lookup', () => {
  it('returns latest previous state without interpolation', () => {
    const samples = [boolSample(0, false), boolSample(100, true), boolSample(200, false)];
    expect(lookupBoolean(samples, 50)).toBe(false);
    expect(lookupBoolean(samples, 101)).toBe(true);
    expect(lookupBoolean(samples, 250)).toBe(false);
  });
  it('returns null before the first sample', () => {
    expect(lookupBoolean([boolSample(100, true)], 50)).toBe(null);
  });
});

describe('text lookup', () => {
  it('returns latest previous string', () => {
    const samples = [textSample(0, 'A'), textSample(100, 'B'), textSample(200, 'C')];
    expect(lookupText(samples, 50)).toBe('A');
    expect(lookupText(samples, 100)).toBe('B');
    expect(lookupText(samples, 250)).toBe('C');
  });
});

describe('pose lookup', () => {
  it('interpolates x/y within a small gap', () => {
    const samples = [poseSample(0, 0, 0), poseSample(100, 100, 100)];
    const r = lookupPose(samples, 50);
    expect(r!.x).toBeCloseTo(50, 5);
    expect(r!.y).toBeCloseTo(50, 5);
  });
  it('does NOT interpolate across a large gap', () => {
    const samples = [poseSample(0, 0, 0), poseSample(2000, 100, 100)];
    const r = lookupPose(samples, 1500);
    expect(r!.x).toBe(0);
    expect(r!.y).toBe(0);
  });
});

describe('latestIndexAtOrBefore binary search', () => {
  it('returns -1 when every sample is later than t', () => {
    expect(latestIndexAtOrBefore([{ timestampMs: 100 }], 50)).toBe(-1);
  });
  it('returns last index at end of array', () => {
    expect(latestIndexAtOrBefore([{ timestampMs: 1 }, { timestampMs: 2 }], 100)).toBe(1);
  });
});

describe('runDurationMs prefers manifest duration', () => {
  it('uses manifest when positive and finite', () => {
    expect(runDurationMs([], 5000)).toBe(5000);
  });
  it('falls back to sample timestamp range', () => {
    const samples = [{ timestampMs: 0 }, { timestampMs: 3000 }];
    expect(runDurationMs(samples, 0)).toBe(3000);
  });
});

describe('ReplayClock', () => {
  it('starts paused at timeMs = 0', () => {
    const c = new ReplayClock();
    c.loadRun(0, 1000);
    expect(c.isPlayingNow()).toBe(false);
    expect(c.getTime()).toBe(0);
  });
  it('seek clamps to [0, duration]', () => {
    const c = new ReplayClock();
    c.loadRun(0, 1000);
    c.seek(99999);
    expect(c.getTime()).toBe(1000);
    c.seek(-100);
    expect(c.getTime()).toBe(0);
  });
  it('registers and unregisters a consumer', () => {
    const c = new ReplayClock();
    c.loadRun(0, 1000);
    const seen: number[] = [];
    const un = c.registerConsumer((t) => seen.push(t));
    // The replay clock dispatches a single immediate notify on registration,
    // so the consumer has already been called once with timeMs=0.  Calling
    // the private notify() directly is not part of the public API.
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(0);
    un();
  });
  it('setSpeed rejects disallowed values', () => {
    const c = new ReplayClock();
    c.setSpeed(7);
    expect(c.getSpeed()).toBe(DEFAULT_SPEED);
    c.setSpeed(0.5);
    expect(c.getSpeed()).toBe(0.5);
  });
  it('snapshot returns progress = clamped fraction', () => {
    const c = new ReplayClock();
    c.loadRun(0, 1000);
    c.seek(250);
    const s = c.snapshot();
    expect(s.progress).toBeCloseTo(0.25, 5);
    expect(s.isPlaying).toBe(false);
  });
});

describe('playback-speed constants', () => {
  it('PLAYBACK_SPEEDS contains 0.25/0.5/1/2/4', () => {
    expect(PLAYBACK_SPEEDS).toEqual([0.25, 0.5, 1, 2, 4]);
  });
  it('DEFAULT_MAX_GAP_MS is 500ms', () => {
    expect(DEFAULT_MAX_GAP_MS).toBe(500);
  });
});

/* A small adapter so we can poke notify() in tests without exposing it. */
declare module '../src/replay.js' {
  export interface ReplayClock {
    notify_external_for_test(): void;
  }
}
