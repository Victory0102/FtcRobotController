import { describe, it, expect } from 'vitest';
import {
  parseChannelsCsv,
  parseManifestJson,
  parseRunHealthCsv,
  parseUnifiedRun,
  detectDuplicates,
  sampleToRow,
  sanitizeText,
  runIdFromMotorCsv,
  runIdFromChannelsCsv,
  runIdFromManifestJson,
} from '../src/parser.js';
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
  it('rejects schema_version > 2 as unsupported', () => {
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
    expect(dup.size).toBeGreaterThan(0);
    expect(Array.from(dup.keys())[0]).toBe(r.run.runId);
  });
});

describe('v2 channels parser (parseChannelsCsv)', () => {
  it('parses a numeric-channel row', () => {
    const csv = [
      'timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note',
      '100,vel,number,12.5,,,,,,start',
    ].join('\n');
    const r = parseChannelsCsv(csv);
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.channels.totalCount).toBe(1);
    expect(r.channels.channelNames).toEqual(['vel']);
    expect(r.channels.byChannel['vel'][0].valueNumber).toBe(12.5);
    expect(r.channels.byChannel['vel'][0].kind).toBe('number');
    expect(r.channels.byChannel['vel'][0].timestampMs).toBe(100);
  });
  it('parses a boolean-channel row', () => {
    const csv = [
      'timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note',
      '100,is_ready,boolean,,true,,,',
    ].join('\n');
    const r = parseChannelsCsv(csv);
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.channels.byChannel['is_ready'][0].valueBoolean).toBe(true);
  });
  it('parses a text-channel row', () => {
    const csv = [
      'timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note',
      '100,auto.state,text,,,ready,',
    ].join('\n');
    const r = parseChannelsCsv(csv);
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.channels.byChannel['auto.state'][0].valueText).toBe('ready');
  });
  it('parses a pose-channel row', () => {
    const csv = [
      'timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note',
      '100,robot.pose,pose,,,,12.5,-7.25,1.5707963',
    ].join('\n');
    const r = parseChannelsCsv(csv);
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.channels.byChannel['robot.pose'][0].valueX).toBe(12.5);
    expect(r.channels.byChannel['robot.pose'][0].valueY).toBe(-7.25);
    expect(r.channels.byChannel['robot.pose'][0].valueHeading).toBeCloseTo(1.5707963, 6);
  });
  it('parses the canonical __event__ event row', () => {
    const csv = [
      'timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note',
      '100,__event__,event,,,Intake jam noticed,Intake jam noticed',
    ].join('\n');
    const r = parseChannelsCsv(csv);
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.channels.byChannel['__event__'][0].kind).toBe('event');
    expect(r.channels.byChannel['__event__'][0].note).toBe('Intake jam noticed');
  });
  it('rejects unsupported header', () => {
    const csv = ['a,b', '1,2'].join('\n');
    const r = parseChannelsCsv(csv);
    expect(r.kind).toBe('error');
  });
  it('counts malformed rows but still produces a result', () => {
    const csv = [
      'timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note',
      'bad,vel,number,1,,,,,,',     // non-finite timestamp
      '200,vel,number,2,,,,,,',     // valid
    ].join('\n');
    const r = parseChannelsCsv(csv);
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.channels.totalCount).toBe(1);
  });
});

describe('v2 manifest parser (parseManifestJson)', () => {
  it('parses a minimal manifest', () => {
    const j = JSON.stringify({
      schema_version: '2',
      run_id: 'abc-123',
      opmode_name: 'AutoOp',
      run_started_at: '2025-03-15T10:00:00Z',
      duration_ms: 12345,
      build_identifier: 'build-42',
      truncated: false,
      robot_config: { fingerprint: 'shahash', device_names: ['leftFront'] },
      channels: [
        { name: 'vel', kind: 'number', group: '', unit: 'tps', description: '' },
      ],
    });
    const r = parseManifestJson(j);
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.manifest.schemaVersion).toBe('2');
    expect(r.manifest.runId).toBe('abc-123');
    expect(r.manifest.opmodeName).toBe('AutoOp');
    expect(r.manifest.channels.length).toBe(1);
    expect(r.manifest.channels[0].name).toBe('vel');
    expect(r.manifest.channels[0].kind).toBe('number');
  });
  it('rejects bad JSON', () => {
    const r = parseManifestJson('not-json');
    expect(r.kind).toBe('error');
  });
  it('rejects schema_version 99 as unsupported', () => {
    const j = JSON.stringify({ schema_version: '99', run_id: 'x' });
    const r = parseManifestJson(j);
    expect(r.kind).toBe('error');
    expect(r.reason).toMatch(/schema/i);
  });
  it('rejects missing schema_version', () => {
    const j = JSON.stringify({ run_id: 'x' });
    const r = parseManifestJson(j);
    expect(r.kind).toBe('error');
  });
});

describe('parseUnifiedRun (legacy + v2 path)', () => {
  it('treats legacy motor CSV as v1', () => {
    const header = [
      'schema_version', 'run_id', 'opmode_name', 'run_started_at',
      'timestamp_ms', 'device_name', 'commanded_power', 'encoder_position_ticks',
      'encoder_velocity_ticks_per_second', 'current_amps', 'motor_mode', 'battery_voltage',
    ].join(',');
    const motorCsv = [
      header,
      `${SCHEMA_VERSION},run-L,Op,2025-01-01T00:00:00Z,0,leftFront,0.5,0,2000,1.5,RUN_USING_ENCODER,12`,
    ].join('\n');
    const r = parseUnifiedRun({ motorCsv });
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.run.runId).toBe('run-L');
    expect(r.run.schemaVersion).toBe('1');
    expect(r.run.samples.length).toBe(1);
    expect(r.run.channels).toBeUndefined();
  });
  it('merges v2 manifest + channels into one Run', () => {
    const channelsCsv = [
      'timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note',
      '100,vel,number,12.5,,,,,,',
      '200,vel,number,13.5,,,,,,',
    ].join('\n');
    const manifestJson = JSON.stringify({
      schema_version: '2',
      run_id: 'run-V',
      opmode_name: 'Op',
      run_started_at: '2025-01-01T00:00:00Z',
      duration_ms: 1000,
      build_identifier: 'b-1',
      truncated: false,
      robot_config: { fingerprint: 'abc', device_names: ['leftFront'] },
      channels: [
        { name: 'vel', kind: 'number', group: '', unit: 'tps', description: '' },
      ],
    });
    const r = parseUnifiedRun({ channelsCsv, manifestJson });
    if (r.kind !== 'ok') throw new Error('expected ok: ' + r.reason);
    expect(r.run.runId).toBe('run-V');
    expect(r.run.schemaVersion).toBe('2');
    expect(r.run.samples.length).toBe(0);
    expect(r.run.channels?.totalCount).toBe(2);
    expect(r.run.manifest?.buildIdentifier).toBe('b-1');
  });
  it('rejects mismatched companion run_id', () => {
    // Motor CSV carries run_id = run-MATCH.  Manifest declares run_id =
    // OTHER.  parseUnifiedRun must catch the disagreement and surface it
    // as a "Companion mismatch" error so a wrongly-uploaded companion
    // file cannot contaminate the run.
    const header = [
      'schema_version', 'run_id', 'opmode_name', 'run_started_at',
      'timestamp_ms', 'device_name', 'commanded_power', 'encoder_position_ticks',
      'encoder_velocity_ticks_per_second', 'current_amps', 'motor_mode', 'battery_voltage',
    ].join(',');
    const motorCsv = [
      header,
      `${SCHEMA_VERSION},run-MATCH,Op,2025-01-01T00:00:00Z,0,leftFront,0.5,0,2000,1.5,RUN_USING_ENCODER,12`,
    ].join('\n');
    const manifestJson = JSON.stringify({
      schema_version: '2',
      run_id: 'OTHER',
      opmode_name: 'Op',
      run_started_at: '',
      duration_ms: 0,
      build_identifier: '',
      truncated: false,
      robot_config: { fingerprint: '', device_names: [] },
      channels: [],
    });
    const r = parseUnifiedRun({ motorCsv, manifestJson });
    expect(r.kind).toBe('error');
    expect(r.reason).toMatch(/mismatch/i);
  });
  it('fails when channels-only input has no manifest', () => {
    const channelsCsv = [
      'timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note',
      '100,vel,number,1,,,,,,',
    ].join('\n');
    const r = parseUnifiedRun({ channelsCsv });
    expect(r.kind).toBe('error');
  });
});

describe('run-id matching helpers', () => {
  it('reads run_id from the first data row of motor CSV', () => {
    const csv = [
      'schema_version,run_id,opmode_name,run_started_at,timestamp_ms,device_name,commanded_power,encoder_position_ticks,encoder_velocity_ticks_per_second,current_amps,motor_mode,battery_voltage',
      '1,run-X,Op,2025-01-01T00:00:00Z,0,leftFront,0.5,0,2000,1.5,RUN_USING_ENCODER,12',
    ].join('\n');
    expect(runIdFromMotorCsv(csv)).toBe('run-X');
  });
  it('reads run_id from channels CSV', () => {
    const csv = [
      'timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note',
      '100,vel,number,1,,,,,,',
    ].join('\n');
    expect(runIdFromChannelsCsv(csv)).toBe('vel');
  });
  it('reads run_id from manifest JSON', () => {
    expect(runIdFromManifestJson(
      JSON.stringify({ schema_version: '2', run_id: 'RID' })
    )).toBe('RID');
  });
});

describe('sanitizeText (XSS)', () => {
  it('escapes ampersands', () => expect(sanitizeText('a&b')).toBe('a&amp;b'));
  it('escapes angle brackets', () => expect(sanitizeText('<script>')).toBe('&lt;script&gt;'));
  it('escapes quotes', () => expect(sanitizeText('"hi"')).toBe('&quot;hi&quot;'));
  it('strips control characters', () => {
    expect(sanitizeText('a\u0001b\u0007c')).toBe('abc');
  });
  it('caps length', () => {
    expect(sanitizeText('x'.repeat(10000)).length).toBe(4096);
  });
});
