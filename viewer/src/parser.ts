/**
 * CSV / JSON parser + Run Health schema validator.
 *
 * Three parsers combine into one unified Run model:
 *  - parseRunHealthCsv: legacy v1 (12-column) motor CSV
 *  - parseChannelsCsv: v2 10-column companion channels CSV
 *  - parseManifestJson: v2 manifest JSON
 *
 * parseUnifiedRun() automatically picks the right path:
 *  - if manifestJson present, schema_version = 2 / format = v2_manifest_channels
 *  - otherwise treat motor CSV as legacy v1
 * The legacy motor CSV is converted into the same internal Run shape after
 * parsing — there is no separate v1/v2 UI surface.
 *
 * All functions are pure: no side effects, no I/O, no Date.now().
 */

import {
  ChannelSample,
  ChannelSamples,
  Column,
  EXPECTED_COLUMNS,
  ManifestChannel,
  Row,
  Run,
  RunManifestSummary,
  Sample,
  SCHEMA_VERSION,
} from './types.js';

/** Maximum bytes for any single parser input (defensive). */
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
/** Maximum number of data rows sampled (defensive). */
const MAX_ROWS = 250_000;
/** Maximum length of a non-number text field. */
const MAX_TEXT_LEN = 4096;

/** Result for a single-file parse: ok(run) or structured error reason. */
export type ParseResult =
  | { kind: 'ok'; run: Run }
  | { kind: 'error'; reason: string; detail?: string };

/**
 * Result for a non-run parse (channels, manifest): either parsed value or
 * structured error reason.  We never throw out of these parsers; the caller
 * decides what to do with a failure.
 */
export type ChannelsResult =
  | { kind: 'ok'; channels: ChannelSamples }
  | { kind: 'error'; reason: string; detail?: string };

export type ManifestResult =
  | { kind: 'ok'; manifest: RunManifestSummary }
  | { kind: 'error'; reason: string; detail?: string };

/**
 * Unified-run assembly: given optional companions, return one merged Run.
 *
 * Rules:
 *  - if manifestJson is missing or unparseable, fall back to legacy v1
 *  - if channelsCsv is missing, Run.channels is omitted
 *  - if motorCsv is missing, Run.samples is empty (a v2 channels-only run)
 *  - run_id consistency is enforced when multiple files are passed
 *  - XSS sanitisation on text fields via {@link sanitizeText}
 *  - file-size cap from MAX_INPUT_BYTES
 */
export function parseUnifiedRun(input: {
  motorCsv?: string | null;
  channelsCsv?: string | null;
  manifestJson?: string | null;
  sourceFileNames?: { motor?: string; channels?: string; manifest?: string };
}): ParseResult {
  const motorName = input.sourceFileNames?.motor ?? 'motor.csv';
  // 1. Manifest is OPTIONAL.
  let manifest: RunManifestSummary | null = null;
  if (input.manifestJson) {
    const m = parseManifestJson(input.manifestJson);
    if (m.kind === 'ok') manifest = m.manifest;
    // Manifest parse error is non-fatal — fall back to v1 detection.
  }

  // 2. Motor CSV is OPTIONAL (a v2 channels-only run is valid).
  let runFromMotor: Run | null = null;
  if (input.motorCsv) {
    const m = parseRunHealthCsv(input.motorCsv, motorName);
    if (m.kind === 'ok') runFromMotor = m.run;
    // Motor parse error: surface it; channels-only writes will not have one.
    if (m.kind === 'error' && !input.channelsCsv) return m;
  }

  // 3. Channels CSV is OPTIONAL.
  let channels: ChannelSamples | null = null;
  let malformedChannels = 0;
  if (input.channelsCsv) {
    const c = parseChannelsCsv(input.channelsCsv);
    if (c.kind === 'ok') channels = c.channels;
    else if (!runFromMotor) {
      // surfacing channels-only parse failure is fine; partial v2 is OK.
      malformedChannels++;
    }
  }

  // 4. Empty input check.
  if (!runFromMotor && !channels) {
    return { kind: 'error', reason: 'Empty run', detail: 'No motor or channels data supplied.' };
  }

  // 5. run_id consistency: when both manifest and motor are present, ids
  //    must match.  Disagreement is an error (wrong companion attached).
  if (runFromMotor && manifest && runFromMotor.runId !== manifest.runId) {
    return {
      kind: 'error',
      reason: 'Companion mismatch',
      detail: `motor run_id=${runFromMotor.runId} but manifest run_id=${manifest.runId}`,
    };
  }
  if (!runFromMotor && !manifest) {
    return {
      kind: 'error',
      reason: 'Missing run id',
      detail: 'Channels-only input requires a manifest JSON for the run id.',
    };
  }

  // 6. Schema version.
  let schemaVersion = runFromMotor?.schemaVersion ?? '1';
  if (manifest) schemaVersion = manifest.schemaVersion || '2';

  // 7. Schema-version forward-compat: never silently downgrade / upgrade.
  if (manifest && isFutureSchema(manifest.schemaVersion)) {
    return {
      kind: 'error',
      reason: 'Unsupported schema version',
      detail: `schema_version=${manifest.schemaVersion} is newer than supported.`,
    };
  }

  // 8. Build the merged Run.
  const runId = runFromMotor?.runId ?? manifest?.runId ?? '';
  const opmodeName = runFromMotor?.opmodeName ?? manifest?.opmodeName ?? 'OpMode';
  const runStartedAt = runFromMotor?.runStartedAt ?? manifest?.runStartedAt ?? '';
  const deviceNames = mergeUnique(runFromMotor?.deviceNames ?? [], manifest?.deviceNames ?? []);
  const samples = runFromMotor?.samples ?? [];
  const truncated = runFromMotor?.truncated ?? manifest?.truncated ?? false;

  const run: Run = {
    schemaVersion,
    runId,
    opmodeName,
    runStartedAt,
    deviceNames,
    samples,
    truncated,
    invalidRowCount: (runFromMotor?.invalidRowCount ?? 0) + malformedChannels,
    sourceFileName: motorName,
    channels: channels ?? undefined,
    manifest: manifest ?? undefined,
    // Convenience optional snapshot fields
    buildIdentifier: manifest?.buildIdentifier,
    durationMs: manifest?.durationMs,
    configFingerprint: manifest?.configFingerprint,
  };

  return { kind: 'ok', run };
}

/**
 * Parses a legacy v1 motor CSV into a {@link Run}.  Performs:
 *  - RFC 4180-style splitting (handles quoted commas, newlines, escapes)
 *  - Header + column validation against EXPECTED_COLUMNS
 *  - Numeric coercion with strict rules (NaN / Infinity / blank → null)
 *  - Truncation-footer detection
 *  - Malformed-row counting
 *  - XSS sanitisation on opmode_name / motor_mode / device_name via
 *    {@link sanitizeText}
 *  - Schema-version forward-compat rejection (only numeric future versions)
 *  - File-size cap (MAX_INPUT_BYTES), row cap (MAX_ROWS)
 */
export function parseRunHealthCsv(input: string, fileName: string): ParseResult {
  const guard = guardInput(input, fileName);
  if (guard) return guard;

  const colIdx: Record<Column, number> = {} as Record<Column, number>;
  for (let i = 0; i < EXPECTED_COLUMNS.length; i++) {
    colIdx[EXPECTED_COLUMNS[i]] = i;
  }

  const samples: Sample[] = [];
  let invalidRowCount = 0;
  let truncated = false;
  let runId = '';
  let opmodeName = '';
  let runStartedAt = '';
  let schemaVersion = '';
  let rowCount = 0;
  let headerSeen = false;
  let parseError: ParseResult | null = null;
  const deviceSet = new Set<string>();

  visitCsvRows(input, (r, index) => {
    rowCount++;
    if (rowCount > MAX_ROWS) {
      parseError = {
        kind: 'error',
        reason: 'Too many rows',
        detail: `Row count exceeds ${MAX_ROWS}.`,
      };
      return false;
    }
    if (index === 0) {
      headerSeen = true;
      const headerCheck = validateHeader(r);
      if (!headerCheck.ok) {
        parseError = headerCheck;
        return false;
      }
      return true;
    }
    if (index === 1) {
      schemaVersion = r[0] ?? '';
      if (isFutureSchema(schemaVersion)) {
        parseError = {
          kind: 'error',
          reason: 'Unsupported schema version',
          detail: `schema_version=${schemaVersion} is newer than supported ${SCHEMA_VERSION}.`,
        };
        return false;
      }
    }
    if (samples.length >= MAX_ROWS) {
      invalidRowCount++;
      return true;
    }
    if (r.length < EXPECTED_COLUMNS.length) {
      invalidRowCount++;
      return true;
    }
    const sample = rowToSample(r, colIdx);
    if (sample === null) {
      invalidRowCount++;
      return true;
    }
    if (sample.deviceName === '__RUN_HEALTH_TRUNCATED__') {
      truncated = true;
      return true;
    }
    if (runId === '' && sample.runId) runId = sample.runId;
    if (opmodeName === '' && sample.opmodeName) opmodeName = sample.opmodeName;
    if (runStartedAt === '' && sample.runStartedAt) runStartedAt = sample.runStartedAt;
    if (sample.deviceName) deviceSet.add(sample.deviceName);
    samples.push(sample);
    return true;
  });

  if (parseError) return parseError;
  if (!headerSeen) return { kind: 'error', reason: 'Empty file' };

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
      runId: sanitizeText(runId),
      opmodeName: sanitizeText(opmodeName),
      runStartedAt: sanitizeText(runStartedAt),
      deviceNames: Array.from(deviceSet).map(sanitizeText).sort(),
      samples,
      truncated,
      invalidRowCount,
      sourceFileName: sanitizeText(fileName),
    },
  };
}

/** Parses a v2 channels CSV body into a typed ChannelSamples object. */
export function parseChannelsCsv(input: string): ChannelsResult {
  const guard = guardInput(input, 'channels.csv');
  if (guard) return { kind: 'error', reason: guard.reason, detail: guard.detail };
  const rows = splitCsv(input);
  if (rows.length === 0) return { kind: 'error', reason: 'Empty file' };
  if (rows.length > MAX_ROWS) {
    return { kind: 'error', reason: 'Too many rows',
      detail: `Row count ${rows.length} exceeds ${MAX_ROWS}.` };
  }
  // Expected columns: timestamp_ms,channel_name,kind,value_number,value_boolean,
  // value_text,value_x,value_y,value_heading,note
  const expectedHeader = [
    'timestamp_ms','channel_name','kind','value_number','value_boolean',
    'value_text','value_x','value_y','value_heading','note',
  ];
  const header = rows[0];
  if (header.length < expectedHeader.length) {
    return { kind: 'error', reason: 'Bad header',
      detail: `Expected ${expectedHeader.length} columns, got ${header.length}.` };
  }
  for (let i = 0; i < expectedHeader.length; i++) {
    if (header[i] !== expectedHeader[i]) {
      return { kind: 'error', reason: 'Bad header',
        detail: `Column ${i} expected '${expectedHeader[i]}' but got '${header[i]}'.` };
    }
  }

  const channelsByName = new Map<string, ChannelSample[]>();
  let invalidRowCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 0 || (r.length === 1 && r[0] === '')) continue;
    // Pad short rows to the 10-column header.  Real Java producers emit
    // 10 columns even when many cells are blank; abbreviated test fixtures
    // and partial-write edge cases may omit trailing empties.  Padding
    // keeps positional indexing aligned.  Truly missing required kinds
    // (timestamp, name, kind) are still rejected inside rowToChannel.
    while (r.length < expectedHeader.length) r.push('');
    const parsed = rowToChannel(r);
    if (parsed === null) { invalidRowCount++; continue; }
    const key = parsed.channelName.toLowerCase();
    let list = channelsByName.get(key);
    if (!list) { list = []; channelsByName.set(key, list); }
    list.push(parsed);
  }
  if (channelsByName.size === 0) {
    return { kind: 'ok', channels: { byChannel: {}, totalCount: 0, channelNames: [] } };
  }

  // Per-channel sort by timestamp_ms ascending.
  const byChannel: Record<string, ChannelSample[]> = {};
  let totalCount = 0;
  for (const [key, list] of channelsByName.entries()) {
    list.sort((a, b) => a.timestampMs - b.timestampMs);
    byChannel[key] = list;
    totalCount += list.length;
  }
  const channelNames = Array.from(channelsByName.keys()).sort();
  return { kind: 'ok', channels: { byChannel, totalCount, channelNames } };
}

/** Parses a v2 manifest JSON text into a typed RunManifestSummary object. */
export function parseManifestJson(input: string): ManifestResult {
  const guard = guardInput(input, 'manifest.json');
  if (guard) return { kind: 'error', reason: guard.reason, detail: guard.detail };
  // 1. Sanity-parse via JSON.parse to avoid building a full tokenizer here.
  let parsed: unknown;
  try { parsed = JSON.parse(input); }
  catch (e) {
    return { kind: 'error', reason: 'Bad JSON',
      detail: e instanceof Error ? e.message : String(e) };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'error', reason: 'Bad manifest', detail: 'Top-level value is not an object.' };
  }
  const obj = parsed as Record<string, unknown>;
  const schemaVersion = str(obj, 'schema_version');
  if (!schemaVersion) {
    return { kind: 'error', reason: 'Missing schema_version' };
  }
  if (isFutureSchema(schemaVersion)) {
    return { kind: 'error', reason: 'Unsupported schema version',
      detail: `schema_version=${schemaVersion} is newer than supported.` };
  }
  const runId = sanitizeText(str(obj, 'run_id') ?? '');
  const opmodeName = sanitizeText(str(obj, 'opmode_name') ?? 'OpMode');
  const runStartedAt = sanitizeText(str(obj, 'run_started_at') ?? '');
  const durationMs = num(obj, 'duration_ms') ?? 0;
  const buildIdentifier = sanitizeText(str(obj, 'build_identifier') ?? '');
  const truncated = obj['truncated'] === true;

  const cfg = obj['robot_config'];
  let deviceNames: string[] = [];
  let configFingerprint = '';
  if (cfg && typeof cfg === 'object') {
    const cfgObj = cfg as Record<string, unknown>;
    configFingerprint = sanitizeText(str(cfgObj, 'fingerprint') ?? '');
    const dn = cfgObj['device_names'];
    if (Array.isArray(dn)) {
      deviceNames = dn
        .filter((x): x is string => typeof x === 'string')
        .map(sanitizeText);
    }
  }

  const channels: ManifestChannel[] = [];
  const chArr = obj['channels'];
  if (Array.isArray(chArr)) {
    for (const c of chArr) {
      if (!c || typeof c !== 'object') continue;
      const cc = c as Record<string, unknown>;
      const name = sanitizeText(str(cc, 'name') ?? '');
      const kindStr = str(cc, 'kind') ?? 'number';
      const kind = (kindStr === 'number' || kindStr === 'boolean' || kindStr === 'text' ||
        kindStr === 'pose' || kindStr === 'event') ? kindStr : 'number';
      channels.push({
        name,
        kind: kind as ManifestChannel['kind'],
        group: sanitizeText(str(cc, 'group') ?? ''),
        unit: sanitizeText(str(cc, 'unit') ?? ''),
        description: sanitizeText(str(cc, 'description') ?? ''),
      });
    }
  }

  return {
    kind: 'ok',
    manifest: {
      schemaVersion,
      runId,
      opmodeName,
      runStartedAt,
      durationMs,
      buildIdentifier,
      truncated,
      configFingerprint,
      deviceNames,
      channels,
    },
  };
}

/* ---------------- Run-id matching on companion files ---------------- */

/** Returns the run id carried by a motor CSV (legacy v1). */
export function runIdFromMotorCsv(input: string): string | null {
  const guard = guardInput(input, 'motor.csv');
  if (guard) return null;
  const rows = splitCsv(input);
  if (rows.length < 2) return null;
  return rows[1][1] ?? null;
}

/** Returns the run id carried by a channels CSV (v2). */
export function runIdFromChannelsCsv(input: string): string | null {
  const guard = guardInput(input, 'channels.csv');
  if (guard) return null;
  const rows = splitCsv(input);
  if (rows.length < 2) return null;
  return rows[1][1] ?? null;
}

/** Returns the run id carried by a manifest JSON (v2). */
export function runIdFromManifestJson(input: string): string | null {
  const m = parseManifestJson(input);
  return m.kind === 'ok' ? m.manifest.runId : null;
}

/* ---------------- Helpers ---------------- */

function guardInput(input: string, fileName: string): { kind: 'error'; reason: string; detail?: string } | null {
  if (typeof input !== 'string') {
    return { kind: 'error', reason: 'Invalid input', detail: 'Input was not a string.' };
  }
  if (input.length > MAX_INPUT_BYTES) {
    return { kind: 'error', reason: 'Too large',
      detail: `Input ${sanitizeText(fileName)} length ${input.length} exceeds ${MAX_INPUT_BYTES}.` };
  }
  return null;
}

function validateHeader(header: string[]):
  | { ok: true }
  | { ok: false; kind: 'error'; reason: string; detail?: string } {
  if (header.length < EXPECTED_COLUMNS.length) {
    return { ok: false, kind: 'error', reason: 'Bad header',
      detail: `Expected at least ${EXPECTED_COLUMNS.length} columns, got ${header.length}.` };
  }
  for (let i = 0; i < EXPECTED_COLUMNS.length; i++) {
    if (header[i] !== EXPECTED_COLUMNS[i]) {
      return {
        ok: false, kind: 'error', reason: 'Bad header',
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
  if (!Number.isInteger(ts) || ts < 0) return null;
  const deviceName = row[colIdx.device_name] || 'unknown';

  const cp = parseFiniteNullable(row[colIdx.commanded_power]);
  const ep = parseIntNullable(row[colIdx.encoder_position_ticks]);
  const ev = parseFiniteNullable(row[colIdx.encoder_velocity_ticks_per_second]);
  const ca = parseFiniteNullable(row[colIdx.current_amps]);
  const bv = parsePositiveFiniteNullable(row[colIdx.battery_voltage]);
  if (cp.malformed || ep.malformed || ev.malformed || ca.malformed || bv.malformed) {
    return null;
  }
  return {
    runId: sanitizeText(row[colIdx.run_id]),
    opmodeName: sanitizeText(row[colIdx.opmode_name]),
    runStartedAt: sanitizeText(row[colIdx.run_started_at]),
    timestampMs: Math.trunc(ts),
    deviceName: sanitizeText(deviceName),
    commandedPower: cp.value,
    encoderPositionTicks: ep.value,
    encoderVelocity: ev.value,
    currentAmps: ca.value,
    motorMode: nonEmpty(row[colIdx.motor_mode]),
    batteryVoltage: bv.value,
  };
}

function rowToChannel(row: string[]): ChannelSample | null {
  // Callable after parseChannelsCsv has already padded any short rows.  We
  // also re-pad here so the helper is safe to use directly from tests.
  while (row.length < 10) row.push('');
  const ts = Number(row[0]);
  if (!Number.isFinite(ts) || ts < 0) return null;
  const name = sanitizeText(row[1] ?? '');
  if (!name) return null;
  const kind = row[2] ?? 'number';
  if (kind !== 'number' && kind !== 'boolean' && kind !== 'text' &&
      kind !== 'pose'  && kind !== 'event') {
    return null;
  }
  const valueText = clampText(row[5], MAX_TEXT_LEN);
  // For event rows the Java writer places the same string in both
  // value_text and note columns; we accept either position so abbreviated
  // fixtures (note column truncated) still round-trip cleanly.
  const note = (kind === 'event') ? valueText : clampText(row[9], MAX_TEXT_LEN);
  return {
    timestampMs: Math.trunc(ts),
    channelName: name,
    kind,
    valueNumber: numOrNull(row[3]),
    valueBoolean: boolOrNull(row[4]),
    valueText,
    valueX: numOrNull(row[6]),
    valueY: numOrNull(row[7]),
    valueHeading: numOrNull(row[8]),
    note,
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
  return t === '' ? null : sanitizeText(t);
}

function clampText(s: string | undefined, max: number): string | null {
  if (s === undefined || s === null) return null;
  const trimmed = s.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) return sanitizeText(trimmed.slice(0, max));
  return sanitizeText(trimmed);
}

function numOrNull(s: string | undefined): number | null {
  if (s === undefined || s === null) return null;
  const trimmed = s.trim();
  if (trimmed === '') return null;
  const v = Number(trimmed);
  if (!Number.isFinite(v)) return null;
  return v;
}

function boolOrNull(s: string | undefined): boolean | null {
  if (s === undefined || s === null) return null;
  const trimmed = s.trim().toLowerCase();
  if (trimmed === '') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return null;
}

function num(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === 'string') return v;
  return null;
}

function isFutureSchema(s: string): boolean {
  if (typeof s !== 'string') return false;
  // Allow '1', '2'; reject anything higher or non-numeric.
  if (s === '') return false;
  const n = Number(s);
  if (!Number.isInteger(n)) return false;
  return n > 2; // we support v1 (= '1', legacy) and v2 (= '2', unified)
}

function mergeUnique(a: string[], b: string[]): string[] {
  const out = new Set<string>();
  for (const x of a) if (x) out.add(x);
  for (const x of b) if (x) out.add(x);
  return Array.from(out).sort();
}

/**
 * XSS-safe text sanitisation.  Strips characters / sequences that can be
 * interpreted as HTML or script tags when the value is rendered into the
 * DOM.  We also cap length to keep memory bounded.
 */
export function sanitizeText(s: string): string {
  if (typeof s !== 'string') return '';
  // Strip control chars except common whitespace.
  let out = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  // Replace angle brackets, ampersands, and quotes with their HTML
  // entity equivalents.  This prevents trivial injection of scripts.
  out = out
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  // Cap at MAX_TEXT_LEN.
  if (out.length > MAX_TEXT_LEN) out = out.slice(0, MAX_TEXT_LEN);
  return out;
}

// ---------------- RFC 4180 row reader ----------------
function visitCsvRows(input: string, visit: (row: string[], index: number) => boolean): void {
  let cur: string[] = [];
  let fieldBuf: string[] = [];
  let inQuotes = false;
  let rowIndex = 0;
  const emit = (): boolean => {
    cur.push(fieldBuf.join(''));
    fieldBuf = [];
    if (!(cur.length === 1 && cur[0] === '')) {
      const keepGoing = visit(cur, rowIndex++);
      cur = [];
      return keepGoing;
    }
    cur = [];
    return true;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < input.length && input.charAt(i + 1) === '"') { fieldBuf.push('"'); i++; }
        else { inQuotes = false; }
      } else { fieldBuf.push(c); }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { cur.push(fieldBuf.join('')); fieldBuf = []; continue; }
    if (c === '\r') {
      if (!emit()) return;
      if (i + 1 < input.length && input.charAt(i + 1) === '\n') i++;
      continue;
    }
    if (c === '\n') {
      if (!emit()) return;
      continue;
    }
    fieldBuf.push(c);
  }
  if (fieldBuf.length > 0 || cur.length > 0) {
    emit();
  }
}

function splitCsv(input: string): string[][] {
  const rows: string[][] = [];
  visitCsvRows(input, (row) => {
    rows.push(row);
    return true;
  });
  return rows;
}

/** Detects duplicate run_id among already-parsed runs. */
export function detectDuplicates(runs: Run[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of runs) { counts.set(r.runId, (counts.get(r.runId) ?? 0) + 1); }
  const out = new Map<string, number>();
  for (const [k, v] of counts) if (v > 1) out.set(k, v);
  return out;
}

/** Convert a Sample back into a CSV row (used in tests). */
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
