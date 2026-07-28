# FTC Run Health — Metric Definitions

All metrics are **pure** TypeScript functions in `viewer/src/metrics.ts`
with full unit-test coverage in `viewer/tests/metrics.test.ts`.

## Thresholds (centralized)

Configurable per comparison in `StatusThresholds` (`viewer/src/types.ts`).
The shipped defaults are:

```
changedPct           = 5      // │Δ│% above which a row gets "Changed"
largeChangePct       = 15     // │Δ│% above which a row gets "Large Change"
minSamples           = 20     // minimum comparable samples per run
currentCostMinV      = 50 tps // velocity floor for current-cost metric
stallPowerThreshold  = 0.20   // |commanded_power| above which stall can trigger
stallVelocityThreshold = 50   // |encoder_velocity| below which stall can trigger
```

## Power bands

| Band | |commanded_power| range |
|------|----------------------|
| Low  | `[0.15, 0.35)` |
| Medium | `[0.35, 0.65)` |
| High  | `[0.65, 1.00]` |
| All active bands | `≥ 0.15` (Low + Medium + High combined) |

Samples with `|commanded_power| < 0.15` are excluded from active-motion
metrics — they may be an idle frame.

## Metric A — Median absolute velocity

```
med = median(|encoder_velocity|)
```

Sample conditions: filter (direction + power band) must pass; encoder
velocity must be finite.

Returns null if fewer than `minSamples` qualifying samples exist on a
side.

## Metric B — Velocity per effective command

```
effective_command = |commanded_power| × battery_voltage / 12
velocity_efficiency = |encoder_velocity| / effective_command
```

Sample conditions: voltage must be **finite and positive**; |commanded
power| > 0; effective command > 0.

## Metric C — Current per movement

```
current_cost = current_amps / |encoder_velocity| × 1000
```

Units: amps per 1,000 ticks/second.  Samples with `|encoder_velocity|
< currentCostMinVelocityTps` are excluded to avoid divide-by-near-zero
spikes.

## Metric D — 95th-percentile current

Linear-interpolation percentile over valid current samples (0.95 by
default).  Tested via the percentile helper which uses the
documented `(n-1)·p` index algorithm.

## Metric E — Possible stall percentage

A sample is counted as a **possible stall** if BOTH:

* `|commanded_power| > stallPowerThreshold`
* `|encoder_velocity| < stallVelocityThresholdTps`

Returned value: `count(ed)/count(active) × 100`, where `active` is
the count of qualifying samples with `|commanded_power|` above the
power threshold.

> **Important**: the metric never claims a confirmed stall.  Holding
> mechanisms (e.g., an arm keeping position against gravity) can
> produce false positives at exactly the commanded-power × stalled-
> encoder point.  The label is **"Possible Stall Percentage"**.

## Metric F — Comparable sample count

Always returned alongside every other metric.  Helps the team see
where the comparison might not be statistically meaningful.

## Metric G — Active duration

Sum of inter-sample `Δt` excluding pauses (gaps > 1 second).
Expressed in milliseconds.

## Percentage-change rules

```
%Δ = (comparison − reference) / |reference| × 100
```

If `reference` is `0`, `null`, or non-finite, `%Δ` is **unavailable**
and the absolute difference is surfaced instead.  Run Health *never*
divides by zero.

## Status classification (per metric)

| |Δ%| | Status |
|------|--------|
| `< changedPct (5%)` | Stable |
| `≥ changedPct (5%)`, `< largeChangePct (15%)` | Changed |
| `≥ largeChangePct (15%)` | Large Change |
| missing / null / `reference = 0` | Insufficient Data |

For the whole-robot summary the **worst per-motor metric status**
propagates — so a 15% change in any single metric flags the motor as
"Large Change" globally.
