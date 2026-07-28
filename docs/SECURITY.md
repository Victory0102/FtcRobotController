# FTC Run Health — Security

Run Health is designed for a **trusted private network** (the Control
Hub Wi-Fi).  The Robot Controller's web server is involved and the
Operator typically pairs phones via Wi-Fi Direct on the same AP.

## Network posture

* All HTTP endpoints are reachable **only inside the Control Hub LAN**
  (the standard Robot Controller web server default port).  There is
  no Internet exposure.
* Run Health does not advertise new ports; it registers routes on the
  existing Robot Controller webHandler server.
* All requests and responses use either `application/json`,
  `text/csv`, or `text/html`.  The default Robot Controller server
  uses cleartext HTTP — this is unchanged by Run Health.

## Threats considered

| Threat | Mitigation |
|--------|-----------|
| Path traversal in run id | The browser-known run id is the basename without `.csv`; the API always resolves under `/FIRST/RunHealth/runs/`.  `FilenameSanitizer.isWithinDirectory(...)` is called for every file operation. |
| Filename injection from OpMode names | Every filename is sanitized via `FilenameSanitizer.sanitizeSegment(...)` which rejects path separators, control characters, Windows reserved names, hidden files, and over-long names. |
| Absolute paths from client | No API accepts an absolute path; `run_id` is treated as a basename. |
| Symlink escape | Canonical-path resolution in `isWithinDirectory` defensively compares paths after symlink resolution. |
| Stack-trace disclosure | All error paths return a structured JSON error with `error`, `code`, and `detail` fields.  No `e.printStackTrace()` or full path disclosure. |
| Remote command execution | Run Health never parses and executes commands received from the browser.  The only client-supplied inputs are interpreted as JSON values used in storage and arithmetic; no shell calls, no `Runtime.exec(...)`. |
| Cross-tool contamination | Run Health is intentionally `final class` and `private` constructor where possible.  No state leaks outside `org.firstinspires.ftc.teamcode.runhealth.*`. |
| Resource exhaustion | `RunHealthSession.MAX_SAMPLES_PER_MOTOR = 5,400` caps memory per motor.  Downloads cap at `MAX_INLINED_BYTES = 32 MB`.  Listing is bounded by disk usage. |
| Bulk deletion abuse | The `/api/runs/delete-selected` endpoint operates only on exact run IDs supplied in the request body, after JSON validation.  Duplicates are deduped.  Failed IDs are reported; the operation is idempotent on empty input. |
| Race-condition on Record-Next | `RunHealthConfig.compareAndSetMode(...)` is `synchronized` and reads-then-writes the persisted mode atomically. |
| Robot-loop blocking | `RunHealthSession.capture()` rate-limits to 10 Hz and reads at most 8 motor data points per call.  Every read is individually try/caught.  `finish()` writes the CSV in one pass; the loop is not blocked during `finish()`. |

## Authorization

The Robot Controller web server hosts all routes.  By default the
Firmware on the Control Hub has no HTTP authorization; this is
unchanged by Run Health.  Anything on the Control Hub LAN can list,
download, or delete Run Health files.  This is a deliberate design
choice for MVP usability; harden the underlying RC server if you
need stronger controls.  See `LIMITATIONS.md`.

## What Run Health does NOT do

* No data is sent to any cloud service.
* No data is sent to a phone running Outside Driver Station code.
* No telemetry metadata about runs leaks outside the Control Hub LAN.
