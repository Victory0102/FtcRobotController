# FTC Run Health — Installation

This document explains how to add **FTC Run Health** to an FTC team's
Robot Controller project.  It assumes the project was forked from
FtcRobotController and includes the standard `TeamCode/` module.

## 1. Pull the bundle into Team Code

Copy the contents of `TeamCode/src/main/java/org/firstinspires/ftc/teamcode/runhealth/`
into your Team Code module (overwriting nothing).  This adds the
following classes:

```
org.firstinspires.ftc.teamcode.runhealth.logging.{RunHealthSession,
  RunHealthCsv, RunId, FilenameSanitizer, MotorSample,
  BatteryVoltageReader, RunHealthConfig, RunStorage}
org.firstinspires.ftc.teamcode.runhealth.api.{RunHealthApi,
  RunHealthWeb}
```

Copy the bundled UI into your team's assets folder:

```
TeamCode/src/main/assets/runhealth/
   index.html
   styles.css
   assets/main.js     (and any sibling assets/main.js.map)
   manifest.json
```

The `TeamCode/build.gradle` already includes the assets directory
listing so the APK bundling picks them up automatically.

## 2. (Optional) Build the viewer from source

If you need to modify the viewer:

```powershell
cd viewer
npm install
npm test
npm run build
```

The `npm run build` script compiles TypeScript → `viewer/dist/`, then
copies `dist/*` and the static `index.html`/`styles.css` into
`TeamCode/src/main/assets/runhealth/`.

## 3. Build the Team Code APK

```powershell
.\gradlew.bat :TeamCode:assembleDebug
```

The APK is now bundled with the Run Health logger, API, and UI assets.

## 4. Sideload the APK to the Control Hub

Connect the laptop to the Control Hub Wi-Fi, open a browser to
`http://192.168.43.1:8080`, follow the standard REV sideload
instructions.  The Robot Controller app installs with Run Health
integrated.

## 5. Verify the installation

After installation:

1. Open `http://192.168.43.1:8080/runhealth/` from a laptop on the
   Control Hub Wi-Fi.  The Saved Runs page should render.
2. If the page fails to load, the bundle is missing — recheck the
   `assets/runhealth/` step above.  The fallback HTML page still
   renders, with a link to `/api/runs`.
3. Run an eligible integrated OpMode (see the example in
   `docs/PRODUCT_SCOPE.md`).  After the run, refresh the Saved Runs
   page and the run should appear.

## 6. Add an integrated OpMode

The minimum integration is:

```java
RunHealthSession session = RunHealthSession.start(hardwareMap, this);

try {
    waitForStart();
    while (opModeIsActive()) {
        // existing robot code
        session.capture();
    }
} finally {
    session.finish();
}
```

For the installed linear example, see
`TeamCode/src/main/java/org/firstinspires/ftc/teamcode/BasicOpMode_Linear.java`.

## 7. Recording mode

Recording is **off by default**.  After installation:

1. From a laptop, open `http://192.168.43.1:8080/runhealth/`.
2. In the **Saved Runs** tab, click **Recording mode**.
3. Choose:
   - **Recording Off** — nothing is recorded.
   - **Record Next Run** — only the *next* eligible integrated
     OpMode is recorded.  The claim is consumed on the first
     successful sample, never on INIT.
   - **Record Every Run** — every eligible integrated OpMode is
     recorded until you turn it off.

The selection persists across browser refresh, Robot Controller
restart, and Control Hub reboot (the underlying `SharedPreferences`
is persisted on the Android filesystem).

See `docs/CONTROL_HUB_TEST_PLAN.md` for a comprehensive test plan.
