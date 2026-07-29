import { describe, it, expect } from 'vitest';
import {
  analyzeLiveConditions, OBSERVATION_TEMPLATES,
} from '../src/observations.js';
import { LiveLikeStore } from '../src/observations.js';

function fakeStore(opts: {
  motors?: Array<{
    name: string;
    power?: Array<{ t: number; v: number | null }>;
    velocity?: Array<{ t: number; v: number | null }>;
    mode?: string;
  }>;
  battery?: Array<{ t: number; v: number | null }>;
  loopTime?: Array<{ t: number; v: number | null }>;
}): LiveLikeStore {
  const motorMap = new Map<string, { deviceName: string; powerHistory: any[]; velocityHistory: any[]; mode: string | null }>();
  for (const m of (opts.motors ?? [])) {
    motorMap.set(m.name, {
      deviceName: m.name,
      powerHistory: m.power ?? [],
      velocityHistory: m.velocity ?? [],
      mode: m.mode ?? null,
    });
  }
  const channelMap = new Map<string, { history: Array<{ t: number; v: number | null }> }>();
  channelMap.set('system.loopTimeMs', { history: opts.loopTime ?? [] });
  return {
    getMotorNames: () => Array.from(motorMap.keys()),
    getMotor: (name) => motorMap.get(name),
    getBatteryHistory: () => opts.battery ?? [],
    getChannel: (name) => channelMap.get(name),
  };
}

describe('analyzeLiveConditions', () => {
  it('empty store returns zero conditions without inventing any text', () => {
    const conds = analyzeLiveConditions(fakeStore({}));
    expect(conds).toEqual([]);
  });

  it('emits a stall observation when power is high but velocity stays low', () => {
    const store = fakeStore({
      motors: [{
        name: 'frontLeft',
        power: [{ t: 1000, v: 0.6 }, { t: 1100, v: 0.65 }, { t: 1200, v: 0.7 }],
        velocity: [
          { t: 1000, v: 5 }, { t: 1100, v: 6 }, { t: 1200, v: 7 },
        ],
      }],
    });
    const conds = analyzeLiveConditions(store);
    expect(conds).toHaveLength(1);
    expect(conds[0].severity).toBe('warning');
    expect(conds[0].target).toBe('frontLeft');
    expect(conds[0].observation).toBe(
      OBSERVATION_TEMPLATES.POWER_COMMANDED_VELOCITY_LOW.observation,
    );
    expect(conds[0].suggestedInspection).toBe(
      OBSERVATION_TEMPLATES.POWER_COMMANDED_VELOCITY_LOW.inspection,
    );
    expect(conds[0].repetitionCount).toBe(3);
    expect(conds[0].latestTimestampMs).toBe(1200);
  });

  it('does NOT emit a stall when velocity exceeds the threshold in the same window', () => {
    const store = fakeStore({
      motors: [{
        name: 'm',
        power: [{ t: 1000, v: 0.9 }],
        velocity: [{ t: 1000, v: 500 }, { t: 1100, v: 480 }],
      }],
    });
    expect(analyzeLiveConditions(store)).toEqual([]);
  });

  it('groups multiple stall events on the same motor into one row with count', () => {
    const store = fakeStore({
      motors: [{
        name: 'm',
        power: [
          { t: 1000, v: 0.7 }, { t: 1100, v: 0.0 }, // held power, then released
          { t: 2000, v: 0.8 },
          { t: 2100, v: 0.0 },
          { t: 3000, v: 0.9 },
        ],
        velocity: [
          { t: 1000, v: null }, { t: 1100, v: 0 },
          { t: 2000, v: 0 },
          { t: 3000, v: 0 },
        ],
      }],
    });
    const conds = analyzeLiveConditions(store);
    expect(conds).toHaveLength(1);
    expect(conds[0].repetitionCount).toBe(3); // 3 separate power-commands-with-no-fast-velocity
  });

  it('emits battery-drop observation only when >= 0.5 V drop over >= 4 samples', () => {
    const stableStore = fakeStore({
      battery: [
        { t: 1000, v: 12.0 }, { t: 1100, v: 11.99 }, { t: 1200, v: 12.0 },
      ],
    });
    expect(analyzeLiveConditions(stableStore)).toEqual([]);

    const dropStore = fakeStore({
      battery: [
        { t: 1000, v: 12.5 }, { t: 1100, v: 12.4 }, { t: 1200, v: 12.2 },
        { t: 1300, v: 11.8 },
      ],
    });
    const conds = analyzeLiveConditions(dropStore);
    const battery = conds.find((c) => c.target === 'battery');
    expect(battery).toBeTruthy();
    expect(battery!.observation).toBe(OBSERVATION_TEMPLATES.BATTERY_DROP.observation);
    expect(battery!.values).toBeDefined();
  });

  it('emits loop-time spike observation above 35 ms threshold', () => {
    const slowStore = fakeStore({
      loopTime: [
        { t: 1000, v: 12 }, { t: 1100, v: 40 }, { t: 1200, v: 14 },
        { t: 1300, v: 50 }, { t: 1400, v: 13 },
      ],
    });
    const conds = analyzeLiveConditions(slowStore);
    const loop = conds.find((c) => c.target === 'system.loopTimeMs');
    expect(loop).toBeTruthy();
    expect(loop!.repetitionCount).toBe(2);
  });

  it('emitted observation strings always come from the template allow-list', () => {
    const store = fakeStore({
      motors: [{
        name: 'm',
        power: [{ t: 1000, v: 0.7 }],
        velocity: [{ t: 1000, v: 1 }],
      }],
      battery: [
        { t: 1000, v: 13.0 }, { t: 1100, v: 12.7 }, { t: 1200, v: 12.4 }, { t: 1300, v: 11.8 },
      ],
      loopTime: [
        { t: 1000, v: 50 }, { t: 1100, v: 25 }, { t: 1200, v: 38 },
      ],
    });
    const all = [
      analyzeLiveConditions(store),
    ].flat();
    const allowed = new Set([
      OBSERVATION_TEMPLATES.POWER_COMMANDED_VELOCITY_LOW.observation,
      OBSERVATION_TEMPLATES.BATTERY_DROP.observation,
      OBSERVATION_TEMPLATES.LOOP_TIME_INCREASED.observation,
    ]);
    for (const c of all) {
      expect(allowed.has(c.observation)).toBe(true);
    }
    // no fabricated text contains the word "stalled" or "jammed"
    for (const c of all) {
      expect(/stalled|jammed|broken/.test(c.observation.toLowerCase())).toBe(false);
    }
  });
});
