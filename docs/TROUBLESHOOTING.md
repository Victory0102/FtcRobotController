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
