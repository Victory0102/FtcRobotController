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
  medianVelocityChangePct: number | null;     // null if not enough data
  velocityEfficiencyChangePct: number | null;
  currentCostChangePct: number | null;
  p95CurrentChangePct: number | null;
  possibleStallChangePct: number | null;
  comparableSampleCountA: number;
  comparableSampleCountB: number;
  motorModeMismatch: boolean;
  status: 'Stable' | 'Changed' | 'Large Change' | 'Missing' | 'Insufficient Data' | 'Incompatible Data';
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
