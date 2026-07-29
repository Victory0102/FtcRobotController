/**
 * Shared TypeScript types for FTC Run Health viewer.
 *
 * The viewer (browser) and synthetic-data fixtures share this contract so
 * runtime types stay in sync with the on-disk CSV.  Schema version is
 * validated at parse time.
 */

export const SCHEMA_VERSION = '1';

export const EXPECTED_COLUMNS = [
  'schema_version',
  'run_id',
  'opmode_name',
  'run_started_at',
  'timestamp_ms',
  'device_name',
  'commanded_power',
  'encoder_position_ticks',
  'encoder_velocity_ticks_per_second',
  'current_amps',
  'motor_mode',
  'battery_voltage',
] as const;

export type Column = typeof EXPECTED_COLUMNS[number];

/** A single raw row from the CSV, indexed by column name. */
export type Row = Readonly<Record<Column, string>>;

/** A parsed sample: nullable numerics for fields that may be blank. */
export interface Sample {
  runId: string;
  opmodeName: string;
  runStartedAt: string;
  timestampMs: number;
  deviceName: string;
  commandedPower: number | null;
  encoderPositionTicks: number | null;
  encoderVelocity: number | null;
  currentAmps: number | null;
  motorMode: string | null;
  batteryVoltage: number | null;
}

/** A complete parsed run. */
export interface Run {
  schemaVersion: string;
  runId: string;
  opmodeName: string;
  runStartedAt: string;
  deviceNames: string[];         // sorted, unique, non-empty
  samples: Sample[];
  truncated: boolean;            // footer marker detected?
  invalidRowCount: number;
  sourceFileName: string;
  /** Optional v2 channels.  Absent for legacy v1 runs. */
  channels?: ChannelSamples;
  /** Optional v2 manifest summary.  Absent for legacy v1 runs. */
  manifest?: RunManifestSummary;
  /** Build identifier (from manifest).  Convenience accessor; absent for legacy v1. */
  buildIdentifier?: string;
  /** Run duration in milliseconds (from manifest).  Convenience accessor; absent for legacy v1. */
  durationMs?: number;
  /** Configuration fingerprint hash (from manifest).  Convenience accessor; absent for legacy v1. */
  configFingerprint?: string;
}

/** A typed custom-channel sample published through RunHealthSession.put*(). */
export interface ChannelSample {
  timestampMs: number;
  channelName: string;
  kind: 'number' | 'boolean' | 'text' | 'event' | 'pose';
  // Only one of (valueNumber, valueBoolean, valueText, valueX/Y/heading) is set.
  valueNumber: number | null;
  valueBoolean: boolean | null;
  valueText: string | null;
  valueX: number | null;
  valueY: number | null;
  valueHeading: number | null;
  note: string | null;
}

/** Container of v2 channel samples partitioned by channel name. */
export interface ChannelSamples {
  /** Per-channel long-format samples, sorted by timestampMs ascending. */
  byChannel: Record<string, ChannelSample[]>;
  /** Total number of valid samples across all channels. */
  totalCount: number;
  /** Distinct channel names seen.  Sorted. */
  channelNames: string[];
}

/** Subset of the v2 manifest exposed to the UI. */
export interface RunManifestSummary {
  schemaVersion: string;
  runId: string;
  opmodeName: string;
  runStartedAt: string;
  durationMs: number;
  buildIdentifier: string;
  truncated: boolean;
  configFingerprint: string;
  deviceNames: string[];
  channels: ManifestChannel[];
}

export interface ManifestChannel {
  name: string;
  kind: 'number' | 'boolean' | 'text' | 'event' | 'pose';
  group: string;
  unit: string;
  description: string;
}

/* --------- Filtering inputs ---------- */

export type Direction = 'POSITIVE' | 'NEGATIVE' | 'BOTH';

export type PowerBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'ALL_ACTIVE';

export interface FilterSelection {
  direction: Direction;
  powerBand: PowerBand;
}

export interface MatchedMotor {
  deviceName: string;
  inReference: boolean;
  inComparison: boolean;
}

export interface MotorComparisonSummary {
  deviceName: string;
  presentInReference: boolean;
  presentInComparison: boolean;
  // Absolute values for each metric on the reference and comparison runs.
  // Populated from perMotorMetrics() at compute-time so the UI does not
  // need to duplicate the calculation just to render ref and cmp columns.
  refMedianVelocity: number | null;
  cmpMedianVelocity: number | null;
  refVelocityEfficiency: number | null;
  cmpVelocityEfficiency: number | null;
  refCurrentCost: number | null;
  cmpCurrentCost: number | null;
  refP95Current: number | null;
  cmpP95Current: number | null;
  refStallPct: number | null;
  cmpStallPct: number | null;
  // Raw-unit differences (cmp - ref) for every metric.  null when either
  // side of the comparison is missing or non-finite.  These are computed
  // independently of the percent-change values so the team can see both
  // magnitude-of-delta and relative-delta side by side.
  absDiffMedianVelocity: number | null;
  absDiffVelocityEfficiency: number | null;
  absDiffCurrentCost: number | null;
  absDiffP95Current: number | null;
  absDiffStallPct: number | null;
  medianVelocityChangePct: number | null;     // null if not enough data
  velocityEfficiencyChangePct: number | null;
  currentCostChangePct: number | null;
  p95CurrentChangePct: number | null;
  possibleStallChangePct: number | null;
  comparableSampleCountA: number;
  comparableSampleCountB: number;
  // Per-run presence flags for current (amps) and battery voltage.  Both
  // are stored as nullable on individual samples; this is the per-run
  // summary so the UI can label each row "Current: yes/no".
  hasCurrentRef: boolean;
  hasCurrentCmp: boolean;
  hasVoltageRef: boolean;
  hasVoltageCmp: boolean;
  motorModeMismatch: boolean;
  // Granular missing status: distinguishes "missing only from ref" and
  // "missing only from cmp" so the UI does not collapse both into one.
  presenceStatus:
    | 'In Both'
    | 'Missing in Reference'
    | 'Missing in Comparison'
    | 'Missing in Both';
  status: 'Stable' | 'Changed' | 'Large Change' | 'Missing' | 'Insufficient Data' | 'Incompatible Data';
}

/* ===== Custom-channel numeric summary for one (run, channelName) ===== */

/** Summary statistics for a numeric custom channel on one run. */
export interface NumericChannelSummary {
  channelName: string;
  unit: string;
  group: string;
  description: string;
  kind: 'number';
  min: number | null;
  max: number | null;
  median: number | null;
  final: number | null;
  sampleCount: number;
}

/** Summary statistics for a boolean custom channel on one run. */
export interface BooleanChannelSummary {
  channelName: string;
  kind: 'boolean';
  transitionCount: number;
  timeTrueMs: number;
  totalDurationMs: number;
  finalState: boolean | null;
  firstState: boolean | null;
}

/** Summary statistics for a text custom channel on one run. */
export interface TextChannelSummary {
  channelName: string;
  kind: 'text';
  firstState: string | null;
  finalState: string | null;
  transitions: { atMs: number; from: string; to: string }[];
}

/** Numeric-channel deltas across two runs (no text percentages). */
export interface NumericChannelComparison {
  channelName: string;
  unit: string;
  ref: NumericChannelSummary;
  cmp: NumericChannelSummary;
  absDiffMedian: number | null;
  absDiffMin: number | null;
  absDiffMax: number | null;
  absDiffFinal: number | null;
  pctDiffMedian: number | null;        // null when ref = 0 or missing
  pctDiffMin: number | null;
  pctDiffMax: number | null;
  pctDiffFinal: number | null;
}

/** Boolean-channel comparison.  Text percentages are intentionally NOT
 *  computed anywhere. */
export interface BooleanChannelComparison {
  channelName: string;
  kind: 'boolean';
  refTransitionCount: number;
  cmpTransitionCount: number;
  refTimeTrueMs: number;
  cmpTimeTrueMs: number;
  refFinal: boolean | null;
  cmpFinal: boolean | null;
}

/** Text-channel comparison without text percentages (per spec). */
export interface TextChannelComparison {
  channelName: string;
  kind: 'text';
  ref: TextChannelSummary;
  cmp: TextChannelSummary;
  sharedStatesYesNo: boolean;
}

/* ===== Graph engine shared types ===== */

/** A single sample ready for plotting. {@link gap} is true when the gap
 *  between consecutive samples exceeds {@link gapThresholdMs}; the renderer
 *  must use moveTo() instead of lineTo() to avoid drawing across the gap. */
export interface SeriesPoint {
  /** Time in milliseconds since the run's first captured sample. */
  t: number;
  /** Numeric y-value. Used as-is by the renderer. */
  v: number;
  /** True if the gap from the previous point exceeds the policy threshold. */
  gap: boolean;
}

/** A named series with display state held separately from data. */
export interface Series {
  id: string;
  label: string;
  color: string;
  visible: boolean;
  points: SeriesPoint[];
}

/** A pair of timestamp domains used by the canvas scaler. */
export interface SeriesDomain {
  tMin: number;
  tMax: number;
  yMin: number;
  yMax: number;
}

/** Synchronised cursor state shared across all graphs. */
export interface CursorState {
  /** Replay time in milliseconds; null when no cursor is currently shown. */
  t: number | null;
  /** True when the user is hovering; the renderer dims non-hover series. */
  hover: boolean;
}

/** Trend chart data point.  {@link value} is null when the run did not
 *  carry enough data for the metric - the renderer skips it instead of
 *  collapsing to a zero line. */
export interface ChronoPoint {
  runId: string;
  runStartedAt: string;
  opmodeName: string;
  buildIdentifier: string;
  value: number | null;
  /** Delta vs the user's chosen baseline run.  null when no baseline or
   *  the value is missing. */
  baselineDelta: number | null;
  /** Delta vs the chronologically previous run in the same series. */
  previousDelta: number | null;
  /** All values are unavailable (insufficient samples) - separate from
   *  missing data on a single run; UI renders this as a "n/a". */
  insufficient: boolean;
}

export interface StatusThresholds {
  /** Percent change above which a metric is classified "Changed". */
  changedPct: number;
  /** Percent change above which a metric is classified "Large Change". */
  largeChangePct: number;
  /** Minimum samples required on each side for a comparable comparison. */
  minSamples: number;
  /** Minimum absolute velocity (ticks/s) used when computing current cost. */
  currentCostMinVelocityTps: number;
  /** Stall rule: power above this AND |velocity| below this counts as "stall". */
  stallPowerThreshold: number;
  stallVelocityThresholdTps: number;
}

export const DEFAULT_THRESHOLDS: StatusThresholds = {
  changedPct: 5,
  largeChangePct: 15,
  minSamples: 20,
  currentCostMinVelocityTps: 50,
  stallPowerThreshold: 0.20,
  stallVelocityThresholdTps: 50,
};

export const POWER_BANDS: Record<Exclude<PowerBand, 'ALL_ACTIVE'>, [number, number]> = {
  LOW: [0.15, 0.35],
  MEDIUM: [0.35, 0.65],
  HIGH: [0.65, 1.00],
};

export const POWER_BAND_DEFINITION: Record<PowerBand, string> = {
  LOW: '|p| ∈ [0.15, 0.35)',
  MEDIUM: '|p| ∈ [0.35, 0.65)',
  HIGH: '|p| ∈ [0.65, 1.00]',
  ALL_ACTIVE: '|p| ≥ 0.15 (all active bands)',
};

// =================================================================
// Live read-only telemetry types
// =================================================================

export interface LiveMotorView {
  device_name: string;
  power: number | null;
  position_ticks: number | null;
  velocity_ticks_per_second: number | null;
  current_amps: number | null;
  mode: string | null;
}

export interface LiveChannelView {
  name: string;
  kind: 'number' | 'boolean' | 'text' | 'pose' | 'event';
  value_number: number | null;
  value_boolean: boolean | null;
  value_text: string | null;
  pose_x: number | null;
  pose_y: number | null;
  pose_heading: number | null;
  unit: string | null;
  group: string | null;
  description: string | null;
}

export interface LiveEventView {
  timestamp_ms: number;
  label: string;
}

export interface LiveSnapshot {
  schema_version: 1;
  active: boolean;
  session_id: string | null;
  op_mode: string | null;
  recording_mode: string | null;
  sequence: number;
  timestamp_ms: number;
  elapsed_ms: number;
  battery_voltage: number | null;
  loop_time_ms: number | null;
  motors: LiveMotorView[];
  channels: LiveChannelView[];
  events: LiveEventView[];
  no_active_session?: boolean;
}

