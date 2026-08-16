# FTC Run Health New User Guide

This guide is for FTC students, mentors, and testers using FTC Run Health for the first time. It covers installation, safe OpMode integration, recording, downloads, comparison, diagnosis, offline imports, and common problems.

## 1. What Run Health Is

FTC Run Health observes how the robot's motors respond to commands. It reads values already exposed by the FTC SDK and presents them as live graphs and saved-run comparisons.

It helps answer questions such as:

- Is this motor producing less encoder velocity for the same command than it did last week?
- Is it drawing more current to create the same movement?
- Did possible-stall exposure increase?
- Is a warning likely to be a battery/test-condition difference, or does it repeat under controlled conditions?
- Which time in the run should the team inspect in Replay?

Run Health cannot prove that a motor, gearbox, bearing, chain, wheel, wire, encoder, or battery is defective. It narrows the investigation and gives the team evidence to verify.

## 2. Safety Boundary

Run Health is read-only. It does not:

- Set motor power.
- Change gamepad controls or device names.
- Change motor direction, mode, target position, PID/PIDF, or zero-power behavior.
- Operate servos, sensors, cameras, or mechanisms.
- Remotely control the robot from the dashboard.

The integration adds calls that read motor state and save diagnostic data. Your OpMode remains responsible for all robot behavior. Stop physical testing if a mechanism binds, wiring heats up, the robot moves unexpectedly, or the test area is not clear.

## 3. What You Need

- The Run Health Robot Controller APK.
- A computer with Android SDK Platform Tools.
- The computer connected to Control Hub Wi-Fi.
- An integrated LinearOpMode that calls `RunHealthSession`.
- Correct FTC robot configuration names.
- Working encoders for velocity-based diagnosis.
- Chrome or another Chromium-based browser.

USB is not required when ADB over Control Hub Wi-Fi is available.

## 4. Build The APK

Open PowerShell in the repository root:

```powershell
.\gradlew.bat :TeamCode:clean :TeamCode:testDebugUnitTest :TeamCode:assembleDebug
```

The APK is created at:

```text
TeamCode\build\outputs\apk\debug\TeamCode-debug.apk
```

Do not install an older APK from another build folder when testing a dashboard change.

## 5. Install The APK With ADB

### 5.1 Connect to the robot network

Connect the computer to Control Hub Wi-Fi. The standard Hub address used by this project is `192.168.43.1`.

### 5.2 Open Platform Tools

Example Android SDK Platform Tools folder:

```powershell
Set-Location C:\Users\victo\AppData\Local\Android\Sdk\platform-tools
```

Your username or Android SDK location may be different.

### 5.3 Connect ADB

```powershell
.\adb.exe connect 192.168.43.1:5555
```

Expected output:

```text
connected to 192.168.43.1:5555
```

### 5.4 Install or replace the APK

Reusable command:

```powershell
.\adb.exe -s 192.168.43.1:5555 install -r "C:\path\to\ftc-run-health\TeamCode\build\outputs\apk\debug\TeamCode-debug.apk"
```

Verified command for this checkout:

```powershell
.\adb.exe -s 192.168.43.1:5555 install -r "C:\Users\victo\Documents\ftc-run-health\TeamCode\build\outputs\apk\debug\TeamCode-debug.apk"
```

Expected output:

```text
Performing Streamed Install
Success
```

The `-r` option replaces the installed build while preserving application data where Android permits it. The `-s` option targets the Control Hub when other Android devices are connected.

### 5.5 If ADB does not connect

1. Confirm the computer is still on Control Hub Wi-Fi.
2. Run `.\adb.exe devices` and check for `192.168.43.1:5555`.
3. Run `.\adb.exe disconnect 192.168.43.1:5555`, then connect again.
4. Restart the Robot Controller application or power-cycle the Hub if ADB is unavailable.
5. Do not change the IP unless your Hub network was intentionally configured differently.

## 6. Add Run Health To Your LinearOpMode

Edit the LinearOpMode in `TeamCode`, not an official template under `FtcRobotController`. Do not rename devices and do not change how controls work.

### 6.1 Add imports

```java
import org.firstinspires.ftc.teamcode.runhealth.logging.RunHealthSession;

import java.util.HashMap;
import java.util.Map;
```

### 6.2 Build an explicit motor-name map

After existing `hardwareMap.get(...)` calls, map each existing `DcMotorEx` object to the exact name already used in the Driver Station robot configuration:

```java
Map<DcMotorEx, String> runHealthMotors = new HashMap<>();
runHealthMotors.put(leftDrive, "left_drive");
runHealthMotors.put(rightDrive, "right_drive");
```

The strings are examples. Use your existing names exactly. This labels dashboard series; it does not rename devices.

### 6.3 Start the session

After hardware initialization and before `waitForStart()`:

```java
RunHealthSession runHealth =
        RunHealthSession.start(hardwareMap, this, runHealthMotors);

waitForStart();
```

Starting before `waitForStart()` creates the session, but **Save Next Run** is not consumed until the first successful sample. Canceling during INIT should leave the next-run intent armed.

### 6.4 Capture inside the active loop

Add one call after existing control and motor-update work:

```java
runHealth.capture();
```

The logger limits capture to one sample every 100 ms, so calling it on every loop is expected.

### 6.5 Finish in a finally block

```java
try {
    while (opModeIsActive()) {
        // Existing controls and motor commands.
        runHealth.capture();
    }
} finally {
    runHealth.finish();
}
```

`finish()` writes the completed recording. If it is omitted, the run may never appear. It is idempotent, so a second call does not write twice.

Complete example:

```text
TeamCode/src/main/java/org/firstinspires/ftc/teamcode/BasicOpMode_Linear.java
```

## 7. Open The Dashboard

While connected to Control Hub Wi-Fi, open:

**[http://192.168.43.1:8080/runhealth/](http://192.168.43.1:8080/runhealth/)**

If the page looks old after installing a new APK:

1. Close the old tab.
2. Restart the Robot Controller application.
3. Reopen the URL.
4. Use `Ctrl+Shift+R` if necessary.

## 8. Make The First Recording

1. Keep the dashboard tab open.
2. Open **Saved Runs**.
3. Select **Save Next Run**.
4. Confirm the next-run status is armed.
5. Select the integrated OpMode on the Driver Station.
6. Press INIT and START.
7. Drive through a safe, repeatable test.
8. Press STOP.
9. Wait for the new row in Saved Runs.
10. Confirm Chrome starts a download or press **Download**.
11. Wait for **Ready** before analysis.

The Hub must finish writing before the browser can analyze a run. A short delay is normal; the row should not remain indefinitely in Analyzing or Analysis unavailable.

## 9. Recording Modes

### Off

No durable run file is created. The recording session is a lightweight no-op.

### Save Next Run

The next integrated OpMode that produces a successful sample is recorded. The Hub changes the persisted mode to Off after that first sample. The browser continues waiting for the run to finish and then downloads it.

### Save Every Run

Every integrated OpMode is recorded until turned Off. Keep the dashboard open if every completed run should also be downloaded automatically.

## 10. Where Files Go

### Control Hub

Durable recordings stay in the Run Health directory under the FTC storage area and remain listed through the dashboard until deleted.

### Computer

Downloads go to the browser's configured Downloads location. In Chrome, press `Ctrl+J` to open the Downloads list.

Automatic computer saving is browser-driven:

- Keep the Run Health tab open.
- Keep the computer connected to Hub Wi-Fi.
- Allow automatic or multiple downloads for `192.168.43.1` if Chrome asks.
- Prevent the computer from sleeping during testing.
- Press the row's **Download** action if auto-save was blocked.

Closing the browser does not delete the Hub copy. Reconnect later and download it from Saved Runs.

## 11. Recording File Set

A current recording can include:

```text
RUN_ID.csv
RUN_ID.manifest.json
RUN_ID.channels.csv
```

- `RUN_ID.csv`: required motor samples.
- `RUN_ID.manifest.json`: metadata, build ID, duration, device list, truncation state, configuration fingerprint, and channel definitions.
- `RUN_ID.channels.csv`: optional custom channels and event markers.

For offline import, select the motor CSV and same-stem companions together. A motor-only file still works, but manifest and channel features are unavailable.

## 12. Dashboard Sections

### Live

- Commanded power is what the OpMode requested, from `-1.0` to `1.0`.
- Encoder velocity is measured speed in encoder ticks per second.
- Current is measured electrical current in amps when supported.
- Battery voltage helps explain battery-state differences.
- Motor mode is included because different modes may make comparisons incompatible.

The browser normally polls about four times per second and retains bounded recent history. Durable recording still captures at up to 10 Hz; live polling and recording are separate.

### Saved Runs

Use Saved Runs to change recording mode, see Hub/imported runs, download or delete, retry analysis, choose a baseline, and check truncation/metadata.

**Ready** means parsed data is available to every analysis tab. **Queued** or **Analyzing** means the browser is transferring and parsing one run at a time to avoid overloading the Hub.

### Compare

Select an earlier reference, a later comparison, a motor, direction, and power band. Strong comparisons use the same OpMode, configuration, motor mode, battery state, surface, payload, route, and approximate command pattern.

The command-to-velocity analysis matches samples in 0.1-wide absolute power bands so merely driving faster in one run is less likely to look like wear.

### Replay

Play, pause, change speed, or scrub to a suspicious point. Mixed signals can have different units, so use Replay for timing/pattern alignment and Compare for numerical conclusions.

### Channels

Optional OpMode-defined data. Numeric channels show minimum, maximum, median, final, and sample count. Boolean channels show transitions and time true. Text channels show state changes. Event markers preserve notable moments.

### Trends

Trends place the same metric for the same motor in chronological order. Multiple controlled tests help distinguish persistent change from one unusual run.

### Import

Import reads files locally in the browser and does not upload them to a cloud service. Imported runs become available in Saved Runs, Compare, Replay, Channels, and Trends for the current browser session.

## 13. Main Metrics

### Median absolute velocity

The middle value of absolute encoder velocity after filtering. Lower velocity can mean lower speed, added load, changed contact/gearing, lower available power, or different test conditions.

### Velocity per effective command

```text
effective command = |commanded power| * battery voltage / 12
response = median(|encoder velocity| / effective command)
```

A decline means less measured velocity was delivered for a battery-adjusted command.

### Current per movement

For samples at or above 50 ticks/s:

```text
current amps * 1000 / |encoder velocity|
```

Higher values mean more current per 1,000 ticks/s of motion. Possible causes include friction, binding, added load, wheel contact, drivetrain tension, or electrical problems.

### 95th-percentile current

A high-end current level less sensitive than one maximum spike. A rise can mean more frequent high-load operation, but route and mechanism use must be comparable.

### Possible-stall percentage

```text
|commanded power| > 0.20
and |encoder velocity| < 50 ticks/s
```

This pattern can mean obstruction, binding, intentional holding, an encoder problem, or startup delay. It is not proof of a stalled motor.

### Percentage change

```text
(comparison - reference) / |reference| * 100
```

No percentage is calculated when the reference is zero or unavailable.

### Status thresholds

- Stable: absolute change below 5%.
- Changed: 5% up to 15%.
- Large Change: at least 15%.
- Insufficient Data: fewer than 20 qualifying samples on either side.
- Missing: motor absent from one run.
- Incompatible Data: motor-mode evidence makes comparison unreliable.

## 14. Wear Evidence And Score

Samples are grouped by absolute commanded power in 0.1-wide bands from 0.1 through 1.0. A band needs at least five samples, and only matching bands contribute.

Confidence:

- High: at least five matched bands and 100 paired samples.
- Medium: at least two matched bands and 30 paired samples.
- Low: less overlap or a motor-mode mismatch.

Warnings:

- Velocity decrease of 8%: watch; 15%: warning.
- Current increase of 10%: watch; 20%: warning.
- Response decrease of 8%: watch; 15%: warning.
- Possible-stall increase of five percentage points: warning.
- Battery decrease of 0.5 V or more: battery/power delivery may explain response loss.

When response data exists, the health score starts at 100 and subtracts bounded penalties for response loss, current increase, and possible-stall increase. It is a comparison score, not remaining life or a safety certification.

## 15. Repeatable Motor Health Test

1. Charge the battery consistently.
2. Inspect the robot for loose or unsafe parts.
3. Use the same field surface and payload.
4. Warm up consistently if temperature matters.
5. Run the same OpMode and route.
6. Include steady low, medium, and high power sections.
7. Avoid collisions and unusual corrections.
8. Keep the clean first run as the reference.
9. Repeat later under similar conditions.
10. Compare the same motor and direction.
11. Inspect warnings in Replay and Compare.
12. Repeat once before replacing a component.

## 16. Investigate Warnings

### Less velocity, more current

Stronger evidence of added mechanical load. Inspect wheel contact, shafts, bearings, gearbox, chain/belt tension, frame interference, and mechanism load.

### Less velocity, similar current

Repeat with the same battery. Check encoder readings, motor mode, gearing, wheel slip, surface, and command coverage.

### Less velocity and lower battery voltage

Retest with a similarly charged battery. Inspect high-current connectors and power distribution before attributing change to wear.

### More current without velocity loss

The route or payload may differ. Review spikes in Replay and inspect developing friction if the increase repeats.

### More possible-stall samples

Find the matching time interval. Determine whether the mechanism intentionally held. Check obstruction, binding, encoder connection, and command-to-motion delay.

## 17. Troubleshooting

### Dashboard does not open

- Confirm Control Hub Wi-Fi.
- Open `http://192.168.43.1:8080/runhealth/`, not the ADB port.
- Confirm the Robot Controller app is running.
- Reinstall the current APK with ADB.
- Restart the app and hard-refresh Chrome.

### Live is disconnected or has no session

- Confirm the OpMode calls `start(...)` and `capture()`.
- Confirm the OpMode is running, not only initialized.
- Keep the dashboard tab visible.
- Missing current alone may be hardware capability; it should not block power/velocity.

### Motor names are unknown

- Pass an explicit `Map<DcMotorEx, String>` to `start(...)`.
- Use existing configuration names exactly.
- Do not invent or rename devices for Run Health.

### Run never appears after STOP

- Confirm Save Next Run or Save Every Run was armed before START.
- Confirm `capture()` ran and motors were discovered.
- Confirm `finish()` is in `finally`.
- Refresh Saved Runs and keep the Hub powered while writing.

### Download is not on the computer

- Press `Ctrl+J` and inspect Chrome Downloads.
- Allow automatic/multiple downloads for `192.168.43.1`.
- Keep the dashboard open before and after STOP.
- Press the row's **Download** button.
- Check Chrome's configured Downloads folder.
- A dashboard-listed file remains on the Hub even if browser download was blocked.

### Analysis unavailable

- Confirm Hub Wi-Fi and test manual Download.
- Press **Retry analysis**.
- Wait for queued runs; transfers are serialized.
- Restart the Robot Controller app and reopen the dashboard if every run fails.
- Import the downloaded file to continue locally.

### Current is unavailable

Not every hardware/device combination exposes current sensing. Unavailable is not zero. Command/velocity analysis can still work; current metrics remain unavailable.

### Insufficient data

- Run longer and include steady samples in the selected band.
- Try All Active if the filter is too narrow.
- Keep at least 20 qualifying samples per run.
- Include two or three overlapping 0.1 power bands for wear matching.

### Incompatible data

- Check motor modes within and between runs.
- Repeat with the same OpMode and configuration.

## 18. Retention And Cleanup

- Hub recordings persist until deleted or application/storage data is cleared.
- The dashboard warns around 50 MB of motor CSV storage.
- Deleting a baseline run clears baseline selection.
- Deleting a run also attempts to remove its companions.
- Download important baselines before deleting Hub copies.

## 19. Important Limits

- Do not compare ticks/s between different motor/gearing/encoder setups.
- One run is not a wear trend.
- Battery, surface, payload, route, temperature, and motor mode can mimic wear.
- Current may be unavailable.
- Process kill or power loss before `finish()` can lose the active run.
- Long runs can reach the sample cap and be marked truncated.
- Automatic download requires an open, connected browser and browser permission.
- Dashboard suggestions require safe human verification.

## 20. Quick Test Checklist

- [ ] Build completed without errors.
- [ ] ADB reported `Success`.
- [ ] Dashboard opened at `/runhealth/`.
- [ ] Integrated OpMode appears on Driver Station.
- [ ] Existing controls work exactly as before.
- [ ] Live shows expected configured motor names.
- [ ] Power and velocity respond while driving.
- [ ] Save Next Run is armed.
- [ ] New run appears after STOP.
- [ ] Chrome receives the download.
- [ ] Run becomes Ready.
- [ ] Run is selectable in Compare, Replay, and Trends.
- [ ] Imported download is selectable in the same tools.
- [ ] Robot remains safe and responsive.
