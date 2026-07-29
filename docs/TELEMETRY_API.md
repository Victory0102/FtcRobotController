# FTC Run Health — Telemetry API

The pure-Java telemetry API exposed by `RunHealthApi` is intentionally
small and dependency-free (no Robolectric, no third-party JSON
library).  All routes are JSON in / JSON out.  Stack traces are
never returned.

## Routes

* `GET    /api/recording`     current recording mode.
* `PUT    /api/recording`     sets mode; body `{"mode":"OFF|NEXT|EVERY"}`.
* `GET    /api/baseline`      current baseline run id (or null).
* `PUT    /api/baseline`      sets baseline; body `{"run_id":"<id>"}`.
* `DELETE /api/baseline`      clears baseline.
* `GET    /api/runs`          list of saved runs.
* `POST   /api/runs/download-selected`
* `POST   /api/runs/delete-selected`
* `GET    /api/runs/<id>`                 raw motor CSV.
* `GET    /api/runs/<id>/download`        motor CSV as attachment.
* `DELETE /api/runs/<id>/delete`          atomic delete.
* `GET    /api/runs/<id>/manifest`        companion manifest JSON.
* `GET    /api/runs/<id>/channels`        companion channels CSV.
* `GET    /api/live/snapshot`             bounded live snapshot (**GET only**).

## Live endpoint

`GET /api/live/snapshot` returns the immutable read-only
`LiveSnapshot` produced by `RunHealthSession.capture()`.  See
`LIVE_VIEW.md` for the schema, polling cadence, backoff curve,
browser-side and robot-side limits.
