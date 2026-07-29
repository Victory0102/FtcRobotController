# FTC Run Health — Live View

The Live tab is a **read-only** browser dashboard that shows the
most-recent sampled state of an actively running OpMode.  It does not
influence the robot.

## Endpoint

```
GET /api/live/snapshot     (Run Health route prefix: /runhealth/api/live/snapshot)
```

The endpoint accepts **GET only**.  `POST`, `PUT`, and `DELETE` all
return HTTP 405.  The response is `application/json; charset=utf-8`
and a single JSON object.

## Snapshot schema

```jsonc
{
  "schema_version": 1,
  "active": true,                 // false once finish() has run
  "session_id": "<uuid>",         // null if no active session
  "op_mode": "TeleOp",
  "recording_mode": "EVERY",
  "sequence": 1234,               // monotonic per-Registry counter
  "timestamp_ms": 1700000000000,  // wall-clock
  "elapsed_ms": 12345,            // session runClock
  "battery_voltage": 12.47,       // null when not available
  "loop_time_ms": 16.0,           // null when not supplied
  "motors": [
    {
      "device_name": "frontLeft",
      "power": 0.65,
      "position_ticks": 12450,
      "velocity_ticks_per_second": 1320,
      "current_amps": 2.1,
      "mode": "RUN_USING_ENCODER"
    }
  ],
  "channels": [
    {
      "name": "robot.headingDegrees",
      "kind": "number",
      "value_number": 91.4,
      "value_boolean": null,
      "value_text": null,
      "pose_x": null,
      "pose_y": null,
      "pose_heading": null,
      "unit": "degrees",
      "group": "Drive",
      "description": "Robot heading degrees"
    }
  ],
  "events": [
    { "timestamp_ms": 1700000000123, "label": "Intake jam noticed" }
  ],
  "no_active_session": false      // only present when no session has run
}
```

### Field semantics

- Numeric values that cannot be read are emitted as JSON `null` —
  the browser must treat them as **missing**, **never as 0**.
- `motors`, `channels`, and `events` are arrays; missing values mean
  empty arrays (`[]`).
- `no_active_session: true` is set only when nothing has been published
  yet AND nothing is currently active.

## Polling

The viewer polls the endpoint at 250 ms by default.  The exact
backoff curve:

```
250 ms   (success)
500 ms   (after 1st failure)
1000 ms  (after 2nd failure)
2000 ms  (after 3rd failure)
4000 ms  (after 4th failure)
5000 ms  (clamp, stays here until success)
```

When `document.visibilityState === 'hidden'` the wait is multiplied
by 5, so polling slows to 1.25 s when the tab is not in the
foreground.  In-flight requests are aborted via `AbortController`
before the next tick — overlapping requests are impossible.

## Browser-side limits

| Buffer                   | Cap                                |
|--------------------------|------------------------------------|
| History window           | 60 s (rolling)                     |
| Tracked motors           | 8                                  |
| Tracked channels per tick| 24                                 |
| Pose path points         | 600                                |
| Event markers            | 200                                |
| Points per graph         | 600                                |

Older data is dropped; the current value is always retained.

## Robot-side limits

| Limit                  | Value                           |
|------------------------|---------------------------------|
| Publish rate           | \u2264 10 Hz (matches capture()) |
| Concurrent publishers  | zero (\u00b7 synchronized)        |
| Concurrent readers     | any number (lock-free)          |
| Reachable LiveSnapshots| at most one (volatile immutable) |
| Thread per channel     | none                            |

## Session lifecycle

- `RunHealthSession.start(...)` does **not** publish yet.
- A live snapshot is published **only inside the synchronized block
  of `capture()`** — once per accepted tick.  A no-op session (mode
  OFF) never publishes.
- `finish()` calls `LiveSnapshotRegistry.markInactive()` which sets
  `active=false` while preserving the last field values.
- The browser tab seeing `active=false` is the canonical signal that
  the OpMode has ended.

## Recording independence

- Recording mode is reported in the snapshot as the
  `recording_mode` field; the Live view does not require Recording
  to be ON.  Set Recording OFF and the Live tab still works if a
  session is running.
- Closing or navigating away from the Live tab does not stop
  recording; `RunHealthSession.capture()` continues to write to
  durable files regardless of whether any browser is connected.
- The browser holds its own bounded buffers.  Resetting the visible
  history ("Clear visible history" button) only affects the
  browser-side store — the robot-side registry is untouched.

## No robot control

The Live endpoint is **GET only** by construction:

- No body is ever parsed on the live path.
- No setter on any hardware is reachable from this route.
- Stack traces are never returned; errors are surfaced as
  `{"error":"Live snapshot failure","code":"internal_error",...}`.

## Tests on a Control Hub

See `docs/CONTROL_HUB_TEST_PLAN.md` for the physical-verification
checklist.
