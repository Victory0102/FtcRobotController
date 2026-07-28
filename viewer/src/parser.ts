/**
 * CSV parser + Run Health schema validator.
 *
 * All functions are pure: no side effects, no I/O, no Date.now(). They work
 * for both the standalone (drag-drop) viewer and the Control Hub connected
 * path.
 */

import {
  Column,
  EXPECTED_COLUMNS,
  SCHEMA_VERSION,
  Row,
  Run,
  Sample,
} from './types.js';

/** Maximum number of bytes the parser will accept (defensive). */
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

/** Result of parsing: either a run, or a structured error reason. */
export type ParseResult =
  | { kind: 'ok'; run: Run }
  | { kind: 'error'; reason: string; detail?: string };

/**
 * Parses a CSV string into a {@link Run}.  Performs:
 * - RFC 4180-style splitting (handles quoted commas, newlines, escapes).
 * - Mapping to the documented schema.
 * - Validation of schema version.
 * - Numeric coercion with strict rules (NaN, Infinity, empty → null).
 * - Detection of the Run Health truncation footer.
 * - Counting of malformed rows without crashing.
 */
export function parseRunHealthCsv(input: string, fileName: string): ParseResult {
  if (typeof input !== 'string') {
    return { kind: 'error', reason: 'Invalid input', detail: 'Input was not a string.' };
  }
  if (input.length > MAX_INPUT_BYTES) {
    return { kind: 'error', reason: 'Too large', detail: `Input length ${input.length} exceeds ${MAX_INPUT_BYTES}.` };
  }
  const rows = splitCsv(input);
  if (rows.length === 0) {
    return { kind: 'error', reason: 'Empty file' };
  }

  const header = rows[0];
  const headerCheck = validateHeader(header);
  if (!headerCheck.ok) {
    return headerCheck;
  }

  const schemaVersion = rows.length > 1 ? (rows[1][0] ?? '') : '';
  // We have validated the header above; here we only check it's not some
  // unknown future number.  Reads the value from the FIRST DATA ROW so we
  // never confuse the column name with the schema version.
  const schemaNumber = Number(schemaVersion);
  if (
      (schemaVersion === '' || Number.isFinite(schemaNumber))
          && Number.isFinite(schemaNumber)
          && schemaNumber > Number(SCHEMA_VERSION)
  ) {
    return {
      kind: 'error',
      reason: 'Unsupported schema version',
      detail: `schema_version=${schemaVersion} is newer than supported ${SCHEMA_VERSION}.`,
    };
  }

  // Build column index map.  Header is already validated.
  const colIdx: Record<Column, number> = {} as Record<Column, number>;
  for (let i = 0; i < EXPECTED_COLUMNS.length; i++) {
    colIdx[EXPECTED_COLUMNS[i]] = i;
  }

  // Convert the remaining rows to a typed Run.
  const samples: Sample[] = [];
  let invalidRowCount = 0;
  let truncated = false;
  let runId = '';
  let opmodeName = '';
  let runStartedAt = '';
  const deviceSet = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 0 || (r.length === 1 && r[0] === '')) continue;
    if (r.length < EXPECTED_COLUMNS.length) {
      invalidRowCount++;
      continue;
    }
    const sample = rowToSample(r, colIdx);
    if (sample === null) {
      invalidRowCount++;
      continue;
    }

    // Detect the truncation marker; do not include it in samples.
    if (sample.deviceName === '__RUN_HEALTH_TRUNCATED__') {
      truncated = true;
      continue;
    }

    if (runId === '') runId = sample.runId;
    if (opmodeName === '') opmodeName = sample.opmodeName;
    if (runStartedAt === '') runStartedAt = sample.runStartedAt;
    if (sample.deviceName) deviceSet.add(sample.deviceName);
    samples.push(sample);
  }

  if (samples.length === 0 && invalidRowCount === 0 && !truncated) {
    return { kind: 'error', reason: 'No samples', detail: 'CSV had no data rows.' };
  }
  if (runId === '' && invalidRowCount === 0 && !truncated) {
    return { kind: 'error', reason: 'Missing run_id', detail: 'No row carried a non-empty run_id.' };
  }

  return {
    kind: 'ok',
    run: {
      schemaVersion,
      runId,
      opmodeName,
      runStartedAt,
      deviceNames: Array.from(deviceSet).sort(),
      samples,
      truncated,
      invalidRowCount,
      sourceFileName: fileName,
    },
  };
}

interface HeaderCheckOk { ok: true }
interface HeaderCheckFail { ok: false; kind: 'error'; reason: string; detail?: string }

function validateHeader(header: string[]): HeaderCheckOk | HeaderCheckFail {
  if (header.length < EXPECTED_COLUMNS.length) {
    return { ok: false, kind: 'error', reason: 'Bad header', detail: `Expected at least ${EXPECTED_COLUMNS.length} columns, got ${header.length}.` };
  }
  for (let i = 0; i < EXPECTED_COLUMNS.length; i++) {
    if (header[i] !== EXPECTED_COLUMNS[i]) {
      return {
        ok: false,
        kind: 'error',
        reason: 'Bad header',
        detail: `Column ${i} header was '${header[i]}' but expected '${EXPECTED_COLUMNS[i]}'.`,
      };
    }
  }
  return { ok: true };
}

function rowToSample(row: string[], colIdx: Record<Column, number>): Sample | null {
  if (!row[colIdx.run_id] || !row[colIdx.opmode_name] || !row[colIdx.run_started_at]) {
    return null;
  }
  const tsRaw = row[colIdx.timestamp_ms];
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) return null;
  const deviceName = row[colIdx.device_name] || 'unknown';

  const cp = parseFiniteNullable(row[colIdx.commanded_power]);
  const ep = parseIntNullable(row[colIdx.encoder_position_ticks]);
  const ev = parseFiniteNullable(row[colIdx.encoder_velocity_ticks_per_second]);
  const ca = parseFiniteNullable(row[colIdx.current_amps]);
  const bv = parsePositiveFiniteNullable(row[colIdx.battery_voltage]);
  // Any non-blank but unparseable numeric counts as a malformed row, per
  // spec §30 ("Count and report malformed rows").
  if (cp.malformed || ep.malformed || ev.malformed || ca.malformed || bv.malformed) {
    return null;
  }
  return {
    runId: row[colIdx.run_id],
    opmodeName: row[colIdx.opmode_name],
    runStartedAt: row[colIdx.run_started_at],
    timestampMs: Math.trunc(ts),
    deviceName,
    commandedPower: cp.value,
    encoderPositionTicks: ep.value,
    encoderVelocity: ev.value,
    currentAmps: ca.value,
    motorMode: nonEmpty(row[colIdx.motor_mode]),
    batteryVoltage: bv.value,
  };
}

interface ParseOk { value: number | null; malformed: boolean }
function parseFiniteNullable(s: string | undefined): ParseOk {
  if (s === undefined || s === null) return { value: null, malformed: false };
  const trimmed = s.trim();
  if (trimmed === '') return { value: null, malformed: false };
  const v = Number(trimmed);
  if (!Number.isFinite(v)) return { value: null, malformed: true };
  return { value: v, malformed: false };
}

function parsePositiveFiniteNullable(s: string | undefined): ParseOk {
  const r = parseFiniteNullable(s);
  if (r.value !== null && r.value <= 0) return { value: null, malformed: false };
  return r;
}

function parseIntNullable(s: string | undefined): ParseOk {
  if (s === undefined || s === null) return { value: null, malformed: false };
  const trimmed = s.trim();
  if (trimmed === '') return { value: null, malformed: false };
  const v = Number(trimmed);
  if (!Number.isFinite(v)) return { value: null, malformed: true };
  return { value: Math.trunc(v), malformed: false };
}

function nonEmpty(s: string | undefined): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

// ---------------- RFC 4180 splitter -----------------

type Cell = string;

function splitCsv(input: string): Cell[][] {
  const rows: Cell[][] = [];
  let cur: Cell[] = [];
  let fieldBuf: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < input.length && input.charAt(i + 1) === '"') {
          fieldBuf.push('"');
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        fieldBuf.push(c);
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ',') {
      cur.push(fieldBuf.join(''));
      fieldBuf = [];
      continue;
    }
    if (c === '\r') {
      // Carriage return alone or as part of CRLF: end row.
      cur.push(fieldBuf.join(''));
      fieldBuf = [];
      if (cur.length > 0 && !(cur.length === 1 && cur[0] === '')) rows.push(cur);
      cur = [];
      // consume the trailing \n if present
      if (i + 1 < input.length && input.charAt(i + 1) === '\n') i++;
      continue;
    }
    if (c === '\n') {
      cur.push(fieldBuf.join(''));
      fieldBuf = [];
      if (cur.length > 0 && !(cur.length === 1 && cur[0] === '')) rows.push(cur);
      cur = [];
      continue;
    }
    fieldBuf.push(c);
  }
  // tail
  if (fieldBuf.length > 0 || cur.length > 0) {
    cur.push(fieldBuf.join(''));
    if (!(cur.length === 1 && cur[0] === '')) rows.push(cur);
  }
  return rows;
}

/**
 * Detects duplicate run_id among already-parsed runs.  Duplicates are
 * forbidden by the spec; most likely because a file was loaded twice.
 */
export function detectDuplicates(runs: Run[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of runs) {
    counts.set(r.runId, (counts.get(r.runId) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [k, v] of counts) {
    if (v > 1) out.set(k, v);
  }
  return out;
}

/**
 * Convert a {@link Sample} back into a CSV row (used in tests).
 */
export function sampleToRow(s: Sample): Row {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: s.runId,
    opmode_name: s.opmodeName,
    run_started_at: s.runStartedAt,
    timestamp_ms: String(s.timestampMs),
    device_name: s.deviceName,
    commanded_power: s.commandedPower === null ? '' : String(s.commandedPower),
    encoder_position_ticks: s.encoderPositionTicks === null ? '' : String(s.encoderPositionTicks),
    encoder_velocity_ticks_per_second: s.encoderVelocity === null ? '' : String(s.encoderVelocity),
    current_amps: s.currentAmps === null ? '' : String(s.currentAmps),
    motor_mode: s.motorMode ?? '',
    battery_voltage: s.batteryVoltage === null ? '' : String(s.batteryVoltage),
  };
}
