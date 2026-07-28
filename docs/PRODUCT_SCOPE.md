# FTC Run Health — Product Scope

## What it is

FTC Run Health is a **read-only FTC motor-performance recorder and run-comparison
tool**.  It samples every configured `DcMotorEx` device during an integrated
OpMode run, writes a CSV to the Control Hub, and lets a team compare that
run against previous runs from a browser connected to the Control Hub's
Wi-Fi network.

## What it measures (and what it does NOT)

Run Health reports **measured differences**.  Examples of valid output:

* "Median velocity decreased 11.8%."
* "Velocity per effective command decreased 14.2%."
* "Current per movement increased 19.4%."
* "95th-percentile current increased from 4.2 A to 5.1 A."
* "Possible stall percentage increased from 1.6% to 5.8%."
* "This motor is missing from Run B."
* "There are not enough comparable samples."

Run Health **must not claim** any specific underlying mechanical or electrical
diagnosis.  See `LIMITATIONS.md` for the full list.

## Recording scope

* **Recording is OFF by default.**  No OpMode is recorded until the team
  explicitly changes the recording mode through the browser UI.
* Only OpModes that call `RunHealthSession.start(...)` are **eligible**.
  Run Health cannot automatically inject itself into unrelated OpModes.
  This keeps integration explicit, opt-in, and reversible.

## Read-only contract

Run Health is **completely read-only**.  It must never:

* Set motor power, direction, mode, zero-power behavior, target position,
  PID/PIDF, or reset an encoder.
* Modify any non-motor hardware (sensors, servos, hubs, cameras, etc.).
* Change normal team telemetry.  It piggy-backs on the existing telemetry
  channel only as a passive observer.
* Stop or crash an OpMode because logging failed.
* Block or slow the robot control loop.  Sampling is rate-limited to
  10 Hz; the typical `capture()` cost is sub-millisecond and any failure
  is swallowed.

## Components delivered

1. Read-only Java motor logger
2. Optional Recording Off/Next/Every controls
3. Persistent recording-mode settings
4. CSV run storage under `/FIRST/RunHealth/runs/`
5. Control Hub HTTP API under `/runhealth/api/*`
6. Saved Runs browser page
7. Whole-robot comparison page
8. Per-motor detailed graph page
9. Manual baseline system
10. Direct run-to-run comparison
11. Long-term trend view
12. Standalone local CSV viewer (drag-drop)
13. Synthetic test data fixtures
14. Java + TypeScript automated tests
15. Example LinearOpMode and iterative OpMode
16. Documentation

See `ARCHITECTURE.md` for the technical layout.
