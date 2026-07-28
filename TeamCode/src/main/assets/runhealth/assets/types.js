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
];
export const DEFAULT_THRESHOLDS = {
    changedPct: 5,
    largeChangePct: 15,
    minSamples: 20,
    currentCostMinVelocityTps: 50,
    stallPowerThreshold: 0.20,
    stallVelocityThresholdTps: 50,
};
export const POWER_BANDS = {
    LOW: [0.15, 0.35],
    MEDIUM: [0.35, 0.65],
    HIGH: [0.65, 1.00],
};
export const POWER_BAND_DEFINITION = {
    LOW: '|p| ∈ [0.15, 0.35)',
    MEDIUM: '|p| ∈ [0.35, 0.65)',
    HIGH: '|p| ∈ [0.65, 1.00]',
    ALL_ACTIVE: '|p| ≥ 0.15 (all active bands)',
};
//# sourceMappingURL=types.js.map