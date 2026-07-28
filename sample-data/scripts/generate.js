#!/usr/bin/env node
/**
 * FTC Run Health — deterministic synthetic CSV fixture generator.
 *
 * Produces 20 fixture CSV files in ../  (sample-data/) intended for:
 *   - TypeScript unit tests in viewer/
 *   - Manual testing of the standalone viewer
 *   - Documentation examples
 *
 * Every numeric value is generated with a fixed seeded algorithm so the
 * fixtures are reproducible on any machine. Values are mathematically
 * consistent (e.g. current will be plausible for the commanded power and
 * velocity, battery voltage slowly decreases over a long run, etc.).
 *
 * Run:
 *   node generate.js
 *
 * Output: ../<fixture-name>.csv
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1';
const MOTOR_MODE = 'RUN_USING_ENCODER';
const COMMON_OPMODE = 'ExampleOpMode';
const RUN_STARTED_AT = '2025-03-15T10:00:00Z';
const SAMPLE_INTERVAL_MS = 100; // 10 Hz
const BATTERY_FULL_V = 12.6;
const BATTERY_NOMINAL_V = 12.0;
const BATTERY_LOW_V = 11.0;
const FLEET = ['leftFront', 'leftBack', 'rightFront', 'rightBack'];

const OUTPUT_DIR = path.resolve(__dirname, '..');

// ----- CSV helpers ---------------------------------------------------------

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function row(values) {
  return values.map(csvEscape).join(',');
}

// ----- seeded PRNG (mulberry32) -------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randRange(rng, min, max) {
  return min + (max - min) * rng();
}

function formatNum(n) {
  if (!Number.isFinite(n)) return '';
  // locale.US-style: dot decimal, no thousands separator, no scientific notation.
  // Round to 4 decimal places for floats, integers for ints.
  if (Number.isInteger(n)) return String(n);
  // Use Number.toFixed to avoid locale issues and keep precision bounded.
  return Number(n.toFixed(4)).toString();
}

function fmtInt(n) {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return '';
  return String(n);
}

// ----- sample construction -----------------------------------------------

/**
 * Build a single CSV string for a synthetic run.
 * @param {object} params shape:
 *   {
 *     run_id: string,
 *     opmode_name?: string,
 *     run_started_at?: string,
 *     motorProfiles: { [deviceName]: {fn:(tMs, rng, ctx)=>SampleRowData} },
 *     durationMs: number,
 *     batteryFn?: (tMs, rng)=>number,
 *     schemaVersion?: string,
 *     motorMode?: string,
 *   }
 */
function buildCsv(params) {
  const header = [
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
  const lines = [row(header)];
  const schema = params.schemaVersion || SCHEMA_VERSION;
  const opmode = params.opmodeName || COMMON_OPMODE;
  const startedAt = params.runStartedAt || RUN_STARTED_AT;
  const motorMode = params.motorMode || MOTOR_MODE;
  const interval = SAMPLE_INTERVAL_MS;
  const ticks = Math.floor(params.durationMs / interval);

  for (let i = 0; i < ticks; i++) {
    const tMs = i * interval;
    const rng = mulberry32(hashStr(params.run_id + ':' + tMs));
    const batteryV = params.batteryFn ? params.batteryFn(tMs, rng) : BATTERY_NOMINAL_V;
    for (const device of Object.keys(params.motorProfiles)) {
      const sample = params.motorProfiles[device](tMs, rng, { batteryV, runId: params.run_id });
      lines.push(row([
        schema,
        params.run_id,
        opmode,
        startedAt,
        fmtInt(tMs),
        device,
        sample.commandedPower === null ? '' : formatNum(sample.commandedPower),
        sample.encoderPositionTicks === null ? '' : fmtInt(sample.encoderPositionTicks),
        sample.encoderVelocity === null ? '' : formatNum(sample.encoderVelocity),
        sample.currentAmps === null ? '' : formatNum(sample.currentAmps),
        motorMode,
        sample.batteryOverride !== undefined ? formatNum(sample.batteryOverride) : formatNum(batteryV),
      ]));
    }
  }
  // Always end with a trailing newline — POSIX.
  return lines.join('\n') + '\n';
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ----- motor profile factories -------------------------------------------

function healthyProfile(cmd, vel, cur) {
  // Slight per-sample jitter on velocity and current.
  return function (tMs, rng) {
    const jp = (cmd === 0 ? 0 : (rng() - 0.5) * 0.04);
    const jv = (vel === 0 ? 0 : (rng() - 0.5) * 60);
    const jc = (rng() - 0.5) * 0.1;
    return {
      commandedPower: cmd === 0 ? 0 : clamp(cmd + jp, -1, 1),
      encoderPositionTicks: Math.round(tMs * vel / 1000),
      encoderVelocity: vel === 0 ? 0 : vel + jv,
      currentAmps: clamp(cur + jc, 0, 8),
    };
  };
}

function unhealthyProfile(cmd, vel, cur, opts) {
  return function (tMs, rng) {
    const jp = (cmd === 0 ? 0 : (rng() - 0.5) * 0.04);
    const jv = (vel === 0 ? 0 : (rng() - 0.5) * 60);
    const jc = (rng() - 0.5) * 0.15;
    return {
      commandedPower: cmd === 0 ? 0 : clamp(cmd + jp, -1, 1),
      encoderPositionTicks: Math.round(tMs * vel / 1000),
      encoderVelocity: vel === 0 ? vel : vel + jv,
      currentAmps: (opts && opts.noCurrent) ? null : clamp(cur + jc, 0, 8),
    };
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Battery helper
function batteryCurve(startV, endV, durationMs) {
  return function (tMs) {
    if (durationMs <= 0) return startV;
    const t = tMs / durationMs;
    return startV + (endV - startV) * t;
  };
}

// ----- generators --------------------------------------------------------

function writeFixture(name, csvText) {
  const out = path.join(OUTPUT_DIR, name + '.csv');
  fs.writeFileSync(out, csvText, 'utf8');
  console.log('wrote', out);
}

function fleet(profileFactory) {
  const m = {};
  for (const n of FLEET) m[n] = profileFactory(n);
  return m;
}

function uniformHealthy(cmd, vel, cur) {
  return fleet(() => healthyProfile(cmd, vel, cur));
}

// 1. healthy-baseline.csv
{
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000001',
    durationMs: 5000,
    motorProfiles: uniformHealthy(0.5, 2000, 1.5),
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
  });
  writeFixture('healthy-baseline', csv);
}

// 2. healthy-similar.csv
{
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000002',
    durationMs: 5000,
    motorProfiles: uniformHealthy(0.5, 2003, 1.52), // 0.15% velocity drift, 1.3% current drift
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
  });
  writeFixture('healthy-similar', csv);
}

// 3. slower-motor.csv (leftFront velocity dropped ~12%)
{
  const profiles = {};
  for (const n of FLEET) {
    if (n === 'leftFront') profiles[n] = healthyProfile(0.5, 1760, 1.7);
    else profiles[n] = healthyProfile(0.5, 2000, 1.5);
  }
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000003',
    durationMs: 5000,
    motorProfiles: profiles,
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
  });
  writeFixture('slower-motor', csv);
}

// 4. higher-current.csv (leftFront current 19% higher)
{
  const profiles = {};
  for (const n of FLEET) {
    if (n === 'leftFront') profiles[n] = healthyProfile(0.5, 2000, 1.8);
    else profiles[n] = healthyProfile(0.5, 2000, 1.5);
  }
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000004',
    durationMs: 5000,
    motorProfiles: profiles,
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
  });
  writeFixture('higher-current', csv);
}

// 5–9. gradual-deterioration-01..05.csv
{
  const severities = [0.02, 0.06, 0.11, 0.16, 0.22];
  const ids = ['05', '06', '07', '08', '09'];
  severities.forEach((loss, i) => {
    const vel = Math.round(2000 * (1 - loss));
    const cur = +(1.5 * (1 + loss * 0.7)).toFixed(3);
    const profiles = fleet(() => healthyProfile(0.5, vel, cur));
    const csv = buildCsv({
      run_id: '00000000-aaaa-0000-0000-0000000000' + ids[i],
      durationMs: 5000,
      motorProfiles: profiles,
      batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
    });
    writeFixture('gradual-deterioration-0' + (i + 1), csv);
  });
}

// 10. missing-current-data.csv
{
  const profiles = {};
  for (const n of FLEET) profiles[n] = unhealthyProfile(0.5, 2000, 1.5, { noCurrent: true });
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000010',
    durationMs: 5000,
    motorProfiles: profiles,
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
  });
  writeFixture('missing-current-data', csv);
}

// 11. insufficient-samples.csv (<10 active samples total)
{
  const profiles = fleet(() => healthyProfile(0, 0, 0));
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000011',
    durationMs: 800, // 8 samples total per motor
    motorProfiles: profiles,
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 800),
  });
  writeFixture('insufficient-samples', csv);
}

// 12. forward-reverse-differences.csv
{
  const profiles = {};
  for (const n of FLEET) {
    profiles[n] = function (tMs, rng) {
      // alternate forward/reverse every 1s, with expected ~negative velocity for reverse
      const phase = Math.floor(tMs / 1000) % 2; // 0 forward, 1 reverse
      const cmd = phase === 0 ? 0.5 : -0.5;
      const vel = phase === 0 ? 2000 : -2000;
      const cur = 1.5;
      return healthyProfile(cmd, vel, cur)(tMs, rng);
    };
  }
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000012',
    durationMs: 4000,
    motorProfiles: profiles,
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 4000),
  });
  writeFixture('forward-reverse-differences', csv);
}

// 13. low-battery-run.csv
{
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000013',
    durationMs: 5000,
    motorProfiles: uniformHealthy(0.5, 1700, 1.6), // sag under low battery
    batteryFn: batteryCurve(BATTERY_LOW_V, BATTERY_LOW_V - 0.4, 5000),
  });
  writeFixture('low-battery-run', csv);
}

// 14. missing-motor-run.csv (rightBack device not present)
{
  const profiles = {};
  for (const n of FLEET) {
    if (n === 'rightBack') continue;
    profiles[n] = healthyProfile(0.5, 2000, 1.5);
  }
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000014',
    durationMs: 5000,
    motorProfiles: profiles,
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
  });
  writeFixture('missing-motor-run', csv);
}

// 15. renamed-motor-run.csv  (devices renamed vs baseline: slideRight vs rightSlide pattern)
{
  const profiles = {};
  for (const n of FLEET) profiles['slide' + capitalize(n)] = healthyProfile(0.5, 2000, 1.5);
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000015',
    durationMs: 5000,
    motorProfiles: profiles,
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
  });
  writeFixture('renamed-motor-run', csv);
  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
}

// 16. different-motor-mode-run.csv (RUN_WITHOUT_ENCODER mode)
{
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000016',
    durationMs: 5000,
    motorProfiles: uniformHealthy(0.5, 2000, 1.5),
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
    motorMode: 'RUN_WITHOUT_ENCODER',
  });
  writeFixture('different-motor-mode-run', csv);
}

// 17. duplicate-run-id.csv (same ID as healthy-baseline)
{
  const csv = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000001',
    durationMs: 5000,
    motorProfiles: uniformHealthy(0.55, 2010, 1.55),
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
  });
  writeFixture('duplicate-run-id', csv);
}

// 18. mixed-valid-invalid-rows.csv — bolt on a few bad rows
{
  const base = buildCsv({
    run_id: '00000000-aaaa-0000-0000-000000000017',
    durationMs: 5000,
    motorProfiles: uniformHealthy(0.5, 2000, 1.5),
    batteryFn: batteryCurve(BATTERY_FULL_V, BATTERY_NOMINAL_V, 5000),
  });
  const rows = base.split('\n');
  // Add a few corrupt rows scattered through the body.
  rows.splice(15, 0, 'this is,not,a,valid,row,with,extra,columns');
  rows.splice(40, 0, ',,,,,,,,,,'); // empty row
  rows.splice(80, 0, '1,bad-run-id,OpMode,2025-01-01T00:00:00Z,not-a-number,leftFront,0.5,0,2000,not-a-number,RUN_USING_ENCODER,12.4');
  const outCsv = rows.join('\n');
  writeFixture('mixed-valid-invalid-rows', outCsv);
}

// 19. unsupported-schema.csv
{
  const lines = [
    row([
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
    ]),
  ];
  const profiles = uniformHealthy(0.5, 2000, 1.5);
  let i = 0;
  for (const device of Object.keys(profiles)) {
    for (let t = 0; t < 3000; t += 100, i++) {
      const sample = profiles[device](t, mulberry32(hashStr('unsupported:' + t + ':' + i)));
      lines.push(row([
        '99', // unsupported future schema
        '00000000-aaaa-0000-0000-000000000099',
        COMMON_OPMODE,
        RUN_STARTED_AT,
        fmtInt(t),
        device,
        formatNum(sample.commandedPower),
        fmtInt(sample.encoderPositionTicks),
        formatNum(sample.encoderVelocity),
        formatNum(sample.currentAmps),
        MOTOR_MODE,
        formatNum(BATTERY_NOMINAL_V),
      ]));
    }
    break;
  }
  writeFixture('unsupported-schema', lines.join('\n') + '\n');
}

// 20. malformed-file.csv — half-broken
{
  const corrupt = [
    row(['schema_version', 'run_id', 'opmode_name', 'run_started_at', 'timestamp_ms', 'device_name', 'commanded_power', 'encoder_position_ticks', 'encoder_velocity_ticks_per_second', 'current_amps', 'motor_mode', 'battery_voltage']),
    'unbalanced quote " and a comma,here',
    ',,,,,,,,,',
    '[object Object],,,,,,,,',
    row(['1', '00000000-aaaa-0000-0000-000000000020', 'Bad', '2025-03-15T10:00:00Z', '0', 'leftFront', '0.5', '0', '2000', '1.5', 'RUN_USING_ENCODER', '12.4']),
  ];
  writeFixture('malformed-file', corrupt.join('\n') + '\n');
}

console.log('\nAll fixtures written to', OUTPUT_DIR);
