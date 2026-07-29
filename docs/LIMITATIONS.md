# FTC Run Health — Limitations

This MVP is intentionally conservative.  The following limitations
are part of the contract; they are documented so teams do not
misinterpret Run Health output.

## What Run Health does NOT diagnose

* **Mechanical wear or damage.** A "median velocity decreased 12%"
  statement is a *measurement* of change, not a diagnosis.  A worn
  encoder, a partially seized gearbox, a stretched belt, a loose
  wheel, a low battery, or even a heavier battery + cargo will all
  produce similar percent changes.
* **Electrical faults.** A "95th-percentile current increased 0.6 A"
  statement does not diagnose a failing motor winding or a bad
  connector.  It also does not isolate which of two possible causes
  (mechanical load vs. electrical resistance) is dominant.
* **Stall vs. holding.** "Possible Stall Percentage" may produce
  false positives when an arm is actively holding against gravity
  with a low commanded velocity.  We deliberately do not claim
  confirmed stalls.

## What Run Health does NOT do automatically

* **Auto-select baselines.** A baseline is **always** the team's
  selection.  We never choose one automatically.
* **Auto-cleanup.** Saved runs remain on disk until the team
  manually deletes them.  There is no age-based expiration, no
  autoarchival, no cleanup timer.
* **Auto-match renamed motors.** If your team renames a device
  between runs (e.g., "leftDrive" → "driveLeft"), Run Health treats
  them as **different motors**.  We do not fuzzy-match; we report
  both as Missing on opposite sides of the comparison.
* **Sub-second precision on motor modes.** We treat
  `RUN_USING_ENCODER` vs `RUN_WITHOUT_ENCODER` as incompatible and
  warn.  We do not interpolate.

## Telemetry-side limitations

* **No access to current on all motors.** Some motor controllers
  cannot report current; we record blank cells and the metric
  reader simply skips those samples.  The metric card "Velocity
  metrics available, current metrics unavailable" appears in this
  case.
* **No voltage sensor on some configurations.** When no
  `VoltageSensor` returns a positive finite reading, battery
  voltage is blank across the run.  Metric B (velocity per
  effective command) is unavailable without a voltage reading.

## Browser-side limitations

* **No automatic ZIP of multiple runs.** The "Download Selected"
  MVP variant downloads one file at a time.  A ZIP endpoint was
  considered and deferred because Java-side ZIP generation can be
  tricky to test in pure-JVM unit tests.  See
  `CONTROL_HUB_TEST_PLAN.md` for the future-work track.
* **No streaming graphs out of the box.** The MVP trends page
  shows one row per run.  Live multi-run overlay graphs rely on
  small in-browser SVG rendering; we keep them for the per-motor
  detailed page only.
* **Maximum run size for inline reads is 32 MB.** Larger files
  return `413 too_large` rather than memory-squeezing the Control
  Hub.  This limit matches a 5-minute run at the maximum sample
  rate with all extra columns populated.

## Process-level limitations

* **Process crashes lose the in-progress run.** We do not write
  intermediate or `.partial` files.  If the Robot Controller is
  killed before `finish()` returns, the partially captured run is
  lost.  This is documented; the safest workaround is to
  `try/finally` `finish()`.
* **Sample cap of 5,400/motor.** Memory-bound.  Longer runs are
  truncated with a visible marker.  Adjust
  `RunHealthSession.MAX_SAMPLES_PER_MOTOR` if needed.

## Control Hub limitations (unverified)

The following have not been observed on a physical Control Hub in
the current build:

* Performance of `capture()` on a Hub hosting multiple other tools
  (Panels, FTC Dashboard simultaneously).
* Co-existence with all Road Runner and Pedro Pathing opmodes.
* Behaviour after a forced shutdown or mid-run power cycle.

See `CONTROL_HUB_TEST_PLAN.md` for the queued experiments.

## Live view

* Browser history is bounded to 60 seconds; older data is dropped to
  keep the UI responsive.  Longer inspection must use saved runs
  via the Replay tab.
* Live viewing is polled (default 250 ms, exponential backoff up to
  5 s).  Server-Sent Events / WebSocket are not used because the
  FTC SDK web-handler contract does not expose a streaming response
  shape that is portable across SDK versions.
* The browser-bounded pose path is at most 600 points; the
  Control-Hub unbounded pose history is not retained.
* Live channels stream only the most-recent staged value per
  channel name per tick.  Full history is preserved on disk in the
  recorded channels.csv companion.
* Live polling is GET-only; the FTC SDK web-handler contract does
  not expose streaming responses cross-version, so polling is the
  safest portable choice.
