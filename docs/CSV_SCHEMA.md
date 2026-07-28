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
