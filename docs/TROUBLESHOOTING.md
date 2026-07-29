# FTC Run Health — Troubleshooting

Common symptoms and fixes.  Whenever in doubt, also check
`LIMITATIONS.md` and `CONTROL_HUB_TEST_PLAN.md`.

## No runs appear in the Saved Runs list

1. **Recording is OFF.**  This is the *default*.  Open
   `http://192.168.43.1:8080/runhealth/` and click **Record Next Run**
   or **Record Every Run**.
2. **OpMode not integrated.**  Run Health only records OpModes that
   call `RunHealthSession.start(...)`.  Adding the integration to your
   team's OpMode ladder is described in `INSTALLATION.md`.
3. **OpMode canceled before first sample.**  In "Record Next Run"
   mode, the claim is intentionally held until the first successful
   `capture()`.  If your OpMode is initialized but canceled in the
   Driver Station before pressing START, no file is written and the
   NEXT claim is **not** consumed.  Run it again from a different
   INIT/START to actually consume the claim.

## Browser can't reach `/runhealth/`

* Confirm your laptop is on the Control Hub SSID (`FIRST-XXXX`
  typically).  The Driver Station must also be on that same SSID.
* Confirm the device is on the latest Robot Controller app (v11.2+).
* If `/runhealth/` returns the fallback HTML ("bundled assets not
  available"), the assets folder is missing.  Rebuild from the
  `viewer/` directory (`npm run build`) and re-flash the APK.

## `/runhealth/api/runs` returns an error

* Inspect the response body.  Errors are JSON-shaped
  (`{"error":"...","code":"...","detail":"..."}`) and never include
  stack traces.
* Common codes:
  - `404 not_found` — the storage directory `RunHealth/runs/` does
    not exist yet.  Run **any** integrated OpMode (which writes to
    the directory on `finish()`) — then retry.
  - `bad_request` — your request body or URL is malformed.

## `capture()` appears to slow my OpMode

`capture()` does at most one read per DcMotorEx per call, capped at
10 Hz.  Typical cost per call: **sub-millisecond** on a REV Control
Hub with eight motors.  If you observe a slowdown:

1. Confirm you are not also using `LynxModule.BulkCachingMode.MANUAL`
   in the same OpMode; the two modes already share one bulk read.
2. Disable any high-frequency telemetry actions triggered from the
   same loop iteration.
3. Consider calling `capture()` every other iteration if your loop
   is unusually tight.

## "Insufficient comparable data" for every motor

This typically means your OpMode never commanded power above 0.15,
or the recorded run is too short.  Both are correct behaviours.
Increase commanded power and lengthen the run; or
see `forward-reverse-differences.csv` in `sample-data/` for a
fixture that does exercise active motion.

## A run file is truncated

The logger captures at most 5,400 samples per motor (~9 minutes at
10 Hz).  When the cap is exceeded, the run is finalised with the
footer marker `__RUN_HEALTH_TRUNCATED__` and the filename embeds
`-truncated`.  The browser Saved Runs UI surfaces a **Truncated: Yes**
column.

## I deleted a run that was the baseline

The `/api/runs/{id}/delete` endpoint automatically clears the
baseline if the deleted file matched.  The browser views the
baseline as "unavailable" until you re-select one.

## The CSV file has unexpected motor names

If your OpMode does not pass a `Map<DcMotorEx, String>` to
`RunHealthSession.start(...)`, the device name will appear as
`unknown`.  See `LIMITATIONS.md` on the FTC SDK's missing
device-instance → name reverse lookup.

## Permissions / Android security exceptions

`RunStorage` falls back to the app's internal storage directory if
the external `getExternalFilesDir(null)` returns null.  You should
not observe permission errors with normal use.

## JVM-test-environment limitations

These are non-blocking issues observed only on the JVM-test
verification path (your laptop or CI), not on the Control Hub itself.

1. **Windows temp-directory junction breaks `RunStorage` test paths.**
   `EndToEndApiSmokeTest` skips on Windows-detected machines via
   JUnit's `Assume.assumeFalse(os-name contains "Windows")`
   because `Files.createTempDirectory` on Windows resolves through
   an app-data junction whose canonical path differs from the
   seg-prefix-check in `FilenameSanitizer.isWithinDirectory`.  The
   production code is unaffected — the on-Hub path only ever
   writes to `/FIRST/RunHealth/runs/`, no junctions.  Run the smoke
   test on Linux / macOS / WSL for full coverage.

2. **v2 channels CSV writer requires a real `HardwareMap` to read v2
   end-to-end.** The JVM tests cover `ChannelsCsv.sampleRow` and
   `RunManifest` independently, but the actual `RunHealthSession`
   finish() write path that emits a `<stem>.channels.csv` + a
   `<stem>.manifest.json` next to a v1 motor CSV is exercised on a
   real Control Hub (Test Plan §25, §28, §29, §33).

## Viewer backlog

These are real feature-completeness items surfaced for the v2 channel
and manifest companion files.  The production writer is complete;
the viewer-side parser integration is the next step.

1. **Viewer parser doesn't yet expose `parseChannelsCsv` /
   `parseManifestJson`.** The v2 companions are written correctly by
   the on-device writer, but `viewer/src/parser.ts` only declares the
   shapes via `viewer/src/types.ts` (`ChannelSamples`, `RunManifestSummary`)
   without implementing the actual TS readers.  Work is "done" the day
   `viewer/src/parser.ts` exposes a
   `parseChannelsCsv(text): ChannelSamples` / `parseManifestJson(json):
   RunManifestSummary` function pair referencing the existing types in
   `viewer/src/types.ts` (no production-code change required).

   To prevent the contract from drifting silently between docs and
   source, two anchor points now exist:

   * `viewer/src/parser.ts` exports a **stub pair** with the exact
     names + types + throws-`"viewer_backlog: ..."` behaviour so a
     verifier-grep against the source returns true today and stops
     returning true once the bodies are filled in.
   * `viewer/tests/parser.test.ts` includes a `describe('v2 channels +
     manifest contract stubs (viewer backlog)')` block that asserts the
     throws fire — the assertion will be replaced with real parser
     tests once the implementation lands.

   A reproducer:

   ```
   grep -F "viewer_backlog:" viewer/src/parser.ts    # should print 2 matches today
   grep -F "viewer_backlog:" viewer/tests/parser.test.ts  # expects 2 toThrow assertions
   ```

   Until then, drag-dropping a v2 channels CSV into the standalone
   viewer falls through to the v1 path and the companion is ignored.


## Live tab stays disconnected

If the Live tab never turns green:

1. Check the URL: `/runhealth/api/live/snapshot` must be reachable
   from the laptop (same Wi-Fi network as the Control Hub).
2. Confirm an OpMode is currently running and that `capture()` is
   being invoked.  The Live view shows the last successful publish
   timestamp to disambiguate "recording but disconnected" from
   "robot idle".
3. The endpoint is GET only — a POST/PUT request will return 405.
   If your client is sending a body, switch it to GET.
4. Browser hidden-page behaviour slows polling 5x; switch back to
   the foreground to recover normal cadence.
