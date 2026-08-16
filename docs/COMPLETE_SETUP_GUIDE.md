# FTC Run Health: Install and Physical Test Guide

This guide covers the complete laptop-to-Control-Hub workflow. FTC Run Health is bundled into one APK. No desktop server, browser extension, or separate phone app is required.

## Product boundary

FTC Run Health is a read-only observation tool. It can:

- Read the power already commanded by the OpMode.
- Read encoder velocity, motor current when available, motor mode, battery voltage, and loop timing.
- Stream a live dashboard over Control Hub Wi-Fi.
- Record a run and download the completed CSV to the connected computer.
- Compare two runs at matched power bands.
- Track response, current demand, possible-stall exposure, and evidence score across repeated tests.

It cannot start or stop an OpMode, set motor power, change motor mode or direction, tune PID, edit hardware configuration, inject gamepad input, or command any robot device.

Encoder position, odometry, and field-position views are intentionally excluded. The legacy CSV position column remains blank so older recordings stay import-compatible.

## Files and URLs

APK to install:

```text
C:\Users\victo\Documents\ftc-run-health\TeamCode\build\outputs\apk\debug\TeamCode-debug.apk
```

Default dashboard URL:

```text
http://192.168.43.1:8080/runhealth/
```

Control Hub management page:

```text
http://192.168.43.1:8080/
```

Useful read-only API checks:

```text
http://192.168.43.1:8080/runhealth/api/runs
http://192.168.43.1:8080/runhealth/api/live/snapshot
http://192.168.43.1:8080/runhealth/api/recording
```

If the Control Hub uses a non-default address, replace `192.168.43.1` with the address shown by the Driver Station.

## Build the APK

From Windows PowerShell:

```powershell
cd C:\Users\victo\Documents\ftc-run-health\viewer
npm install
npm test
npm run build

cd C:\Users\victo\Documents\ftc-run-health
.\gradlew.bat :TeamCode:testDebugUnitTest --no-build-cache --no-daemon
.\gradlew.bat clean :TeamCode:assembleDebug --no-build-cache --rerun-tasks
```

The final Gradle command must end with `BUILD SUCCESSFUL`. Rebuilding replaces the APK at the path above.

## Install the APK

1. Power the Control Hub from an approved FTC battery through the FTC power switch.
2. Connect the laptop to the Control Hub Wi-Fi network.
3. Open `http://192.168.43.1:8080/` in Chrome or Edge.
4. Open the page used to manage or update the Robot Controller application.
5. Select `TeamCode-debug.apk` from the APK path above and install or update it.
6. Wait for installation to complete.
7. Restart the Robot Controller app or reboot the Control Hub if requested.
8. Reconnect the Driver Station and verify the Robot Controller connection.
9. On the laptop, open `http://192.168.43.1:8080/runhealth/`.

If the team normally installs through Android Studio or REV Hardware Client, install the same APK with that tool instead. Only one method is needed.

## Browser download permission

The APK contains the logger, API, and dashboard. The dashboard must remain open on the laptop for automatic laptop downloads because a Control Hub cannot write directly into an arbitrary computer folder.

The first time Save Every Run downloads multiple files, Chrome or Edge may ask whether the site can download multiple files. Choose Allow. Files normally appear in the browser's configured Downloads folder. The dashboard also shows a `Download now` fallback link after each automatic save.

The run briefly exists on the Control Hub so the browser can retrieve it. The Saved Runs Delete action removes the hub copy after the laptop download is verified.

## Integrated Linear OpMode

The physical-test OpMode is the real TeamCode file, not a template:

```text
TeamCode/src/main/java/org/firstinspires/ftc/teamcode/BasicOpMode_Linear.java
```

Its existing hardware names and controls are unchanged:

```java
leftDrive  = hardwareMap.get(DcMotorEx.class, "left_drive");
rightDrive = hardwareMap.get(DcMotorEx.class, "right_drive");
```

Run Health adds only these concepts:

```java
Map<DcMotorEx, String> motorNames = new HashMap<>();
motorNames.put(leftDrive, "left_drive");
motorNames.put(rightDrive, "right_drive");

RunHealthSession session = RunHealthSession.start(hardwareMap, this, motorNames);
```

Inside the existing control loop, after normal motor commands:

```java
session.capture();
```

At shutdown:

```java
try {
    while (opModeIsActive()) {
        // Existing controls and motor commands remain here.
        session.capture();
    }
} finally {
    session.finish();
}
```

For another team OpMode, use the same three-part pattern. Pass an explicit `Map<DcMotorEx, String>` containing only real motor objects and their existing Robot Configuration names. Do not rename devices and do not replace control code.

## First safe bench test

1. Put the robot on a stable stand with every driven wheel clear of the floor.
2. Keep hands, hair, clothing, wires, and tools away from moving parts.
3. Have one person ready to press Stop and another ready to switch robot power off.
4. Connect the Driver Station and laptop to the Control Hub.
5. Open the Run Health dashboard URL.
6. Open Saved Runs and select Save Next Run.
7. Confirm the dashboard says the next run is armed.
8. On the Driver Station, select `Basic: Linear OpMode`.
9. Press Init, then Start.
10. Move the existing drive controls gently. Do not change the controls for this test.
11. Open Live and verify only `left_drive` and `right_drive` appear.
12. Confirm commanded-power and velocity graphs move continuously. Current may be unavailable on hardware or ports without current sensing.
13. Press Stop on the Driver Station.
14. Return to Saved Runs. The new row should say `Ready to download` immediately. Download does not wait for analysis.
15. Verify the browser download exists in the laptop Downloads folder.
16. Click Analyze only when the recording is needed in Replay, Compare, or History.

Stop immediately if the robot behaves differently from the original OpMode. Run Health has no hardware setters, so unexpected motion must be investigated in the OpMode, configuration, wiring, or installed APK version before continuing.

## Repeatable wear test

Motor wear conclusions are only useful when test conditions are repeatable.

1. Use the same OpMode every time.
2. Use the same payload, wheels, gearing, and floor surface.
3. Start with similarly charged batteries.
4. Include steady low, medium, and high power segments in both directions when safe.
5. Run long enough to collect at least 30 matched samples; 100 or more supports higher confidence.
6. Save the first healthy run as the reference.
7. Repeat after maintenance, impacts, or weekly during the season.
8. Analyze the two recordings.
9. In Compare, select the earlier run as Reference and the later run as Comparison.
10. Select a motor and review evidence confidence before interpreting its score.

## Reading Compare

Compare contains four independent overlays:

- Commanded power over normalized run time.
- Encoder velocity over normalized run time.
- Motor current over normalized run time, when available.
- Commanded power to delivered velocity, binned by matched command.

Each graph has its own finding, possible meaning, and next inspection. The robot-wide ranking helps distinguish a local motor path from a change affecting every motor.

Common evidence patterns:

- Velocity down and current up: inspect friction, binding, wheel contact, bearings, gearbox, chain or belt tension, and added load.
- Velocity down with lower battery voltage: retest with a similarly charged battery and inspect high-current connectors.
- One motor declines while peers remain stable: prioritize that motor, encoder, wiring, gearbox, wheel, and local drivetrain path.
- Most motors decline together: inspect battery, payload, floor surface, whole-drivetrain drag, and test consistency before replacing one motor.
- High command with low velocity: inspect obstruction, binding, encoder connection, or an intentionally holding mechanism.

These are advisory possibilities, not automatic proof of a failed part.

## Reading History

History automatically separates recordings by OpMode. Select:

1. The repeatable test or OpMode.
2. The motor.
3. Motor evidence score, response change, current change, velocity efficiency, current cost, current peak, or possible-stall exposure.

The first chronological loaded run for that OpMode is the history reference. Low-confidence comparisons are marked as gaps instead of reliable measurements.

## Save Next and Save Every Run

- Save Next Run records and downloads one completed integrated OpMode, then disarms.
- Save Every Run records and downloads each completed integrated OpMode until turned Off.
- Keep the dashboard tab open and the laptop connected to Control Hub Wi-Fi.
- Keep the browser's automatic-download permission enabled.
- A direct Download link works as soon as the hub lists the file, even while Analyze runs.
- Analyze loads one selected CSV only; it does not rescan every historical recording.

## Troubleshooting

### Dashboard does not open

- Confirm the laptop is connected to Control Hub Wi-Fi.
- Open `http://192.168.43.1:8080/runhealth/api/recording`.
- If the API opens but the dashboard does not, reinstall the newest APK.
- If neither opens, verify the Control Hub address and Robot Controller app state.

### Live says no active session

- Verify the running OpMode calls `RunHealthSession.start(...)` and `session.capture()`.
- Verify recording is Save Next Run or Save Every Run before Start.
- Verify the OpMode is running, not only initialized.

### Unexpected or unknown motor names

- Pass an explicit motor-name map to `RunHealthSession.start`.
- Add only motors already retrieved by the OpMode.
- Use exact existing Robot Configuration strings.
- Do not use inferred or placeholder names.

### Run is listed but analysis is not loaded

- Download is still available immediately.
- Click Analyze to parse that one run.
- If it reports retry available, retry once and verify Wi-Fi.
- Very large files may take longer to analyze, but do not block downloading.

### No current graph

- Current telemetry depends on the hub, motor controller, port, and FTC SDK.
- Velocity and command-response diagnosis still works without current.
- A missing current value is not zero amps.

### Compare says insufficient evidence

- Use the same OpMode and route.
- Cover the same power bands in both runs.
- Use the same motor mode and similar battery charge.
- Collect a longer run.

## Acceptance checklist

- APK installs and Driver Station reconnects.
- Dashboard opens at `/runhealth/`.
- Only explicitly mapped motors appear.
- Live sequence and graphs update continuously.
- Stopping the OpMode does not change robot behavior.
- Saved run appears immediately.
- Download works before analysis completes.
- The file exists in the laptop Downloads folder.
- Analyze loads only the chosen run.
- Compare overlays two different runs.
- Every comparison graph has a diagnosis.
- History separates runs by OpMode.
- Project tests and APK build complete successfully.

Physical hardware validation is required after every change to the robot, SDK, or APK. Software tests cannot verify wiring, mechanical condition, or the installed Control Hub environment.
