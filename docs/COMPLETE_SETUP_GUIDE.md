# FTC Run Health Complete Setup, Installation, and First-Test Guide

A beginner-friendly, copy-and-paste-ready guide for installing and using
**FTC Run Health** on a REV Control Hub from a Windows laptop.  This
guide assumes no prior experience with Run Health.

---

## Table of contents

1.  [What FTC Run Health is](#1-what-ftc-run-health-is)
2.  [Parts of the system](#2-parts-of-the-system)
3.  [Prerequisites](#3-prerequisites)
4.  [Where the completed APK is located](#4-where-the-completed-apk-is-located)
5.  [Two installation approaches](#5-two-installation-approaches)
6.  [Build instructions (Windows PowerShell)](#6-build-instructions-windows-powershell)
7.  [Install the APK on the Control Hub](#7-install-the-apk-on-the-control-hub)
8.  [Verify the Run Health page](#8-verify-the-run-health-page)
9.  [Robot configuration requirements](#9-robot-configuration-requirements)
10. [OpMode integration](#10-opmode-integration)
11. [Optional custom telemetry](#11-optional-custom-telemetry)
12. [Recording modes](#12-recording-modes)
13. [Saved Runs](#13-saved-runs)
14. [Replay](#14-replay)
15. [Field view](#15-field-view)
16. [Comparison and baseline](#16-comparison-and-baseline)
17. [Trends](#17-trends)
18. [Live telemetry](#18-live-telemetry)
19. [First physical test procedure](#19-first-physical-test-procedure)
20. [Full-robot rollout plan](#20-full-robot-rollout-plan)
21. [Troubleshooting](#21-troubleshooting)
22. [Software verification commands](#22-software-verification-commands)
23. [Completion checklists](#23-completion-checklists)

> **Honest status note** — All software described in this guide is
> verified green on the latest local build (156 viewer tests, 111 JVM
> tests, clean Android assembleDebug).  Physical Control Hub
> verification has **NOT** yet been performed on a real hub and must be
> repeated on hardware before the tool is relied upon for matches.

---

## 1. What FTC Run Health is

FTC Run Health is a **read-only robot observability** tool.  It watches
what your robot is doing, saves the evidence, and helps you understand
what changed or went wrong.

What the tool **does**:

- Shows live motor values, battery voltage, and custom telemetry in a
  browser.
- Lets you record selected runs to durable files on the Control Hub.
- Displays post-run graphs for commanded power, encoder position,
  encoder velocity, current (when available), and battery voltage.
- Lets you replay saved runs with play, pause, scrub, and
  `0.25x` / `0.5x` / `1x` / `2x` / `4x` playback speeds.
- Compares any two runs side-by-side, motor by motor.
- Compares any run against a baseline **you** explicitly select.
- Tracks trends across many runs (median velocity, velocity
  efficiency, current cost, 95th-percentile current, possible stall
  percentage, loop-time statistics, battery minima, custom numeric
  channels).
- Renders robot pose on a generic 12 ft × 12 ft field.
- Imports legacy motor-only CSV files for offline analysis.

What the tool **never does**:

- It does **not** start, stop, or pause an OpMode.
- It does **not** command motors or servos.
- It does **not** inject gamepad commands.
- It does **not** tune PID values.
- It does **not** change robot constants.
- It does **not** edit the robot configuration.
- It does **not** send movement commands from the browser.
- It does **not** decide for you which run is the baseline — you
  choose explicitly.

If you need a tool that drives the robot, use your Driver Station and
your normal OpMode code.  Run Health watches the hardware; it does
not drive it.

---

## 2. Parts of the system

| Part | Where it lives | What it does |
|---|---|---|
| FTC Robot Controller app | Installed on the Control Hub | Runs your OpMode code, exposes the FTC web server. |
| `TeamCode` Gradle module | Your project | Holds your OpMode code and Run Health. |
| `org.firstinspires.ftc.teamcode.runhealth` package | `TeamCode/src/main/java/org/firstinspires/ftc/teamcode/runhealth/` | The Run Health Java implementation. |
| Bundled browser viewer | `TeamCode/src/main/assets/runhealth/` | HTML + JS the browser loads. |
| Control Hub web server | built into the Robot Controller | Serves the bundled viewer at `/runhealth/`. |
| APK | `TeamCode/build/outputs/apk/debug/TeamCode-debug.apk` | What you install on the Control Hub. |
| Saved recordings | the Control Hub's local storage | CSV files listing motor samples over time. |
| Live snapshot endpoint | `GET /runhealth/api/live/snapshot` | The read-only current-state feed. |
| Browser route | `http://<control hub ip>:8080/runhealth/` | Where you point your laptop browser. |

Simple architecture:

```text
Your OpMode loop
   |
   v
RunHealthSession
   |
   +-> Live snapshot (bounded, read-only)
   |     |
   |     v
   |   Browser Live tab   <-- GET /runhealth/api/live/snapshot (poll)
   |
   +-> Saved recording (durable files)
          |
          v
       Replay / Graphs / Compare / Trends  (all offline / read-only)
```

The Robot OpMode (`capture()` calls) is the **only** path that writes
data.  The browser only reads.

---

## 3. Prerequisites

### Computer

- **Windows 10 or Windows 11.**  Commands in this guide are
  PowerShell-formatted.  macOS / Linux paths are similar but not
  covered here.
- **Android Studio.**  Use the version required by the FTC SDK you
  already have.  Open Android Studio and it will tell you if your
  Gradle plugin or build tools are out of date.
- **Git.**  You will need it only if you want to clone fresh.
- **JDK.**  JDK 11 or newer is recommended.  The bundled Gradle
  wrapper will use the JDK Android Studio points at.  In PowerShell:

  ```powershell
  java -version
  ```

  A successful value looks like:

  ```text
  openjdk version "17.0.x" 2024-xx-xx
  ```

- **Node.js and npm.**  Only required **when rebuilding the bundled
  browser viewer**.  Node 18 or newer is recommended:

  ```powershell
  node --version
  npm --version
  ```

- **USB cable.**  USB-A to USB-Mini-B is the typical REV Control Hub
  cable; some hubs ship USB-A to USB-C.  You only need the cable for
  the first-time APK install, or for ADB.
- **A modern web browser.**  Chrome, Edge, or Firefox.  Run Health's
  bundled JS uses widely-supported vanilla TypeScript.

### FTC hardware

- **REV Control Hub** (the current shipping model).
- **An approved FTC 12 V battery.**  Lead-acid or LiFePO<sub>4</sub> as
  your team uses in competition.
- **The FTC power switch** that ships between the battery and the
  Control Hub's XT30 connector.
- **Driver Station.**  A Driver Station phone (or REV Driver Hub) with
  the FTC Driver Station app installed and paired to the Control Hub.
- **At least one configured motor** for the first hardware test.
- **Encoder cables** when encoder position / velocity is part of what
  you want to observe.

> ⚠️ **SAFETY WARNING** ⚠️
>
> - Do **not** power the Control Hub directly from an FTC battery
>   charger.
> - Use an approved FTC battery, routed through the FTC power switch,
>   into the Control Hub's XT30 input.
> - During the first bench test, **secure the motor** so it cannot
>   move unexpectedly.  A spinning wheel can break things or hurt
>   someone.
> - **Keep wheels off the ground** during the first bench test.

---

## 4. Where the completed APK is located

The most recent successful build produced:

```text
C:\Users\victo\Documents\ftc-run-health\TeamCode\build\outputs\apk\debug\TeamCode-debug.apk
```

Repository-relative path:

```text
TeamCode/build/outputs/apk/debug/TeamCode-debug.apk
```

Open the folder in Explorer:

```powershell
explorer "$HOME\Documents\ftc-run-health\TeamCode\build\outputs\apk\debug"
```

The file you install on the Control Hub is **`TeamCode-debug.apk`**.

Rebuilding the project may replace this APK with a newer version.  The
old APK will not be in git (it is gitignored), so always rebuild and
copy the latest from the build folder.

---

## 5. Two installation approaches

### Approach A — use the completed Run Health repository

This is the easier path; do this first.

1. Open Android Studio.
2. Choose **File → Open** and select the existing repository folder:

   ```text
   C:\Users\victo\Documents\ftc-run-health
   ```

3. Wait for Gradle to finish synchronising.  Look at the bottom of
   the IDE for **"Gradle sync finished in N s"**.
4. Open **File → Project Structure → SDK Location** and confirm
   `local.properties` points to your Android SDK.  If not, edit it:

   ```text
   sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
   ```

5. Open the **Gradle** panel in Android Studio, expand
   **`:TeamCode → Tasks → build`**, and double-click **`assembleDebug`**.
   Or run it from PowerShell (see Section 6).
6. Wait for **BUILD SUCCESSFUL**.  Locate the APK (Section 4).
7. Install the APK on the Control Hub (Section 7).

### Approach B — add Run Health to another FTC team project

This is harder because Run Health ships runtime Java **and** bundled
browser assets.  You must copy both.

Minimum required source and asset paths:

| Source path (in this repo) | Destination path (in the team project) |
|---|---|
| `TeamCode/src/main/java/org/firstinspires/ftc/teamcode/runhealth/` | `TeamCode/src/main/java/org/firstinspires/ftc/teamcode/runhealth/` |
| `TeamCode/src/main/assets/runhealth/` | `TeamCode/src/main/assets/runhealth/` |

Plus Gradle-required additions (already present in this repo):

- `:TeamCode` module already depends on Android and the FTC SDK; do
  not change `:TeamCode/build.gradle` unless your team project is
  missing those dependencies.
- The Run Health SDK wiring relies on the
  `WebHandlerRegistrar` annotation mechanism.  The annotated method
  in `RunHealthWeb.java` is found by FTC SDK classpath scanning; you
  must not move it to a non-`org.firstinspires.ftc.teamcode.runhealth`
  package without keeping the public static signature
  `@WebHandlerRegistrar public static void`.

Plus documentation to copy if you want the team to have the docs:

| Source | Destination |
|---|---|
| `docs/*.md` | `docs/` in the team repo (review for relevance first). |

Plus example OpModes (optional):

| Source | Destination |
|---|---|
| `TeamCode/src/main/java/org/firstinspires/ftc/teamcode/runhealth/examples/` | Same folder in the receiving project, or copy the example methods into your own `LinearOpMode`. |

> **Do not overwrite unrelated team code.**  The receiving project
> should have its own `package org.firstinspires.ftc.teamcode;` with
> its own classes.  Place Run Health under the **same** package,
> similarly named with a `runhealth` sub-package, so future merges
> are clean.

---

## 6. Build instructions (Windows PowerShell)

### Build the viewer only when needed

The Java part does not require a viewer rebuild.  Rebuild the viewer
when:

- You change anything under `viewer/src/`.
- You want to bundle a viewer-side change into the APK.

In PowerShell:

```powershell
cd $HOME\Documents\ftc-run-health\viewer
npm install
npm test
npm run build
```

What each command does:

| Command | What it does |
|---|---|
| `npm install` | Downloads the viewer's typed-build toolchain (TypeScript, Vitest, esbuild) into `viewer/node_modules/`.  This folder is **gitignored** and must never be committed. |
| `npm test` | Runs Vitest: 156 tests across 8 files (parser, metrics, comparison, trends, replay, field, graphs, live).  Aim for **156 passed (156)**. |
| `npm run build` | Runs `tsc -p tsconfig.json` (full type check) and then `node ./scripts/copy-assets.mjs`, which copies the compiled `.js` files from `viewer/dist/` into `TeamCode/src/main/assets/runhealth/assets/`. |

> `viewer/node_modules/` is gitignored.  Do not commit it.  Without
> `npm install` you cannot run the viewer tests or build.

### Run the Java unit tests

From the repository root:

```powershell
cd $HOME\Documents\ftc-run-health
.\gradlew.bat :TeamCode:testDebugUnitTest --no-build-cache --no-daemon
```

Expected successful output:

```text
BUILD SUCCESSFUL in <N>s
```

with a brief summary line such as `111 tests completed, 0 failed, 10 skipped`.
Tests marked `skipped` are Android-runtime instrumentation tests that
deliberately do not run on the JVM; that is expected and correct.

### Perform a clean APK build

```powershell
cd $HOME\Documents\ftc-run-health
.\gradlew.bat clean :TeamCode:assembleDebug --no-build-cache --rerun-tasks
```

What each part does:

| Part | What it does |
|---|---|
| `clean` | Removes every Gradle build output (including Stale `layoutlib`, snapshots, and DEX caches). |
| `:TeamCode:assembleDebug` | Compiles the `TeamCode` module and packages the debug APK. |
| `--no-build-cache` | Skips Gradle's build cache.  Use this when you specifically do not want to reuse a previous build. |
| `--rerun-tasks` | Re-runs every task even if Gradle believes it is up to date. |

Expected successful output (tail):

```text
BUILD SUCCESSFUL in <N>s
```

The APK appears at:

```text
TeamCode/build/outputs/apk/debug/TeamCode-debug.apk
```

> **Notes on warnings**
> The upstream FTC SDK frequently emits Java source-version warnings
> like:
>
> ```text
> warning: [options] source value 8 is obsolete and will be removed in a future release
> ```
>
> These warnings come from the FTC SDK source and are not your
> problem.  Warnings are not errors.  A successful build ends with
> `BUILD SUCCESSFUL`; a failing build ends with `BUILD FAILED` and a
> verbose `error: ...` line.  **Distinguish the two by the final
> status line, not by warnings alone.**

---

## 7. Install the APK on the Control Hub

1. Power the Control Hub safely through the FTC power switch (do not
   connect a charger directly).  Wait for the Hub LED to indicate it
   is fully booted (steady green on most firmware versions).
2. Connect your laptop to the Control Hub's Wi-Fi network.  The
   network name is normally the Hub's team number, formatted as
   `FTC-1234` or similar.
3. Identify the Control Hub password.  The default password is
   `password`.  If your team changed it, use the team's documented
   password.
4. Open the Control Hub's web interface.  The default address is:

   ```text
   http://192.168.43.1:8080
   ```

   If your Hub's address was changed by your team's network
   configuration, use the address your team documented instead.
5. Navigate to the **Manage** or **APKs** page in the Hub's web
   interface.
6. Click **Upload** and select:

   ```text
   TeamCode-debug.apk
   ```

   (the file you located in Section 4).
7. Wait for the upload and installation to finish.  The page will
   show the new APK in the installed list and the previous version
   (if any) marked for removal.
8. Restart the Robot Controller app **only if the Hub prompts you
   to**.  Most recent firmware installs the APK without needing a
   full restart, but exact behaviour varies by firmware version.
9. Confirm the Robot Controller app starts normally.  If it does
   not, see Section 21.

> **The first physical install has not been verified on a hub**
> (see the status note at the top of this guide).  Please report any
> deviation so the team documentation can be updated.

---

## 8. Verify the Run Health page

After installation, open on your laptop:

```text
http://192.168.43.1:8080/runhealth/
```

The page should show eight tabs in this order:

1. Saved Runs
2. Compare
3. Replay
4. Channels
5. Field
6. Live
7. Trend
8. Import CSV

### Before any OpMode runs

The Live tab should show:

- A connection-state dot (grey "No active session" until you start a
  session).
- A `Sequence: 0` counter.
- `Motors: 0 / Channels: 0 / Events: 0`.
- Two buttons: **Pause rendering** and **Clear visible history**.
- Three empty sections: Motors, Pose path, Custom channels.

### Before the first OpMode

The Important things you should verify:

- ✅ The page returns **HTTP 200** (no 404).
- ✅ The page is not blank; it shows the Run Health header and tabs.
- ✅ The browser DevTools **Network** tab shows successful requests
  for the bundled JS files; no `404` for any `*.js`.
- ✅ No Java stack trace appears in the page text.
- ✅ No JavaScript error appears in the **Console** tab.

### Troubleshooting the page

| Symptom | Likely cause | Fix |
|---|---|---|
| **404 Not Found** | Old APK still installed; route not registered; wrong URL. | Re-upload `TeamCode-debug.apk` (Section 7); confirm `/runhealth/` (trailing slash) is part of the URL. |
| **Blank page** | JS bundling failed; the bundled `assets/` folder was not copied. | From `C:\Users\victo\Documents\ftc-run-health\viewer`, run `npm run build`.  This copies the compiled JS into `TeamCode/src/main/assets/runhealth/assets/`, then rebuild the APK. |
| **JS console error** | Old cached page from previous install. | Hard-reload in your browser (`Ctrl+Shift+R` on Windows) or clear the browser cache. |
| **"Live: Disconnected (will retry)" persists** | Polling failing repeatedly. | Open the Hub's Wi-Fi page; confirm the laptop is on the Hub's Wi-Fi, not your home network.  Confirm the URL: port 8080. |
| **Saved Runs empty** | No recording mode ON; recording not yet happened. | See Section 12 — Recording modes. |
| **Tabs missing** | Old build cached; old APK installed. | Hard-reload.  Confirm the APK is the latest from `TeamCode/build/outputs/apk/debug/`. |

---

## 9. Robot configuration requirements

Run Health automatically reads everything it needs from the FTC
`HardwareMap` at session start.

- **Motor discovery is automatic.**  Every `DcMotorEx` device that
  the FTC SDK returns from `hardwareMap.getAll(DcMotorEx.class)` is
  observed.  No manual registration is required.

- **Device names come from your robot configuration.**  Same name as
  you see in the FTC Robot Configuration app.  Names are exact-matched
  when comparing runs.

- **Encoder connection required** for position and velocity data.  If
  a motor has no encoder, position ticks and velocity will read as
  missing (no `0` substitution).

- **Motor current** depends on your hardware and SDK version.  Some
  configurations cannot read current; Run Health shows the field as
  missing rather than as zero.

- **Battery voltage** comes from the Control Hub by default.  If your
  SDK does not expose a battery readout, the battery voltage field
  will display `—`.

- **Renaming a motor** in the robot configuration makes old
  recordings no longer match that motor by name.  Use Run Health's
  per-comparison "missing motor" status to detect this; never
  assume the tool will guess renames.

- **Missing values remain missing.**  Run Health never substitutes
  zero for a missing value.  The browser renders missing numeric
  fields as `—`.

---

## 10. OpMode integration

### Add the import

At the top of your OpMode (wherever your other imports live):

```java
import org.firstinspires.ftc.teamcode.runhealth.logging.RunHealthSession;
```

### `LinearOpMode` example

```java
@TeleOp(name = "TelemetryDemo", group = "RunHealth")
public class TelemetryDemo extends LinearOpMode {

    private RunHealthSession session;

    @Override
    public void runOpMode() {
        session = RunHealthSession.start(
                hardwareMap,
                getClass().getSimpleName()
        );

        try {
            waitForStart();

            while (opModeIsActive()) {
                // ----- your existing robot code goes here -----
                // e.g. drive motors, read sensors, run control loops.

                // Single capture() per ~100 ms is the documented cadence
                // (the session itself throttles to ~10 Hz regardless).
                session.capture();
            }
        } finally {
            session.finish();
        }
    }
}
```

### `IterativeOpMode` example

```java
@TeleOp(name = "TelemetryDemoIterative", group = "RunHealth")
public class TelemetryDemoIterative extends OpMode {

    private RunHealthSession session;

    @Override
    public void init() {
        // init() runs every time the OpMode is selected; recording
        // begins when start() fires.
    }

    @Override
    public void start() {
        session = RunHealthSession.start(
                hardwareMap,
                getClass().getSimpleName()
        );
    }

    @Override
    public void loop() {
        // ----- your existing robot code goes here -----
        session.capture();
    }

    @Override
    public void stop() {
        session.finish();
    }
}
```

### Important behaviour

- `start(hardwareMap, name)` is the minimum-required signature.  An
  overload also accepts a `Map<DcMotorEx, String>` of motor names
  when you want to override the configuration names.
- `capture()` is throttled to **about 10 Hz** (~100 ms minimum
  interval).  You may call it more often; it returns `false` when it
  throttles.
- `capture()` **never throws**.  Any failure is logged and ignored
  so the OpMode loop continues.
- `finish()` is **idempotent**; calling it twice is safe.
- When **Recording mode is OFF**, `start()` returns a no-op session;
  `capture()` does nothing; `finish()` does nothing.  No file is
  created.
- **Live telemetry still works when Recording is OFF.**  The Live
  endpoint is independent of durable recording.
- If no samples were captured (Loop never reached `capture()`, or
  Recording was OFF the entire time), no file is written.

---

## 11. Optional custom telemetry

Run Health has six optional APIs (their signatures match the current
Java sources exactly):

| Method | Purpose |
|---|---|
| `session.put(String name, double value)` | Numeric channel. |
| `session.putBoolean(String name, boolean value)` | Boolean channel. |
| `session.putText(String name, String value)` | Text channel. |
| `session.putPose(String name, double xInches, double yInches, double headingRadians)` | Pose channel — generic field uses inches; heading is in **radians** (counter-clockwise from +X, mathematical convention). |
| `session.mark(String note)` | Event marker — bypasses the 10 Hz throttle. |
| `session.defineChannel(spec)` | Optional metadata declaration (name + group + unit + description); idempotent. |

### Examples

#### Robot pose

```java
// Example using a fictitious pose source; replace with real values.
double x  = pose.getX(DistanceUnit.INCH);
double y  = pose.getY(DistanceUnit.INCH);
double h  = pose.getHeading(AngleUnit.RADIANS);
session.putPose("robot.pose", x, y, h);
```

The generic field conventions:

- Field is **144 in × 144 in** (12 ft × 12 ft).
- Center is `(0, 0)`.
- X and Y both range from `-72` to `+72` inches.
- Heading is in **radians**; counter-clockwise from the +X axis is the
  mathematical convention the renderer draws.

Non-finite values (`NaN`, `Infinity`) are rejected silently — the
previous valid pose remains in place.

#### Loop time

```java
long loopStart = System.nanoTime();
// ... your loop body ...
long loopTimeMs = (System.nanoTime() - loopStart) / 1_000_000L;
session.put("system.loopTimeMs", loopTimeMs);
```

If you do not measure loop time yourself, Run Health still works; the
header just will not show the loop-time channel.

#### PID observations (read-only)

```java
session.put("slide.targetTicks", slideTarget);
session.put("slide.actualTicks", slidePosition);
session.put("slide.errorTicks", slideTarget - slidePosition);
```

These are **observations only**.  Run Health never changes PID values
or constants.

#### Event markers

```java
session.mark("Intake jam noticed");
```

`mark()` writes immediately to the durable recording without waiting
for the next `capture()` tick.  Notes longer than `ChannelsCsv.MAX_NOTE_VALUE`
characters are silently truncated.

### Channel naming, limits, and reserved names

- Names are lower-cased and trimmed before use.
- Maximum channel name length: 64 characters (over-long names are
  rejected).
- Maximum channels per session: **256** (`ChannelRegistry.MAX_CHANNELS`).
- Maximum text-channel value length: 200 characters
  (`ChannelsCsv.MAX_TEXT_VALUE`).
- Maximum event-note length: 200 characters
  (`ChannelsCsv.MAX_NOTE_VALUE`).
- Reserved name: `__event__` is the wire name of every event marker.
- Empty / non-finite values are silently dropped; the previous valid
  sample remains in the browser's view.

---

## 12. Recording modes

Three modes, persisted in `SharedPreferences` (or the in-memory
fallback during JVM tests).

| Mode | Constant string | Effect |
|---|---|---|
| **Off** | `"OFF"` | `start()` returns a no-op session; no file is written. |
| **Record Next Run** | `"NEXT"` | The next `start()` arms a NEXT claim; the NEXT claim is consumed atomically on the **first successful capture()**.  If the OpMode is initialised and stopped before any capture, the NEXT claim is **released** and a later OpMode can claim it. |
| **Record Every Run** | `"EVERY"` | Every `start()` runs recording. |

### Persistence

The recording-mode setting is stored by the FTC Android
`SharedPreferences` of the Robot Controller process.  It:

- ✅ Persists across browser refresh.
- ✅ Persists across Robot Controller app restart.
- ✅ Persists across Control Hub reboot.
- ✅ Can be changed via the `PUT /api/recording` route (the browser's
  Recording controls).

### Live telemetry in each mode

| Mode | Live behaviour |
|---|---|
| Off | If a session is somehow started, Live continues to publish; the active recording-mode field in the snapshot will show `"OFF"`. |
| Next | Live publishes while recording. |
| Every | Live publishes while recording. |

### What happens when no samples are produced

If the OpMode is initialised and stopped (or finishes) without a
single successful `capture()`:

- No file is written to the Saved Runs list.
- The Live snapshot reflects `active=false` after `finish()`.
- Recording-mode behaviour for NEXT: the claim is **released**
  (`armedAndUnconsumed` is still true when we hit `finish()` before
  any `capture()`).

---

## 13. Saved Runs

Each row in **Saved Runs** represents one **logical run**.  A logical
run may consist of multiple physical files:

- A motor CSV (always, when motors were observed).
- A channels CSV (when at least one custom-channel sample was
  captured).
- A manifest JSON (when the channels side is present).

Mechanical facts:

- **Downloads never delete data.**  Browser Downloads just save copies.
- **Recordings remain until manually deleted.**  No automatic rotation
  or retention sweep exists.
- **Deleting a logical run** deletes the motor CSV and any companion
  files owned by it (the channels CSV and the manifest JSON).  No
  unrelated files are touched.
- **If the baseline run is deleted**, the baseline is cleared
  automatically and the browser may surface a notification.
- **The Saved Runs table** shows: opmode name, date & time, duration,
  run ID, file size, schema version (internally), motor count,
  custom-channel count, sample count, build identifier, truncated
  status, baseline status.

### Bulk operations

- **Select rows** with checkboxes.
- **Select all** clears and selects all visible rows.
- **Download selected** fetches each logical run's full set of files
  one at a time through the browser.  If the bundle contains more
  than ~32 MB per file, the browser shows `HTTP 413 - too_large`;
  no archive is auto-generated because the FTC SDK does not bundle a
  portable ZIP writer on Android.
- **Delete selected** sends one DELETE per logical run.

### Truncation

A run is marked `truncated` when its per-motor sample cap
(`MAX_SAMPLES_PER_MOTOR = 5400`) or per-channel sample cap
(`channelSamplesCap = 5400`) is reached.  The CSV file still contains
a footer line that v1 parsers recognise as a truncation marker.

### Legacy motor-only CSV import

Drag any `.csv` file exported from an older motor-only Run Health
build (or a similar format produced by another tool) onto the browser
window.  Run Health parses it client-side; no upload is required.

---

## 14. Replay

The Replay tab operates on saved data only.  It never sends anything
to the robot.

Controls:

- **Play / Pause** — start and stop the replay clock.
- **Restart** — rewind to t=0.
- **Timeline scrubber** — drag to a specific time.
- **Playback speed** — pick from `0.25x`, `0.5x`, `1x`, `2x`, `4x`.
- **Current timestamp** and **Total duration** labels are continuously
  updated.

What plays back synchronously under one replay clock:

- Motor commanded power, position, velocity.
- Battery voltage.
- Numeric channels.
- Boolean channel states (using the **previous** value, not a
  fabricated interpolated value).
- Text channel states (using the previous value).
- Robot pose (using the **previous** value, or limited interpolation
  between numeric pose samples; no interpolation across large gaps).
- Event markers (only the ones up to the current replay time become
  visible).
- Graph cursors and bounced-graph positions.

Rules:

- Numeric channels may be **nearest previous** or briefly
  interpolated.
- State-like channels (boolean, text) **always** use the most-recent
  previous value to avoid fabricating motion.
- The path on the field does **not** extend beyond the current
  replay time.
- Missing values remain missing — never interpolated, never coerced.

---

## 15. Field view

The bundled field is a **generic 12 ft × 12 ft** field, not a
season-specific game field.

| Property | Value |
|---|---|
| Side length | 12 ft × 12 ft = **144 in × 144 in**. |
| Coordinate system | Center at `(0, 0)`. |
| X / Y ranges | Both `-72` to `+72` inches. |
| Tile grid | 24-inch grid lines (every 2 ft). |
| Axes | X-axis labelled on the right; Y-axis labelled at the top. |
| Orientation | +X to the right, +Y up, heading in **radians**, counter-clockwise from +X. |
| Robot marker | Filled disc + heading line. |
| Path | Bounded traveled path of the active pose channel. |
| Targets / vision detections / planned paths | Bounded layer overlay. |
| Event markers | Timestamped lines crossing the field at the marker's time. |
| Zoom / pan / reset / fit to field | Bottom-bar controls. |

The renderer is designed so that a future team-specific generic
background (an SVG of the season field) can be added **without
changing the pose API** — the pose channel values and the field
dimensions are the only contract.

> No season-specific scoring elements (goals, scoring zones) are
> included yet.  Add them only as a separate background layer so they
> do not interfere with the generic pose view.

---

## 16. Comparison and baseline

### Direct comparison (Compare tab)

Choose **Reference Run** and **Comparison Run** from the picker.
The table shows each motor's median velocity, velocity efficiency,
current cost, 95th-percentile current, possible stall percentage, and
comparable sample count, plus a status:

- `Stable` — no significant change.
- `Changed` — visible change.
- `Large Change` — large change.
- `Missing` — motor present in only one run.
- `Insufficient Data` — too few samples in either run.
- `Incompatible Data` — different motor kinds or units.

Motor matching is **by exact device name**.  If you renamed a motor
in your robot configuration, it shows up as Missing in cross-run
comparison.

Direct comparison is **temporary**; it does not change the persistent
baseline.

### Baseline comparison

The baseline is a **specific run id** you set as a reference for
long-term comparison.

Actions:

- **Set as Baseline** on a row in Saved Runs.
- **Change Baseline** by setting it on a different run.
- **Clear Baseline** from the Comparison tab or by deleting the
  baseline run.

Rules:

- The baseline is **never** selected automatically.
- If the baseline run is deleted, the baseline is cleared and the
  browser remains in a safe state.
- The baseline can be a *legacy* or *unified* run; the comparison
  layer normalises both formats.

### Missing-data handling

- A motor present in only one run is marked **Missing** in the other
  row.
- **Missing motors are never substituted with zero.**
- **Missing motors are not classified as "deteriorated".**
- Percentage change is suppressed whenever the reference value is
  zero, missing, or non-finite.

---

## 17. Trends

The Trend tab supports:

- **Median motor velocity**.
- **Velocity efficiency** (velocity / commanded-power).
- **Current cost** (mean commanded power × mean current).
- **95th-percentile current**.
- **Possible Stall Percentage**.
- **Battery minimum** and **battery median**.
- **Loop-time median** and **loop-time 95th percentile**.
- **Selected numeric custom channels**: median / min / max / final.

For each chronological point, the table shows:

- Run date.
- Build identifier (when present).
- Difference from baseline (when a baseline is set).
- Difference from previous run.
- Missing points are rendered as a **gap**, never as `0`.
- Insufficient samples render the metric as **unavailable**.

Trend tab source-mode picker (Motor vs. Custom Channel) lives at the
top of the section.  Numeric-channel trend modes: **median**,
**minimum**, **maximum**, **final value**.

When a channel's unit changes across runs, mismatched runs are
excluded from that trend with an `Incompatible Units` note.

---

## 18. Live telemetry

### Endpoint

```text
GET /runhealth/api/live/snapshot
```

(On the Hub: `http://192.168.43.1:8080/runhealth/api/live/snapshot`.)

The endpoint is **GET only**; `POST`, `PUT`, `DELETE` return 405.

### Polling

| Setting | Value |
|---|---|
| Default polling interval | **250 ms**. |
| Backoff progression | `250 → 500 → 1000 → 2000 → 4000 → 5000` ms; clamped at **5 s**. |
| Hidden-page slowdown | Multiply wait by **5** when `document.visibilityState === 'hidden'`. |
| Connection-state indicator | Green / amber / red dot in the Live tab header. |
| Sequence numbers | Monotonically increasing; out-of-order snapshots are dropped. |
| Abort on stop | `AbortController.cancel()` is called when the tab switches or polling restarts. |

### Browser-side limits

| Limit | Value |
|---|---|
| `MAX_HISTORY_MS` | 60 000 ms (rolling window). |
| `MAX_MOTOR_SERIES` | 8 (per snapshot, per Live tab). |
| `MAX_CHANNEL_SERIES_PER_KIND` | 24. |
| `MAX_PATH_POINTS` | 600. |
| `MAX_EVENTS` | 200. |
| `MAX_POINTS_PER_GRAPH` | 600 (per graph before downsampling). |

When a limit is reached, the **oldest** data is dropped and the
**current** value is always retained.

### Robot-side limits

| Limit | Value |
|---|---|
| Publish rate | At most **10 Hz**, paced by the `capture()` throttle (`MIN_CAPTURE_INTERVAL_MS = 100`). |
| Concurrent publishers | One — `RunHealthSession.capture()` is the only publisher. |
| Reachable `LiveSnapshot` objects | At most **one** between writes. |
| Thread per channel | None; no background services are started. |
| File I/O on the live path | None; reading motor current uses a per-call reflection fallback when `CurrentUnit` is unavailable at compile time. |

### Snapshot schema (abridged)

```jsonc
{
  "schema_version": 1,
  "active": true,
  "session_id": "<uuid>",
  "op_mode": "TeleOp",
  "recording_mode": "EVERY",
  "sequence": 1234,
  "timestamp_ms": 1700000000000,
  "elapsed_ms": 12345,
  "battery_voltage": 12.47,
  "loop_time_ms": 16.0,
  "motors":    [ { "device_name": "frontLeft", "power": 0.65,
                    "position_ticks": 12450,
                    "velocity_ticks_per_second": 1320,
                    "current_amps": 2.1,
                    "mode": "RUN_USING_ENCODER" } ],
  "channels":  [ { "name": "robot.headingDegrees", "kind": "number",
                    "value_number": 91.4, "unit": "degrees",
                    "group": "Drive" } ],
  "events":    [ { "timestamp_ms": 1700000000123,
                    "label": "Intake jam noticed" } ]
}
```

Missing values are emitted as JSON `null`; the browser treats `null`
as missing and never as `0`.

### Recording independence

- Closing the Live tab does **not** stop durable recording.
- Closing all browser tabs does **not** stop durable recording.
- Recording continues independently at the documented 10 Hz pace.
- The browser holds its own bounded buffers; clearing visible
  history only resets the browser-side store.

### "No active session" response

When no Run Health session has run on the Hub yet, the endpoint
returns:

```json
{
  "schema_version": 1,
  "active": false,
  "session_id": null,
  "op_mode": null,
  "recording_mode": null,
  "sequence": 0,
  "timestamp_ms": <wall_clock>,
  "elapsed_ms": 0,
  "battery_voltage": null,
  "loop_time_ms": null,
  "motors": [],
  "channels": [],
  "events": [],
  "no_active_session": true
}
```

---

## 19. First physical test procedure

Use the safest progression.

### Test 1 — Page only

- [ ] Control Hub powered safely
- [ ] Laptop connected to Control Hub Wi-Fi
- [ ] `TeamCode-debug.apk` installed on the Hub
- [ ] Opened `http://192.168.43.1:8080/runhealth/`
- [ ] Page loads with all eight tabs visible
- [ ] Live tab: connection-state dot grey, "No active session"
- [ ] No 404, no Java stack trace, no JavaScript console error

### Test 2 — One secured motor

- [ ] Motor secured so it cannot move
- [ ] Wheels off the ground
- [ ] Verified motor name in the Robot Configuration matches your
  expectation (e.g. `frontLeft`)
- [ ] Wrote a minimal test OpMode that commands low power briefly
- [ ] OpMode started; Live tab turned green ("Connected")
- [ ] Live tab shows motor power, velocity, position, mode, and
  battery voltage
- [ ] OpMode stopped; Live tab returned to inactive state
- [ ] Confirmed the **browser** could not command power: only the
  Driver Station and the OpMode code can.

### Test 3 — Save one run

- [ ] Set Recording mode to **Record Next Run** in the browser
- [ ] Ran the test OpMode
- [ ] Stopped it normally
- [ ] Opened **Saved Runs**; exactly one new run is listed
- [ ] Opened **graphs** for that run; saw power, position, velocity,
  battery voltage
- [ ] Opened **Replay**; pressed Play; scrubbed; verified pause/restart
- [ ] Opened **Channels** if any custom channels were published
- [ ] Opened **Field** if pose data was published
- [ ] Clicked **Download**; new file appeared in the browser's
  downloads folder
- [ ] Confirmed the run is **still** in Saved Runs (download did not
  delete it)

### Test 4 — Baseline comparison

- [ ] Clicked **Set as Baseline** on the recorded run
- [ ] Recorded a second, slightly-different run
- [ ] Opened **Compare**; selected both
- [ ] Verified motor statuses (Stable / Changed / Large Change /
  Missing / Insufficient / Incompatible)
- [ ] Cleared the baseline; verified it was no longer set

---

## 20. Full-robot rollout plan

After the one-motor test passes, do these in order:

1. Add four drive motors to the robot control OpMode.
2. Test TeleOp with all four motors.
3. Test Autonomous with all four motors.
4. Add custom pose (`session.putPose("robot.pose", x, y, h)`).
5. Add loop-time observation (`session.put("system.loopTimeMs", ms)`).
6. Add mechanism telemetry (target / actual / error channels).
7. Record a known-good baseline (set the strongest healthy run as
   the baseline).
8. Test browser disconnection.  Live should reconnect quickly; the
   recording continues; downloads / replays still work.
9. Test long recordings.  Confirm truncation warnings appear when
   the caps are reached, and the file's footer is preserved.
10. Test coexistence with your existing tools (FTC Dashboard, Panels,
    Road Runner, Pedro Pathing, NextFTC, Limelight).  Run Health does
    not bind any port that Dashboard / Panels use, but verify on
    hardware, not by assumption.

> ⚠️ **Compatibility must be tested, not assumed.**  This guide
> documents Run Health's own guarantees; it does **not** verify
> every combination of telemetry libraries on a hub.

---

## 21. Troubleshooting

### APK cannot be found

| Check | Fix |
|---|---|
| Did `assembleDebug` complete with `BUILD SUCCESSFUL`? | Rebuild; see Section 6. |
| Look in `TeamCode/build/outputs/apk/debug/`. | If empty, the build did not produce an APK. |
| Old APK was deleted by `clean` and never rebuilt. | Run `assembleDebug` again. |

### Gradle build fails

| Symptom | Likely cause | Fix |
|---|---|---|
| `error: cannot find symbol` | Java source mismatch. | Run `git status` to check for stray modifications; restore from git if needed. |
| `error: package org.firstinspires.ftc.teamcode.runhealth does not exist` | The `runhealth` package was not copied into the receiving team project (Section 5). | Copy the package directory. |
| `Unsupported Java version` warnings | Your JDK is older than 11. | Install a newer JDK. |

### npm / Node commands not found

```powershell
node --version
```

If this errors, install Node.js 18+ from `https://nodejs.org`.  Restart
PowerShell after installing.

### Viewer tests fail

| Check | Fix |
|---|---|
| Did you run `npm install` first? | Run it; then `npm test`. |
| Any `RuntimeError` on a test? | The test is exercising `AbortController` mock; ensure your Node version supports it (16+). |

### Page returns 404

- Confirm the URL ends with `/runhealth/`.
- Confirm the APK is the latest build.
- Hard-reload the browser (`Ctrl+Shift+R`).

### Page is blank

- Open DevTools → Network.  If `*.js` files return 404, the bundled
  assets were not built into the APK.  Run `npm run build` then
  `assembleDebug` and re-install.

### Live tab says "Disconnected (will retry)"

- Confirm the laptop's Wi-Fi is the Hub's Wi-Fi, not your home
  network.
- Confirm the URL port `8080`.
- Confirm the APK is installed.
- Open `/runhealth/` directly; if the page itself loads, the live
  endpoint must be reachable too.

### Live tab says "No active session" during an OpMode

- The `capture()` call must be reached.
- The session must not be a no-op (Recording must be ON **or** you
  must be starting a session via the explicit `start()` form).
- Confirm `start()` ran: add a `RobotLog.ii("example", "session started")`
  immediately after `start()` and watch Driver Station logs.

### No motors appear in Live / Saved Runs

- The robot configuration must contain motors that the FTC SDK
  exposes as `DcMotorEx`.  Check the Robot Configuration app.
- The hardware map at start time must include them.  Check the
  Driver Station log for warnings.

### Position and velocity remain zero

- Encoder cable not connected.
- Encoder-mode not enabled on the motor.
- The motor's encoder is broken.

### Current is unavailable

- Some FTC SDK builds / hardware do not expose motor current.
- Run Health will display `—`.  No software change fixes this on
  the side of the tool; the device itself must be queried.

### Battery voltage is unavailable

- The Hub may not expose a battery-voltage API on every firmware
  release.  Run Health will display `—`.  No software change fixes
  this from the tool side.

### Run did not save

- Did you actually call `capture()` at least once?  Add a logging
  statement and re-run.
- Was Recording mode OFF the entire session?  OFF sessions never
  write files.

### "Record Next Run" stayed set after a run

- The OpMode was initialised and cancelled before reaching the first
  successful `capture()`.  In that case the NEXT claim is **released**
  per the documented contract.  Set Recording mode again, then run.

### Saved run is truncated

- The motor sample cap (`MAX_SAMPLES_PER_MOTOR=5400`) or the channel
  cap (`channelSamplesCap=5400`) was reached.  At 10 Hz capture
  this corresponds to **~9 minutes** of motor samples.  Run shorter
  test runs, or split long sessions.

### Comparison says motor missing

- The two runs use different motor names.  Check the Robot
  Configuration app to see what changed.

### Pose is outside the field

- The pose X / Y is greater than ±72 in from the configured origin.
  Re-check the pose source.

### Replay path does not move

- No pose channel was published for that run.
- Or the field view is not the active tab.  Open Field next to
  Replay.

### Download is incomplete

- One file in the bundle exceeded `MAX_INLINED_BYTES` (32 MB)
  and was reported as `HTTP 413 - too_large`.  Either re-record
  with shorter duration, or download the file directly through the
  Hub's file-manager.

### Delete fails

- The Deletion API returned `404 not_found`; the run was already
  deleted.  Refresh Saved Runs.

### Browser becomes slow

- The polling cadence slowed (backoff) due to too many failures.
  See the History caps in Section 18.  Stopping the Live tab clears
  counters.

### Control Hub Wi-Fi disconnects

- Reconnect.  Polling resumes when visible, with 5× backoff.

### Robot loop becomes slower

- The reflection-based current-amp helper is invoked per motor
  per tick.  10 Hz × 8 motors.  If your setup uses more, profile.
- Custom reflection or other expensive code in your OpMode will
  dominate.  Run Health itself is bounded.

### Third-party dashboard conflict

- FTC Dashboard uses `:8080/dash`.  Run Health uses
  `:8080/runhealth/`.  No port conflict.
- Panels uses `:8001`.  Run Health does **not** bind `:8001`.  No
  port conflict.
- If a tool reads `/api/recording`, `/api/baseline`, or
  `/api/runs/<id>`, it shares the endpoint with Run Health; the read
  routes are safe.

---

## 22. Software verification commands

From PowerShell, in the repository root:

```powershell
cd $HOME\Documents\ftc-run-health\viewer
npm test
npm run build

cd $HOME\Documents\ftc-run-health
.\gradlew.bat :TeamCode:testDebugUnitTest --no-build-cache --no-daemon
.\gradlew.bat clean :TeamCode:assembleDebug --no-build-cache --rerun-tasks
```

Expected **current** totals (verify against the latest run; the Java
suite can grow when new tests are added):

| Verification | Expected outcome (latest) |
|---|---|
| `npm test` (viewer) | 156 passed (156). |
| `npm run build` | `tsc -p tsconfig.json` clean; `node ./scripts/copy-assets.mjs` copies into `TeamCode/src/main/assets/runhealth/assets`. |
| `:TeamCode:testDebugUnitTest` | `BUILD SUCCESSFUL` with 0 failures; 10 Android-runtime tests skipped. |
| `clean :TeamCode:assembleDebug` | `BUILD SUCCESSFUL`; APK at `TeamCode/build/outputs/apk/debug/TeamCode-debug.apk`. |

> Do not hard-code these numbers in scripts.  They reflect the
> latest software state at the time of writing.  Treat them as a
> regression baseline.

---

## 23. Completion checklists

### Software ready (run before physical testing)

- [ ] Viewer tests (`npm test`) pass
- [ ] Java unit tests (`./gradlew.bat :TeamCode:testDebugUnitTest`) pass
- [ ] Clean APK build (`./gradlew.bat clean :TeamCode:assembleDebug`) passes
- [ ] APK exists at `TeamCode/build/outputs/apk/debug/TeamCode-debug.apk`
- [ ] No `viewer/node_modules/` files are staged in git
- [ ] `docs/LIVE_VIEW.md`, `docs/ARCHITECTURE.md`, `docs/COMPLETE_SETUP_GUIDE.md` reviewed

### Control Hub ready (run on hardware before team rollout)

- [ ] APK installed on the Control Hub
- [ ] `/runhealth/` page opens at `http://192.168.43.1:8080/runhealth/`
- [ ] Live tab responds with a structured inactive snapshot when no
      OpMode is running
- [ ] Live tab responds with a live snapshot during a running
      OpMode (motor values populate, sequence counter increments)
- [ ] One-secured-motor test passes (Section 19 Test 2)

### Team rollout ready (full robot)

- [ ] Full-robot OpMode tested with all drive motors + selected
      mechanism motors
- [ ] One known-good run set as the persistent baseline
- [ ] Downloading a saved run produces every companion file (motor
      CSV, channels CSV, manifest JSON where applicable) without
      deleting the stored run
- [ ] Trend tab renders chronological points with baseline and
      previous-run deltas
- [ ] Live tab continues to update after closing & opening the
      browser tab; polling rate adapts to page visibility
- [ ] A 5+ minute recording completes without crashing the OpMode;
      truncation warning is visible if caps are reached
- [ ] Third-party tools still work (FTC Dashboard at `:8080/dash`,
      Panels at `:8001`, Road Runner / Pedro Pathing / NextFTC /
      Limelight telemetry as your team uses them)
- [ ] Comparison + baseline + trend workflows match the documented
      statuses (Stable / Changed / Large Change / Missing /
      Insufficient / Incompatible)

---

## Honest limits of this guide

- **No physical Control Hub verification has been performed yet.**
  All software described here is verified green on a Windows JVM;
  routes and the bundled viewer work locally.  Final acceptance must
  include the Section 19 tests on a real Control Hub.
- **No claim of compatibility with FTC Dashboard, Panels, Road
  Runner, Pedro Pathing, NextFTC, or Limelight is made by this
  guide.**  They are tested on your hub, not by us.
- **No part of this guide claims that the tool starts or stops
  OpModes**, controls motors or servos, injects gamepad commands,
  tunes PID, edits constants, or modifies robot configuration.
  Run Health is read-only with respect to robot behaviour.  If you
  observe any such behaviour, **stop using the tool** and report
  it.
