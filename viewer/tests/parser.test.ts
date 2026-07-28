import { describe, it, expect } from 'vitest';
import { parseRunHealthCsv, detectDuplicates, sampleToRow } from '../src/parser.js';
import { SCHEMA_VERSION } from '../src/types.js';

describe('parseRunHealthCsv (happy path)', () => {
  it('parses the synthetic healthy-baseline fixture', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const url = await import('url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const csv = fs.readFileSync(path.resolve(here, '..', '..', 'sample-data', 'healthy-baseline.csv'), 'utf-8');
    const result = parseRunHealthCsv(csv, 'healthy-baseline.csv');
    if (result.kind !== 'ok') throw new Error('expected ok: ' + result.reason);
    expect(result.run.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.run.opmodeName).toBe('ExampleOpMode');
    expect(result.run.runStartedAt).toBe('2025-03-15T10:00:00Z');
    expect(result.run.samples.length).toBeGreaterThan(0);
    expect(result.run.deviceNames).toEqual(['leftBack', 'leftFront', 'rightBack', 'rightFront']);
  });
});

describe('parseRunHealthCsv (rejects malformed)', () => {
  it('rejects blank input', () => {
    const r = parseRunHealthCsv('', 'empty.csv');
    expect(r.kind).toBe('error');
  });
  it('rejects missing required columns', () => {
    const csv = `a,b,c,d\n1,2,3,4\n`;
    const r = parseRunHealthCsv(csv, 'bad.csv');
    expect(r.kind).toBe('error');
  });
  it('rejects unknown future schema version', () => {
    const header = [
      'schema_version', 'run_id', 'opmode_name', 'run_started_at',
      'timestamp_ms', 'device_name', 'commanded_power', 'encoder_position_ticks',
      'encoder_velocity_ticks_per_second', 'current_amps', 'motor_mode', 'battery_voltage',
    ];
    const lines = [header.join(','), `${99},run-1,Op,2025-01-01T00:00:00Z,0,leftFront,0.5,0,2000,1.5,RUN_USING_ENCODER,12`];
    const r = parseRunHealthCsv(lines.join('\n'), 'future.csv');
    expect(r.kind).toBe('error');
    expect(r.reason).toMatch(/schema/i);
  });
  it('handles malformed file (mixed valid + invalid rows)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const url = await import('url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const csv = fs.readFileSync(path.resolve(here, '..', '..', 'sample-data', 'mixed-valid-invalid-rows.csv'), 'utf-8');
    const r = parseRunHealthCsv(csv, 'mixed.csv');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.run.invalidRowCount).toBeGreaterThan(0);
    expect(r.run.samples.length).toBeGreaterThan(0);
  });
  it('handles malformed file baseline (gibberish)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const url = await import('url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const csv = fs.readFileSync(path.resolve(here, '..', '..', 'sample-data', 'malformed-file.csv'), 'utf-8');
    const r = parseRunHealthCsv(csv, 'malformed-file.csv');
    // Either ok (we got something usable) or error, but no crash.
    expect(['ok', 'error']).toContain(r.kind);
  });
  it('marks truncation footer', () => {
    const header = [
      'schema_version', 'run_id', 'opmode_name', 'run_started_at',
      'timestamp_ms', 'device_name', 'commanded_power', 'encoder_position_ticks',
      'encoder_velocity_ticks_per_second', 'current_amps', 'motor_mode', 'battery_voltage',
    ];
    const lines = [
      header.join(','),
      `${SCHEMA_VERSION},run-1,Op,2025-01-01T00:00:00Z,0,leftFront,0.5,0,2000,1.5,RUN_USING_ENCODER,12`,
      `${SCHEMA_VERSION},run-1,Op,2025-01-01T00:00:00Z,1000,__RUN_HEALTH_TRUNCATED__,,,,,,,TRUNCATED=1/1`,
    ];
    const r = parseRunHealthCsv(lines.join('\n'), 'tru.csv');
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.run.truncated).toBe(true);
    expect(r.run.samples.length).toBe(1);
  });
});

describe('numeric coercion', () => {
  it('keeps blank fields as null, not 0', () => {
    const header = [
      'schema_version', 'run_id', 'opmode_name', 'run_started_at',
      'timestamp_ms', 'device_name', 'commanded_power', 'encoder_position_ticks',
      'encoder_velocity_ticks_per_second', 'current_amps', 'motor_mode', 'battery_voltage',
    ];
    const lines = [
      header.join(','),
      `${SCHEMA_VERSION},run-1,Op,2025-01-01T00:00:00Z,0,leftFront,,,,,,12`,
    ];
    const r = parseRunHealthCsv(lines.join('\n'), 'blanks.csv');
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.run.samples.length).toBeGreaterThan(0);
    const s = r.run.samples[0];
    expect(s.commandedPower).toBe(null);
    expect(s.encoderVelocity).toBe(null);
  });
  it('rejects NaN strings', () => {
    const header = [
      'schema_version', 'run_id', 'opmode_name', 'run_started_at',
      'timestamp_ms', 'device_name', 'commanded_power', 'encoder_position_ticks',
      'encoder_velocity_ticks_per_second', 'current_amps', 'motor_mode', 'battery_voltage',
    ];
    const lines = [
      header.join(','),
      `${SCHEMA_VERSION},run-1,Op,2025-01-01T00:00:00Z,0,leftFront,not-a-number,0,2000,1.5,RUN_USING_ENCODER,12`,
    ];
    const r = parseRunHealthCsv(lines.join('\n'), 'nan.csv');
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.run.invalidRowCount).toBe(1);
  });
});

describe('detectDuplicates', () => {
  it('identifies duplicate run_id', () => {
    const header = [
      'schema_version', 'run_id', 'opmode_name', 'run_started_at',
      'timestamp_ms', 'device_name', 'commanded_power', 'encoder_position_ticks',
      'encoder_velocity_ticks_per_second', 'current_amps', 'motor_mode', 'battery_voltage',
    ];
    const lines = [
      header.join(','),
      `${SCHEMA_VERSION},run-1,Op,2025-01-01T00:00:00Z,0,leftFront,0.5,0,2000,1.5,RUN_USING_ENCODER,12`,
      `${SCHEMA_VERSION},run-2,Op,2025-01-01T00:00:00Z,0,leftFront,0.5,0,2000,1.5,RUN_USING_ENCODER,12`,
      `${SCHEMA_VERSION},run-1,Op,2025-01-01T00:00:00Z,0,leftFront,0.5,0,2000,1.5,RUN_USING_ENCODER,12`,
    ];
    const r = parseRunHealthCsv(lines.join('\n'), 'dup.csv');
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    const dup = detectDuplicates([r.run, r.run]);
    // Two of the same run, expect dups of run-1.
    expect(dup.size).toBeGreaterThan(0);
    expect(Array.from(dup.keys())[0]).toBe(r.run.runId);
  });
});
