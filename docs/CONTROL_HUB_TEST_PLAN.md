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
