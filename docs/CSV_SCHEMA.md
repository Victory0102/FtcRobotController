# FTC Run Health — CSV Schema

## Format

Each run is stored as a single UTF-8, comma-separated CSV with one row per
motor per timestamp (long format).  A trailing newline terminates the file.

## Column order (stable, do not reorder)

```
schema_version,run_id,opmode_name,run_started_at,timestamp_ms,device_name,
commanded_power,encoder_position_ticks,encoder_velocity_ticks_per_second,
current_amps,motor_mode,battery_voltage
```

| # | Column | Type | Notes |
|---|--------|------|-------|
| 1 | `schema_version` | string | Always `1` for v1 schema. |
| 2 | `run_id` | string | RFC 4122 UUID v4 generated at session start. |
| 3 | `opmode_name` | string | Class simple name of the integrated OpMode. |
| 4 | `run_started_at` | string | ISO-8601 UTC wall-clock timestamp. |
| 5 | `timestamp_ms` | integer | Monotonic elapsed time, milliseconds. |
| 6 | `device_name` | string | FTC configuration name (e.g., `leftFront`). |
| 7 | `commanded_power` | float | `[-1, 1]` inclusive. Blank if unavailable. |
| 8 | `encoder_position_ticks` | integer | Blank if unavailable. |
| 9 | `encoder_velocity_ticks_per_second` | float | Blank if unavailable. |
| 10 | `current_amps` | float | Blank if unavailable. |
| 11 | `motor_mode` | string | `RUN_USING_ENCODER` etc. Blank if unavailable. |
| 12 | `battery_voltage` | float | Positive finite. Blank if no valid reading. |

## Numeric formatting

* Locale.US: dot decimal, no thousands separator.
* Finite values only.  NaN, `+∞`, `-∞` are written as **blank**.
* Floating-point output uses at most 6 fractional digits (CSV formatter
  caps precision for readability).
* Integer columns are written as base-10 integers without decimals.
* **Missing or unavailable fields are blank** — never zero, never
  `"N/A"`, never `"null"`.  The parser treats blanks as missing.

## Truncation footer

When the per-motor sample cap is reached, an additional row is appended:

```
<schema>,<run_id>,<opmode>,<run_started_at>,<t_ms>,
__RUN_HEALTH_TRUNCATED__,,,,,,TRUNCATED=<captured>/<cap>
```

The string `__RUN_HEALTH_TRUNCATED__` triggers the parser's truncation
flag.  The browser Saved Runs UI surfaces this in the per-run row.

## Names

* Filenames use `FilenameSanitizer` and contain:
  `<UTC ISO with - instead of :>-<opmode>-<short run id>.csv`
* If the run was truncated, the filename inserts `-truncated` before the
  short id: `<UTC>-<opmode>-truncated-<short>.csv`.  This is the only
  field where the spec allows encoded state; the parser checks both
  basename content and the footer row.

## Encoding

UTF-8.  Strings containing commas, double-quotes, or newlines are
double-quote-escaped per RFC 4180; embedded double-quotes are doubled
(`""`).

## Compatibility

* `schema_version` is `1`.  Future versions MUST use a strictly
  larger number; the viewer rejects any future-unknown numeric version
  with `Unsupported schema version`.
* Adding new columns requires bumping the schema version.
* Renaming existing columns also requires bumping the schema version.
* Unknown columns are rejected by the parser unless the schema version
  increments; this is why future versions must change the version.

## v2 channels CSV (companion to a v1 run)

A v2 run additionally writes a **per-channel** CSV alongside the v1
motor CSV.  The companion schema is `recorder_schema_version = 2`; the
presence of a `<run-stem>.channels.csv` and `<run-stem>.manifest.json`
signals v2 to the API.  Both files use the same UTC ISO-8601 run id
within the filename as the v1 motor CSV.

The companion `<stem>.manifest.json` points at this file via the
`channels_file` field — read the manifest first to discover the
schema_version and the channels CSV path.  A viewer-side parser
**must not** read the channels CSV in isolation; the manifest is the
authoritative index of the run.

The manifest filename is `<stem>.manifest.json`, sitting next to
`<stem>.channels.csv`, where `stem` matches the v1 motor CSV stem
minus `.csv` (i.e. `<UTC-with-dashes>-<opmode>-<short_id>`).  If the
v1 motor CSV is truncated, the same stem is used and the `-truncated`
marker is preserved on the companion files.

A `<stem>.channels.csv` without its companion `<stem>.manifest.json`,
or a manifest without its channels CSV, is a **partial write** (the
`finish()` path emits files in order: motor CSV → channels CSV →
manifest, so a crash between steps leaves pairs incomplete).  Parsers
SHOULD treat any partial-write pair as truncated and surface the same
warning the parser surfaces for `__RUN_HEALTH_TRUNCATED__` footers.

### Column order (10 columns, stable)

```
timestamp_ms,channel_name,kind,value_number,value_boolean,value_text,value_x,value_y,value_heading,note
```

| # | Column | Type | Notes |
|---|--------|------|-------|
| 1 | `timestamp_ms` | integer | Monotonic elapsed time, milliseconds. |
| 2 | `channel_name` | string | The user-facing channel name; see "Reserved literal" below for the EVENT exception. |
| 3 | `kind` | string | One of `number`, `boolean`, `text`, `pose`, `event`. |
| 4 | `value_number` | float | Populated for `kind=number`. Blank otherwise. |
| 5 | `value_boolean` | string | `true` or `false` for `kind=boolean`. Blank otherwise. |
| 6 | `value_text` | string | Populated for `kind=text` and `kind=event`. Blank otherwise. |
| 7 | `value_x` | float | Populated for `kind=pose`. Blank otherwise. |
| 8 | `value_y` | float | Populated for `kind=pose`. Blank otherwise. |
| 9 | `value_heading` | float | Populated for `kind=pose`. Blank otherwise. |
| 10 | `note` | string | Free-form note. For `kind=event` rows, the same text appears here and in `value_text`. May be empty for `kind=event`. |

> The channels CSV carries **no `schema_version` column of its own** —
> its schema version lives in the companion manifest's
> `schema_version` field.  A parser that looks for a version column on
> the CSV will not find one.

### Reserved literal for EVENT rows

The `channel_name` column for `kind=event` rows is always the wire
literal `__event__` (defined as `ChannelsCsv.EVENT_CHANNEL_NAME` in
production), regardless of what name the caller passes to
`RunHealthSession.mark(...)`.  Browser-side event filters MUST compare
against the literal string `__event__` as a stable, machine-derived
constant — not as a user-editable label.  All non-EVENT rows carry the
clamped user-supplied name through `ChannelSpec.validateName`.

### Numeric formatting

Same rules as the v1 motor CSV: Locale.US, finite-only, at most six
fractional digits, integer-valued doubles use one fractional digit.

### Encoding

UTF-8.  RFC 4180 quoting.  Rows sorted by `(timestamp_ms, channel_name)`
before write for stable diffs.

### Compatibility

* `kind=event` row structure is contractual; the wire literal
  `__event__` must not change without a schema bump.
* `ChannelsCsv.EVENT_CHANNEL_NAME` (in production code) is the single
  source of truth for this literal — both the writer and any consumer
  (browser parser, analytics tool) should reference it.  The wire
  value is always the plain string `__event__`.

