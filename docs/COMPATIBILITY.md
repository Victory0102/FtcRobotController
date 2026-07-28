# FTC Run Health — Compatibility

Run Health is designed to coexist with the FTC tools your team may
already use.  The strict rules below describe every interaction.

## Tool-specific notes

### FTC Dashboard

* Run Health does **not** bind or intercept port 8001 (Panels' port).
* Run Health does **not** register a route at `/dash`.
* If you keep FTC Dashboard installed, both dashboards coexist and
  their routes are independent.

### Panels

* Panels binds port 8001 by default.  Run Health does not touch 8001.
* Both apps can be installed simultaneously; no port conflict.

### Road Runner

* Road Runner's telemetry is observation-only.  Run Health's motor
  reads do not interfere with Road Runner motor commands because
  Run Health only reads, never writes.
* A Road Runner autonomous OpMode can be made Run Health-eligible by
  adding the four-line integration shown in `INSTALLATION.md`.
  Internally, Road Runner uses its own motor wrappers; the
  configuration names of the underlying `DcMotorEx` instances are
  what Run Health uses.

### Pedro Pathing

* Same as Road Runner.  Pedro Pathing does not own the FTC web
  server.

### NextFTC

* NextFTC is a Kotlin framework; its commands share the same
  `DcMotorEx` references.  Naming is set up in your OpMode and is
  passed into Run Health via `motorNames`.  Compatibility is
  read-only, like Road Runner.

### Limelight libraries

* Limelight HTTP servers are typically configured separately
  (often `limelight.local:5807`); Run Health uses the Robot
  Controller's webHandler port and does not interfere.

### Standard FTC SDK OpModes

* Any OpMode that does NOT call `RunHealthSession.start(...)` is
  **not** recorded.  This includes the SDK's examples, OnBot Java
  programs, Blocks projects, anything you've previously deployed.
* The SDK's other webHandlers (`/`, `/dash`, `/program`, ...) are
  untouched.  Run Health only **adds** routes.

## Compatibility rules (enforced)

1. **Route prefixes.** Run Health uses only `/runhealth/` and `/runhealth/api/`.
   Other tool routes are not modified.
2. **No port 8001 binding.** Run Health does not create raw TCP servers.
   All HTTP goes through the existing Robot Controller webHandler.
3. **No `WebHandlerManager` overwrites.**  A registration conflict
   produces a fail-safe log message and a no-op; the conflicting
   handler keeps its slot.
4. **File storage is isolated.** `/FIRST/RunHealth/runs/`.  No
   touching of `/FIRST/blocks/`, `/FIRST/opmodes/`, or other tool
   directories.
5. **No SDK version changes.** Run Health builds cleanly on top of
   the FTC SDK 11.2 dependency tree shipped with this repo.  Build
   files were not re-versioned.

## Unverified assumptions

Some real-world co-existence tests require a physical Control Hub.
Until then, the following are unverified:

* **FTC Dashboard compatibility**: route independence was checked
  statically; no observed test.
* **Panels coexistence**: similar — only static code review.
* **Road Runner telemetry interleaving with Run Health**: not
  observed on a physical robot.
* **OnBot Java**: not observed.

See `CONTROL_HUB_TEST_PLAN.md` for the full experimental queue.
