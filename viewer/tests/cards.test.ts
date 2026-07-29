import { describe, it, expect } from 'vitest';
import {
  buildLiveSummaryChips, buildMotorCardDescriptors,
  buildCompareSummary, buildImportSummary, buildConditionRows,
} from '../src/cards.js';
import {
  LiveLikeSnap, LiveLikeStore,
} from '../src/observations.js';
import { LiveSnapshot } from '../src/types.js';
import { formatFractionPct, formatFractionPctSigned, formatSignedDiff, MISSING } from '../src/format.js';

/* ================================================================== */
/*  fixtures                                                          */
/* ================================================================== */

function fakeStore(opts: {
  motors?: Array<{
    name: string;
    power?: Array<{ t: number; v: number | null }>;
    velocity?: Array<{ t: number; v: number | null }>;
    position?: Array<{ t: number; v: number | null }>;
    current?: Array<{ t: number; v: number | null }>;
    mode?: string;
  }>;
  battery?: Array<{ t: number; v: number | null }>;
  loopTime?: Array<{ t: number; v: number | null }>;
}): LiveLikeStore {
  const motorMap = new Map<string, {
    deviceName: string;
    powerHistory: any[];
    velocityHistory: any[];
    positionHistory: any[];
    currentHistory: any[];
    mode: string | null;
  }>();
  for (const m of (opts.motors ?? [])) {
    motorMap.set(m.name, {
      deviceName: m.name,
      powerHistory: m.power ?? [],
      velocityHistory: m.velocity ?? [],
      positionHistory: m.position ?? [],
      currentHistory: m.current ?? [],
      mode: m.mode ?? null,
    });
  }
  const loopTimeArr = opts.loopTime ?? [];
  const channelMap = new Map<string, { history: Array<{ t: number; v: number | null }> }>();
  channelMap.set('system.loopTimeMs', { history: loopTimeArr });
  return {
    getMotorNames: () => Array.from(motorMap.keys()),
    getMotor: (name) => motorMap.get(name),
    getBatteryHistory: () => opts.battery ?? [],
    getChannel: (name) => channelMap.get(name),
  };
}

/* ================================================================== */
/*  Live summary chips                                                */
/* ================================================================== */

describe('buildLiveSummaryChips', () => {
  it('emits the canonical 10-chip set', () => {
    const store = fakeStore({});
    const snap: LiveSnapshot = {
      schema_version: 1, active: true, session_id: 'abcdef1234',
      op_mode: 'TeleOp', recording_mode: 'EVERY_RUN',
      sequence: 7, timestamp_ms: 100, elapsed_ms: 12340,
      battery_voltage: 12.51, loop_time_ms: 18.4,
      motors: [], channels: [], events: [],
    };
    const chips = buildLiveSummaryChips({
      store, snap,
      connectionState: 'connected',
      observedHz: 4.0,
      motorCount: 4, channelCount: 6, eventCount: 2,
      lastSnapshotAtMs: Date.now(),
      conditions: [],
    });
    expect(chips.map((c) => c.kind)).toEqual([
      'connection', 'opMode', 'elapsed', 'battery',
      'loopTime', 'frequency', 'motorCount', 'channelCount',
      'eventCount', 'conditionCount',
    ]);
    // Battery uses unit 'V' computed by formatVoltage -> 12.51 V.
    const battery = chips.find((c) => c.kind === 'battery')!;
    expect(battery.value).toBe('12.51 V');
    expect(battery.unit).toBe('V');
    // Connection surfaces current label.
    const conn = chips.find((c) => c.kind === 'connection')!;
    expect(conn.value).toBe('Connected');
    expect(conn.statusClass).toContain('rh-status--stable');
  });

  it('missing battery uses MISSING sentinel rather than 0', () => {
    const store = fakeStore({});
    const snap: LiveSnapshot = {
      schema_version: 1, active: true, session_id: null,
      op_mode: null, recording_mode: null,
      sequence: 1, timestamp_ms: 100, elapsed_ms: 0,
      battery_voltage: null, loop_time_ms: null,
      motors: [], channels: [], events: [],
    };
    const chips = buildLiveSummaryChips({
      store, snap,
      connectionState: 'no_session',
      observedHz: 0, motorCount: 0, channelCount: 0, eventCount: 0,
      lastSnapshotAtMs: null,
      conditions: [],
    });
    const battery = chips.find((c) => c.kind === 'battery')!;
    expect(battery.value).toBe(MISSING);
    expect(battery.secondary).toBe('no battery reading');
    const conn = chips.find((c) => c.kind === 'connection')!;
    expect(conn.value).toBe('No active session');
    expect(conn.statusClass).toContain('rh-status--missing');
  });

  it('counts conditions (no v1/v2 wording in any chip label)', () => {
    const store = fakeStore({});
    const chips = buildLiveSummaryChips({
      store, snap: null,
      connectionState: 'no_session',
      observedHz: 0, motorCount: 0, channelCount: 0, eventCount: 0,
      lastSnapshotAtMs: null,
      conditions: [],
    });
    for (const c of chips) {
      expect(c.label.toLowerCase()).not.toContain('v1');
      expect(c.label.toLowerCase()).not.toContain('v2');
      expect(c.label.toLowerCase()).not.toContain('legacy');
    }
    const cond = chips.find((c) => c.kind === 'conditionCount')!;
    expect(cond.value).toBe('0');
    expect(cond.secondary).toBe('no advisories this window');
  });
});

/* ================================================================== */
/*  Motor card descriptors                                            */
/* ================================================================== */

describe('buildMotorCardDescriptors', () => {
  it('emits metrics in canonical order Power, Position, Velocity, Current', () => {
    const store = fakeStore({
      motors: [{
        name: 'frontLeft',
        power: [{ t: 1, v: 0.62 }, { t: 2, v: 0.61 }],
        position: [{ t: 1, v: 2000 }],
        velocity: [{ t: 1, v: 1320 }],
        mode: 'RUN_USING_ENCODER',
      }],
    });
    const snap: LiveSnapshot = {
      schema_version: 1, active: true, session_id: 'x',
      op_mode: null, recording_mode: null,
      sequence: 1, timestamp_ms: 100, elapsed_ms: 0,
      battery_voltage: null, loop_time_ms: null,
      motors: [], channels: [], events: [],
    };
    const cards = buildMotorCardDescriptors({
      store, snap,
      observedNowMs: 5,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].deviceName).toBe('frontLeft');
    expect(cards[0].mode).toBe('RUN_USING_ENCODER');
    expect(cards[0].metricRows.map((r) => r.label)).toEqual([
      'Power', 'Position', 'Velocity', 'Current',
    ]);
    // Power has 0.62 -> formatted via formatPower -> "0.62".
    expect(cards[0].metricRows[0].value).toBe('0.62');
    expect(cards[0].metricRows[1].value).toMatch(/ticks/);
    expect(cards[0].metricRows[0].tone).toBe('normal');
  });

  it('missing velocity marks the metric as missing', () => {
    const store = fakeStore({
      motors: [{
        name: 'frontRight',
        power: [],
        velocity: [],
        mode: 'STOP',
      }],
    });
    const snap: LiveSnapshot = {
      schema_version: 1, active: true, session_id: null,
      op_mode: null, recording_mode: null,
      sequence: 1, timestamp_ms: 100, elapsed_ms: 0,
      battery_voltage: null, loop_time_ms: null,
      motors: [], channels: [], events: [],
    };
    const cards = buildMotorCardDescriptors({ store, snap, observedNowMs: 5 });
    const velocity = cards[0].metricRows.find((r) => r.label === 'Velocity')!;
    expect(velocity.value).toBe(MISSING);
    expect(velocity.tone).toBe('missing');
  });

  it('returns empty array when store has no motors', () => {
    const store = fakeStore({});
    const snap: LiveSnapshot = {
      schema_version: 1, active: true, session_id: null,
      op_mode: null, recording_mode: null,
      sequence: 1, timestamp_ms: 100, elapsed_ms: 0,
      battery_voltage: null, loop_time_ms: null,
      motors: [], channels: [], events: [],
    };
    const cards = buildMotorCardDescriptors({ store, snap, observedNowMs: 5 });
    expect(cards).toEqual([]);
  });
});

/* ================================================================== */
/*  Compare summary + per-motor expandable cards                      */
/* ================================================================== */

describe('buildCompareSummary', () => {
  it('produces the canonical chip set even when no out is supplied', () => {
    const out = buildCompareSummary({ ref: null, cmp: null, out: null });
    expect(out.chips.length).toBeGreaterThanOrEqual(5);
    expect(out.chips.find((c) => c.kind === 'refRun')!.value).toBe('Not selected');
    expect(out.chips.find((c) => c.kind === 'cmpRun')!.value).toBe('Not selected');
    // Without args, no per-motor cards.
    expect(out.cards).toEqual([]);
  });

  it('counts statuses by enum and renders 5 metric rows per card', () => {
    const fakeRows: any[] = [
      {
        deviceName: 'frontLeft', status: 'Stable',
        presenceStatus: 'In Both',
        comparableSampleCountA: 100, comparableSampleCountB: 100,
        refMedianVelocity: 1320, cmpMedianVelocity: 1320,
        absDiffMedianVelocity: 0, medianVelocityChangePct: 0,
        refVelocityEfficiency: 0.95, cmpVelocityEfficiency: 0.96,
        absDiffVelocityEfficiency: 0.01, velocityEfficiencyChangePct: 0.0105,
        refCurrentCost: 5, cmpCurrentCost: 6,
        absDiffCurrentCost: 1, currentCostChangePct: 0.2,
        refP95Current: 2, cmpP95Current: 2.4,
        absDiffP95Current: 0.4, p95CurrentChangePct: 0.20,
        refStallPct: 0.05, cmpStallPct: 0.07,
        absDiffStallPct: 0.02, possibleStallChangePct: 0.4,
      },
      {
        deviceName: 'backRight', status: 'Missing',
        presenceStatus: 'Missing in Comparison',
        comparableSampleCountA: 0, comparableSampleCountB: 0,
        refMedianVelocity: 1300, cmpMedianVelocity: null,
        absDiffMedianVelocity: null, medianVelocityChangePct: null,
        refVelocityEfficiency: null, cmpVelocityEfficiency: null,
        absDiffVelocityEfficiency: null, velocityEfficiencyChangePct: null,
        refCurrentCost: null, cmpCurrentCost: null,
        absDiffCurrentCost: null, currentCostChangePct: null,
        refP95Current: null, cmpP95Current: null,
        absDiffP95Current: null, p95CurrentChangePct: null,
        refStallPct: null, cmpStallPct: null,
        absDiffStallPct: null, possibleStallChangePct: null,
      },
      {
        deviceName: 'backLeft', status: 'Insufficient Data',
        presenceStatus: 'In Both',
        comparableSampleCountA: 5, comparableSampleCountB: 4,
        refMedianVelocity: 100, cmpMedianVelocity: 100,
        absDiffMedianVelocity: 0, medianVelocityChangePct: 0,
        refVelocityEfficiency: null, cmpVelocityEfficiency: null,
        absDiffVelocityEfficiency: null, velocityEfficiencyChangePct: null,
        refCurrentCost: null, cmpCurrentCost: null,
        absDiffCurrentCost: null, currentCostChangePct: null,
        refP95Current: null, cmpP95Current: null,
        absDiffP95Current: null, p95CurrentChangePct: null,
        refStallPct: null, cmpStallPct: null,
        absDiffStallPct: null, possibleStallChangePct: null,
      },
    ];
    const out = buildCompareSummary({
      ref: { opmodeName: 'TeleOp', runId: 'ref0123xyz', samples: [], deviceNames: [], channels: { channelNames: [] }, truncated: false, buildIdentifier: 'b1' } as any,
      cmp: { opmodeName: 'TeleOp2', runId: 'cmp0123xyz', samples: [], deviceNames: [], channels: { channelNames: [] }, truncated: false, buildIdentifier: 'b1' } as any,
      out: { rows: fakeRows },
    });
    expect(out.chips.find((c) => c.kind === 'stable')!.value).toBe('1');
    expect(out.chips.find((c) => c.kind === 'missing')!.value).toBe('1');
    expect(out.chips.find((c) => c.kind === 'insufficient')!.value).toBe('1');
    expect(out.chips.find((c) => c.kind === 'changed')!.value).toBe('0');
    expect(out.cards).toHaveLength(3);
    const stable = out.cards.find((c) => c.deviceName === 'frontLeft')!;
    expect(stable.statusClass).toContain('rh-status--stable');
    expect(stable.expandedRows).toHaveLength(5);
    expect(stable.expandedRows[0].metric).toBe('Median velocity');
    expect(stable.expandedRows[0].reference).toMatch(/ticks\/s/);
    expect(stable.expandedRows[3].metric).toBe('P95 current');
    expect(stable.expandedRows[3].reference).toMatch(/A/);
    const missing = out.cards.find((c) => c.deviceName === 'backRight')!;
    expect(missing.statusClass).toContain('rh-status--missing');
    expect(missing.expandedRows[0].reference).toBe(MISSING);
  });

  it('null *ChangePct renders as MISSING in the percent column', () => {
    const fakeRows: any[] = [{
      deviceName: 'm', status: 'Missing',
      presenceStatus: 'Missing in Comparison',
      comparableSampleCountA: 0, comparableSampleCountB: 0,
      refMedianVelocity: null, cmpMedianVelocity: null,
      absDiffMedianVelocity: null, medianVelocityChangePct: null,
      refVelocityEfficiency: null, cmpVelocityEfficiency: null,
      absDiffVelocityEfficiency: null, velocityEfficiencyChangePct: null,
      refCurrentCost: null, cmpCurrentCost: null,
      absDiffCurrentCost: null, currentCostChangePct: null,
      refP95Current: null, cmpP95Current: null,
      absDiffP95Current: null, p95CurrentChangePct: null,
      refStallPct: null, cmpStallPct: null,
      absDiffStallPct: null, possibleStallChangePct: null,
    }];
    const out = buildCompareSummary({
      ref: null, cmp: null, out: { rows: fakeRows },
    });
    const card = out.cards[0];
    for (const row of card.expandedRows) {
      expect(row.percentDifference).toBe(MISSING);
      expect(row.rawDifference).toBe(MISSING);
    }
  });
});

/* ================================================================== */
/*  Import summary                                                    */
/* ================================================================== */

describe('buildImportSummary', () => {
  it('counts recognized runs vs rejected files', () => {
    const rejected = [
      { filename: 'a.csv', ok: false, sizeKb: 1, reason: 'parse_error' },
      { filename: 'b.csv', ok: false, sizeKb: 2, reason: 'unsupported_ext' },
    ];
    const out = buildImportSummary({
      importedRunIds: ['r1', 'r2'],
      rejected,
    });
    expect(out.runCount).toBe(2);
    expect(out.warningCount).toBe(2);
    expect(out.openRunId).toBe('r2');
    // Recognized files = imported runs count (rejected ok-count is zero here).
    expect(out.recognizedFiles).toBe(2);
  });
});

/* ================================================================== */
/*  Condition rows                                                    */
/* ================================================================== */

describe('buildConditionRows', () => {
  it('maps severity to the correct css class', () => {
    const rows = buildConditionRows([
      {
        key: 'stall:m', severity: 'warning', target: 'm',
        observation: 'Power was commanded while reported velocity remained low.',
        suggestedInspection: 'Check the mechanism, wiring, motor, and encoder.',
        latestTimestampMs: 1000, repetitionCount: 3,
      },
      {
        key: 'battery:drop', severity: 'info', target: 'battery',
        observation: 'Battery voltage dropped while motor load increased.',
        suggestedInspection: 'Check battery charge, connectors, wiring, and total robot load.',
        latestTimestampMs: 2000, repetitionCount: 1,
        values: [{ label: 'first', valueText: '12.7 V' }, { label: 'last', valueText: '11.9 V' }],
      },
    ]);
    expect(rows[0].severityClass).toBe('rh-condition--warning');
    expect(rows[1].severityClass).toBe('rh-condition--info');
    expect(rows[0].count).toBe(3);
    expect(rows[1].values).toHaveLength(2);
  });
});

/* ================================================================== */
/*  Fraction-pct formatters                                           */
/* ================================================================== */

describe('formatFractionPct', () => {
  it('multiplies a 0..1 fraction to a percent', () => {
    expect(formatFractionPct(0.62)).toBe('62.0%');
    expect(formatFractionPct(0.0)).toBe('0.0%');
    expect(formatFractionPct(0.123)).toBe('12.3%');
  });
  it('signed variant never strips explicit + or -', () => {
    expect(formatFractionPctSigned(0.10)).toBe('+10.0%');
    expect(formatFractionPctSigned(-0.10)).toBe('-10.0%');
    expect(formatFractionPctSigned(0)).toBe('0.0%');
  });
  it('MISSING for null/undefined/NaN/infinity', () => {
    expect(formatFractionPct(null)).toBe(MISSING);
    expect(formatFractionPct(undefined)).toBe(MISSING);
    expect(formatFractionPct(Number.NaN)).toBe(MISSING);
    expect(formatFractionPct(Number.POSITIVE_INFINITY)).toBe(MISSING);
  });
});

describe('formatSignedDiff', () => {
  it('adds + or - sign, returns MISSING instead of zero', () => {
    expect(formatSignedDiff(1.5)).toBe('+1.50');
    expect(formatSignedDiff(-1.5)).toBe('-1.50');
    expect(formatSignedDiff(0)).toBe('0.00');
    expect(formatSignedDiff(null)).toBe(MISSING);
    expect(formatSignedDiff(Number.NaN)).toBe(MISSING);
  });
});
