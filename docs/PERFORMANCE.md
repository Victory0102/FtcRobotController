# FTC Run Health — Performance

## Recording buffers (Robot)

| Buffer                     | Cap                          |
|----------------------------|------------------------------|
| Sample throttle            | 100 ms (10 Hz)               |
| Samples per motor          | 5400                         |
| Committed channel samples  | 5400                         |
| Reachable LiveSnapshots    | at most one (volatile)       |

Reaching a cap sets the run's `truncated=true` flag and continues
the OpMode loop unaffected.

## Live side (Browser)

| Buffer                  | Cap       |
|-------------------------|-----------|
| History window          | 60 s      |
| Tracked motors          | 8         |
| Tracked channels/tick   | 24        |
| Pose path points        | 600       |
| Event markers           | 200       |
| Points per graph        | 600       |

Polling cadence: 250 ms default, 500/1000/2000/4000/5000 ms
backoff after consecutive failures, 5x slower when
`document.visibilityState === 'hidden'`.

## Response body cap

`MAX_INLINED_BYTES = 32 * 1024 * 1024` per response.  Bodies larger
than this return HTTP 413 ("too_large") with a structured error.
