/**
 * Pure-logic observer: scan a LiveStore snapshot for advisory conditions
 * the team should know about.  Testable without DOM because the only
 * inputs are structural types {@link LiveLikeStore} and {@link LiveLikeSnap}
 * (a subset of the LiveStore class API).
 *
 * <p>Returned conditions use ONLY measured-language wording that never
 * claims a confirmed mechanical fault.  The sealed {@link OBSERVATION_TEMPLATES}
 * allow-list is the single source of these strings; callers must not
 * synthesise free-form messages.
 */
import { DEFAULT_THRESHOLDS, StatusThresholds } from './types.js';

export type ObservationSeverity = 'info' | 'warning';

export interface ObservedCondition {
  /** Distinct key used for repetition grouping (one entry per kind+target). */
  key: string;
  severity: ObservationSeverity;
  /** Motor name or channel name the observation refers to. */
  target: string;
  /** Short observation summary - always taken from OBSERVATION_TEMPLATES. */
  observation: string;
  /** Suggested inspection step - always taken from OBSERVATION_TEMPLATES. */
  suggestedInspection: string;
  /** Latest-occurrence timestamp in milliseconds since-epoch. */
  latestTimestampMs: number;
  /** Total repetitions observed in the current rolling window. */
  repetitionCount: number;
  /** Optional captured value(s) for context.  No fabricated numbers. */
  values?: { label: string; valueText: string }[];
}

/**
 * Minimal structural contract taken from LiveStore so unit tests can
 * construct fake stores without instantiating the live module.
 */
export interface LiveLikeStore {
  getMotorNames(): string[];
  getMotor(name: string): {
    deviceName: string;
    powerHistory: Array<{ t: number; v: number | null }>;
    velocityHistory: Array<{ t: number; v: number | null }>;
    currentHistory?: Array<{ t: number; v: number | null }>;
    mode: string | null;
  } | undefined;
  getBatteryHistory(): Array<{ t: number; v: number | null }>;
  getChannel(name: string): {
    history: Array<{ t: number; v: number | null }>;
  } | undefined;
}

/**
 * Minimal structural contract for a single live snapshot.  Optional so
 * tests can pass an undefined snapshot when "no active session".
 */
export interface LiveLikeSnap {
  battery_voltage?: number | null;
  loop_time_ms?: number | null;
}

/** Sewn-away wording strings.  No free-form user claims. */
export const OBSERVATION_TEMPLATES = {
  POWER_COMMANDED_VELOCITY_LOW: {
    observation: 'Power was commanded while reported velocity remained low.',
    inspection: 'Check the mechanism, wiring, motor, and encoder.',
  },
  BATTERY_DROP: {
    observation: 'Battery voltage dropped while motor load increased.',
    inspection: 'Check battery charge, connectors, wiring, and total robot load.',
  },
  LOOP_TIME_INCREASED: {
    observation: 'Loop time increased during this interval.',
    inspection: 'Review telemetry, vision, sensor, and control-loop workload.',
  },
} as const;

/**
 * Detect "power commanded but velocity stayed low" pairs.  We iterate the
 * recent window of each motor's powerHistory and look for any sample where
 * |power| > {@link stallPowerThreshold} AND velocityHistoryAT-orAfter
 * has at most 1 sample with |velocity| > {@link stallVelocityThresholdTps}
 * within the next 1 s.  If found, count one occurrence per pair.
 */
function countStallOccurrences(
  powerHistory: Array<{ t: number; v: number | null }>,
  velocityHistory: Array<{ t: number; v: number | null }>,
  thresholds: StatusThresholds,
): { count: number; latest: number } {
  let count = 0;
  let latest = -1;
  let vIdx = 0;
  for (let i = 0; i < powerHistory.length; i++) {
    const p = powerHistory[i];
    if (p.v == null || Math.abs(p.v) <= thresholds.stallPowerThreshold) continue;
    const t0 = p.t;
    // advance vIdx past anything older than t0
    while (vIdx < velocityHistory.length && velocityHistory[vIdx].t < t0) vIdx += 1;
    let anyFast = false;
    for (let j = vIdx; j < velocityHistory.length; j++) {
      const vp = velocityHistory[j];
      if (vp.t > t0 + 1000) break;
      if (vp.v != null && Math.abs(vp.v) > thresholds.stallVelocityThresholdTps) {
        anyFast = true;
        break;
      }
    }
    if (!anyFast) {
      count += 1;
      if (p.t > latest) latest = p.t;
    }
  }
  return { count, latest };
}

/**
 * Detect a monotonic battery drop over the rolling window: latest reading
 * below min-by-0.5 V relative to first reading in the window.
 */
function assessBatteryDrop(
  batteryHistory: Array<{ t: number; v: number | null }>,
): { occurred: boolean; latestTimestampMs: number; first: number | null; last: number | null } {
  let first: number | null = null;
  let last: number | null = null;
  let latestT = -1;
  for (const e of batteryHistory) {
    if (e.v == null || !Number.isFinite(e.v)) continue;
    if (first == null) first = e.v;
    last = e.v;
    if (e.t > latestT) latestT = e.t;
  }
  if (first == null || last == null) {
    return { occurred: false, latestTimestampMs: latestT < 0 ? Date.now() : latestT, first, last };
  }
  return {
    occurred: last < first - 0.5,
    latestTimestampMs: latestT < 0 ? Date.now() : latestT,
    first,
    last,
  };
}

/**
 * Detect a loop-time spike within the rolling window via the
 * `system.loopTimeMs` channel (the canonical location for loop-time).
 */
function countLoopTimeSpikes(
  channelHistory: Array<{ t: number; v: number | null }>,
  warnMs: number = 35,
): { count: number; latest: number } {
  let count = 0;
  let latest = -1;
  let prev: number | null = null;
  for (const e of channelHistory) {
    if (e.v == null || !Number.isFinite(e.v)) { prev = null; continue; }
    if (prev != null && e.v > warnMs) {
      count += 1;
      if (e.t > latest) latest = e.t;
    }
    prev = e.v;
  }
  return { count, latest: latest < 0 ? (channelHistory.at(-1)?.t ?? -1) : latest };
}

/**
 * Group observations by (severity+target) so repetitions collapse to one
 * row + repetition count.
 */
function groupByKey(conds: ObservedCondition[]): ObservedCondition[] {
  const byKey = new Map<string, ObservedCondition>();
  for (const c of conds) {
    const prior = byKey.get(c.key);
    if (prior == null) {
      byKey.set(c.key, c);
    } else {
      const next: ObservedCondition = {
        ...prior,
        latestTimestampMs: Math.max(c.latestTimestampMs, prior.latestTimestampMs),
        repetitionCount: prior.repetitionCount + c.repetitionCount,
        values: c.values ?? prior.values,
      };
      byKey.set(c.key, next);
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => b.latestTimestampMs - a.latestTimestampMs,
  );
}

/**
 * Public entry point.  Returns grouped, deduped observed conditions.
 * @param store live store (or test-fake).  Powers + battery history + loop-time channel.
 * @param snap optional snapshot - currently unused but kept for future per-snap checks.
 * @param thresholds optional StatusThresholds override (default = DEFAULT_THRESHOLDS).
 */
export function analyzeLiveConditions(
  store: LiveLikeStore,
  _snap: LiveLikeSnap | null = null,
  thresholds: StatusThresholds = DEFAULT_THRESHOLDS,
): ObservedCondition[] {
  const out: ObservedCondition[] = [];

  // 1) motor-level stall checks.
  for (const name of store.getMotorNames()) {
    const m = store.getMotor(name);
    if (!m) continue;
    const { count, latest } = countStallOccurrences(
      m.powerHistory, m.velocityHistory, thresholds,
    );
    if (count > 0) {
      out.push({
        key: `stall:${name}`,
        severity: 'warning',
        target: name,
        observation: OBSERVATION_TEMPLATES.POWER_COMMANDED_VELOCITY_LOW.observation,
        suggestedInspection: OBSERVATION_TEMPLATES.POWER_COMMANDED_VELOCITY_LOW.inspection,
        latestTimestampMs: latest < 0 ? Date.now() : latest,
        repetitionCount: count,
      });
    }
  }

  // 2) battery drop advisory.
  const batteryHistory = store.getBatteryHistory();
  if (batteryHistory.length >= 4) {
    const { occurred, latestTimestampMs, first, last } = assessBatteryDrop(batteryHistory);
    if (occurred) {
      out.push({
        key: 'battery:drop',
        severity: 'info',
        target: 'battery',
        observation: OBSERVATION_TEMPLATES.BATTERY_DROP.observation,
        suggestedInspection: OBSERVATION_TEMPLATES.BATTERY_DROP.inspection,
        latestTimestampMs,
        repetitionCount: 1,
        values: [
          { label: 'first', valueText: first == null ? '\u2014' : `${first.toFixed(2)} V` },
          { label: 'last',  valueText: last  == null ? '\u2014' : `${last.toFixed(2)} V`  },
        ],
      });
    }
  }

  // 3) loop-time spikes via the canonical channel name.
  const loopTime = store.getChannel('system.loopTimeMs');
  if (loopTime) {
    const { count, latest } = countLoopTimeSpikes(loopTime.history);
    if (count > 0) {
      out.push({
        key: 'loopTime:spike',
        severity: 'info',
        target: 'system.loopTimeMs',
        observation: OBSERVATION_TEMPLATES.LOOP_TIME_INCREASED.observation,
        suggestedInspection: OBSERVATION_TEMPLATES.LOOP_TIME_INCREASED.inspection,
        latestTimestampMs: latest < 0 ? Date.now() : latest,
        repetitionCount: count,
      });
    }
  }

  return groupByKey(out);
}
