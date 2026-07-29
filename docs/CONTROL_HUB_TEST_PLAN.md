# FTC Run Health — Control Hub Test Plan

The MVP relies on these physical Control Hub (CH) tests to be
considered "verified".  Run them in order; each test depends on the
previous one passing.  Where a test requires two motors, four
drivetrain motors, etc., the operator must configure the Robot
Configuration in the Driver Station accordingly.

## Required hardware (suggested reference robot)

* 1× REV Control Hub
* 1× Battery at 12.6 V
* 1× Driver Station phone (Android, latest FTC DS app ≥ 11.2)
* 4× REV Core Hex / NeveRest motors on the drivetrain
* 1× arm or lift with 1× motor
* Optional: 1× additional motor for an "8 or more" run

## Test cases (numbered, ordered)

| # | Name | Expected outcome |
|---|------|-------------------|
| 1 | Install APK succeeds | After `\gradlew.bat :TeamCode:assembleDebug`, the APK sideloads cleanly. |
| 2 | Browser reaches `/runhealth/` | Saved Runs page renders from `http://192.168.43.1:8080/runhealth/`. |
| 3 | Recording Off — no file written | With Recording OFF, run an integrated OpMode; no CSV appears in `/FIRST/RunHealth/runs/`. |
| 4 | Recording Off — capture() is a no-op | Telemetry shows no error and the loop timing is unchanged. |
| 5 | Record Next Run — armed but cancelled | Arm NEXT, INIT-cancel the OpMode, **do not** START.  List `/api/runs` — should be empty.  Re-arm NEXT; another OpMode should consume it. |
| 6 | Record Next Run — first sample consumes | Arm NEXT, run an integrated OpMode producing samples; CSV appears.  Re-arm — immediate start should produce a no-op (claim already OFF). |
| 7 | Record Every Run — multiple runs | With EVERY on, run two integrated OpModes; both produce CSVs. |
| 8 | One motor — only that motor logged | With one motor configured, the CSV has rows for exactly that motor. |
| 9 | Four drivetrain motors | CSV has rows for all four. |
| 10 | Eight or more motors | CSV has rows for all eight. |
| 11 | Full two-minute TeleOp | CSV length matches sample cap × motor count or lower; no truncation marker. |
| 12 | Autonomous OpMode | CSV length matches sample cap × motor count or lower. |
| 13 | Repeated start and stop | 5 successive run–stop cycles each produce a distinct CSV. |
| 14 | Unsupported current measurement | For a motor that returns blank `current_amps`, the CSV still records, but metric C is null in the comparison. |
| 15 | Disconnected motor | If a motor is unplugged, `capture()` does not throw; the affected motor's row has blank fields; other motors are unaffected. |
| 16 | Missing voltage sensor | Set up configuration with no battery sensor; battery voltage column is blank across the run. |
| 17 | Download one run | GET `/api/runs/{id}/download` returns a `text/csv` attachment with the CSV body. |
| 18 | Download selected runs | Browser "Download Selected" downloads each file sequentially with a single visible user-action confirmation. |
| 19 | Delete one run | DELETE on a single id returns 200; the file is gone. |
| 20 | Delete selected runs | Batch delete returns counts and `failed` array; partial failures are reported individually. |
| 21 | Baseline selection | PUT `/api/baseline` with a valid run id succeeds; `null` clears. |
| 22 | Baseline deletion | Delete the baseline run; baseline tracking clears automatically. |
| 23 | Direct comparison | "Direct" mode shows the comparison of the user-selected runs without changing the baseline. |
| 24 | Missing motor comparison | Whole-robot table shows "Missing" for the absent motor and "Stable/Changed" for the other ones. |
| 25 | Renamed motor | Renamed device appears as two separate motor rows; both flagged "Missing" on opposite sides. |
| 26 | Browser reconnect | Reload the page while connected; Saved Runs list refreshes. |
| 27 | Robot Controller restart | Force-stop the app; re-launch; recording mode and baseline restored. |
| 28 | Control Hub reboot | Power-cycle the Hub; recording mode and saved runs persist. |
| 29 | Large saved-run collection | After 50+ CSVs, "Storage used" displays; warning banner appears when total > 50 MB. |
| 30 | Low-storage warning | Manually exceed 50 MB; warning banner displays in the Saved Runs page. |
| 31 | Logger memory limit | Force a long-running teleop; truncated marker (`-truncated`) appears in filename. |
| 32 | Loop-performance measurement | Use `opModeIsActive()` wall-clock timing to confirm `capture()` cost < 5 ms typical. |
| 33 | CSV correctness | Open the produced CSV in the standalone viewer; metrics page renders; no error toast. |
| 34 | Standalone viewer | Open `viewer/src/index.html` with no networking; drag-drop a CSV; comparison works locally. |
| 35 | Panels installed | Install Panels APK; confirm `8001` is up; `/runhealth/` still works. |
| 36 | FTC Dashboard installed | `/dash` still works; `/runhealth/` still works. |
| 37 | Panels + FTC Dashboard + Run Health all installed | None of the three breaks; each route resolves correctly. |
| 38 | Road Runner OpMode integration | Add the integration to a Road Runner autonomous sample; confirmed CSV is written. |
| 39 | IterativeOpMode integration | Run the iterative example; same per-run artifacts as expected. |
| 40 | Route-conflict behavior | Register a conflicting route at startup manually via SDK Sample; log shows Run Health routes skip the conflicting one but continue. |
| 41 | File-isolation verification | Listing `/FIRST/blocks/` and `/FIRST/opmodes/` shows no Run Health files; only `/FIRST/RunHealth/runs/`. |

## Desk-verification status (auto-verifiable without a robot)

The following tests are verified by the JVM test suite under
`TeamCode/src/test/java/.../runhealth/`, by the viewer Vitest suite,
and by a clean `./gradlew.bat :TeamCode:assembleDebug --no-build-cache
--no-daemon` run.  They do **not** require a Control Hub and a
reference robot; they confirm the production wiring is intact.  The
list below covers **only the tests for which a JVM or Vitest test
already exists** — other tests (14, 16, partial 27) have JVM-testable
production surface but the JVM test has not been authored yet, so
they remain in the hardware-only column.

| # | Verifiable on the desk | Verification surface |
|---|--------------------------|----------------------|
| 1 | Install APK succeeds | `./gradlew.bat :TeamCode:assembleDebug --no-build-cache --no-daemon` produces `TeamCode/build/outputs/apk/debug/TeamCode-debug.apk` (~51 MB). |
| 17 | Download one run | `TeamCode/src/test/java/org/firstinspires/ftc/teamcode/runhealth/api/EndToEndApiSmokeTest.java` — POSTs a run then GETs `/api/runs/{id}/download` and parses `text/csv` content. |
| 19 | Delete one run | `TeamCode/src/test/java/org/firstinspires/ftc/teamcode/runhealth/api/EndToEndApiSmokeTest.java` — issues DELETE and verifies the file is gone from the storage directory. |
| 21 | Baseline selection | `TeamCode/src/test/java/org/firstinspires/ftc/teamcode/runhealth/api/EndToEndApiSmokeTest.java` — sets a baseline run id and verifies the read-back via the API. |
| 22 | Baseline deletion auto-clears | `TeamCode/src/test/java/org/firstinspires/ftc/teamcode/runhealth/api/EndToEndApiSmokeTest.java` — deletes the baseline run then verifies the persisted baseline is `null`. |
| 33 | CSV correctness | `viewer/tests/parser.test.ts`, `viewer/tests/metrics.test.ts`, `viewer/tests/comparison.test.ts` — Vitest runner via `npm test` in `viewer/`. |
| 34 | Standalone viewer | `npm run build` in `viewer/` lands the bundle at `TeamCode/src/main/assets/runhealth/assets/main.js` and `viewer/dist/main.js`. |
| 41 | File-isolation (test-target layout) | `TeamCode/src/test/java/org/firstinspires/ftc/teamcode/runhealth/api/EndToEndApiSmokeTest.java` — verifies RunStorage writes only into a designated `runs/` directory, never into sibling paths. The on-Hub check for `/FIRST/blocks/` vs `/FIRST/opmodes/` still requires a Hub. |

All other test cases (Rec. modes 2–16, browser UI 18, 20, 23–32, and
third-party integrations 35–40) require real hardware and must be
executed on a Control Hub following the standard FTC test protocol.

## JVM-test-environment caveats

The JVM suite is best-effort and skips some assertions on Windows
where the OS uses temp-directory junctions that confuse
`FilenameSanitizer.isWithinDirectory`'s canonical-prefix check.
Specifically, `EndToEndApiSmokeTest` skips on Windows-detected
machines (`Assume.assumeFalse(os-name contains "Windows")` at
`@Before`); tests run on Linux hosts and on a Mac.  This does **not**
affect the production code path on the Hub, which only ever touches
`/FIRST/RunHealth/runs/`.


## Reporting

Each test should record:

* pass/fail
* timestamp and hub ID
* run id(s) produced
* any anomalies observed
* any stack traces (sanitized) from `/api/runs` errors

## Out of scope

* Comparing against rev-archived snapshots beyond the saved-runs
  trend view.
* Multi-Club shared historical analysis (no cloud component).

## Live telemetry (control hub)

When executing on a physical Control Hub, verify:

* `/runhealth/api/live/snapshot` responds 200 with `application/json`
  within 5 ms under no-session and 50 ms under a synthetic publish.
* `POST /runhealth/api/live/snapshot` returns 405 (rejected).
* Recording mode OFF does not prevent live publishing — the
  endpoint still returns a structured inactive snapshot.
* Closing all browser tabs does not stop recording or break the
  durable files on disk.
* The Active flag flips to `false` exactly when `finish()` is
  called by the session (and not before).
