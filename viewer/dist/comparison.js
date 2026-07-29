/**
 * Comparison logic for FTC Run Health. Walks both runs, matches motors
 * by exact device name, and produces a {@link MotorComparisonSummary}
 * per matching (or non-matching) motor.
 */
import { classifyChange, currentPerMovement, filterSamples, medianAbsoluteVelocity, p95Current, percentChange, possibleStallPercentage, velocityPerEffectiveCommand, } from './metrics.js';
import { DEFAULT_THRESHOLDS, } from './types.js';
/**
 * Produce a whole-robot comparison table.  Every motor found in either
 * run is included.
 */
export function wholeRobotComparison(input) {
    const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
    const devices = new Set([
        ...input.reference.deviceNames,
        ...input.comparison.deviceNames,
    ]);
    const sortedDevices = Array.from(devices).sort();
    const rows = [];
    for (const device of sortedDevices) {
        const ref = perMotorMetrics(device, input.reference, input.filter, thresholds);
        const cmp = perMotorMetrics(device, input.comparison, input.filter, thresholds);
        const medianVelocityChange = percentChange(ref.medianVelocity, cmp.medianVelocity);
        const velEffChange = percentChange(ref.velocityEfficiency, cmp.velocityEfficiency);
        const currentCostChange = percentChange(ref.currentCost, cmp.currentCost);
        const p95Change = percentChange(ref.p95Current, cmp.p95Current);
        const stallChange = percentChange(ref.possibleStallPct, cmp.possibleStallPct);
        // Raw-unit (absolute) differences for the same five metrics.  These
        // are independent of the percent-change so the team can see both the
        // magnitude and the relative change.  Null whenever either side of
        // the comparison is missing or non-finite - we never coerce to zero.
        const absDiffMedianVelocity = safeDiff(ref.medianVelocity, cmp.medianVelocity);
        const absDiffVelocityEfficiency = safeDiff(ref.velocityEfficiency, cmp.velocityEfficiency);
        const absDiffCurrentCost = safeDiff(ref.currentCost, cmp.currentCost);
        const absDiffP95Current = safeDiff(ref.p95Current, cmp.p95Current);
        const absDiffStallPct = safeDiff(ref.possibleStallPct, cmp.possibleStallPct);
        // Per-run availability of current and voltage so the UI can render
        // "Current: yes/no" without having to re-scan the run's samples.
        const hasCurrentRef = !ref.present ? false : ref.hasCurrent;
        const hasCurrentCmp = !cmp.present ? false : cmp.hasCurrent;
        const hasVoltageRef = !ref.present ? false : ref.hasVoltage;
        const hasVoltageCmp = !cmp.present ? false : cmp.hasVoltage;
        // Granular presence status.  The user stories distinguish "missing
        // from ref" and "missing from cmp" rather than collapsing both into
        // a single label.
        let presenceStatus;
        if (ref.present && cmp.present)
            presenceStatus = 'In Both';
        else if (!ref.present && !cmp.present)
            presenceStatus = 'Missing in Both';
        else if (!ref.present)
            presenceStatus = 'Missing in Reference';
        else
            presenceStatus = 'Missing in Comparison';
        // Status: Insufficient if either side lacks enough data.
        const bothMissing = !ref.present && !cmp.present;
        const insufficient = ref.n < thresholds.minSamples || cmp.n < thresholds.minSamples;
        let status;
        if (bothMissing) {
            status = 'Missing';
        }
        else if (!ref.present || !cmp.present) {
            status = 'Missing';
        }
        else if (ref.motorModeMismatch || cmp.motorModeMismatch) {
            status = 'Incompatible Data';
        }
        else if (insufficient) {
            status = 'Insufficient Data';
        }
        else {
            const worst = worstClassification([
                classifyChange(medianVelocityChange.value, medianVelocityChange.available, thresholds),
                classifyChange(velEffChange.value, velEffChange.available, thresholds),
                classifyChange(currentCostChange.value, currentCostChange.available, thresholds),
                classifyChange(p95Change.value, p95Change.available, thresholds),
                classifyChange(stallChange.value, stallChange.available, thresholds),
            ]);
            status = worst;
        }
        rows.push({
            deviceName: device,
            presentInReference: ref.present,
            presentInComparison: cmp.present,
            // Populate absolute values so the UI can render ref/cmp columns
            // without re-running perMotorMetrics a second time.
            refMedianVelocity: ref.medianVelocity,
            cmpMedianVelocity: cmp.medianVelocity,
            refVelocityEfficiency: ref.velocityEfficiency,
            cmpVelocityEfficiency: cmp.velocityEfficiency,
            refCurrentCost: ref.currentCost,
            cmpCurrentCost: cmp.currentCost,
            refP95Current: ref.p95Current,
            cmpP95Current: cmp.p95Current,
            refStallPct: ref.possibleStallPct,
            cmpStallPct: cmp.possibleStallPct,
            absDiffMedianVelocity,
            absDiffVelocityEfficiency,
            absDiffCurrentCost,
            absDiffP95Current,
            absDiffStallPct,
            medianVelocityChangePct: medianVelocityChange.value,
            velocityEfficiencyChangePct: velEffChange.value,
            currentCostChangePct: currentCostChange.value,
            p95CurrentChangePct: p95Change.value,
            possibleStallChangePct: stallChange.value,
            comparableSampleCountA: ref.n,
            comparableSampleCountB: cmp.n,
            hasCurrentRef,
            hasCurrentCmp,
            hasVoltageRef,
            hasVoltageCmp,
            motorModeMismatch: ref.motorModeMismatch || cmp.motorModeMismatch,
            presenceStatus,
            status,
        });
    }
    return {
        rows,
        reference: input.reference,
        comparison: input.comparison,
        filter: input.filter,
        thresholds,
    };
}
function worstClassification(labels) {
    // Custom order: Large Change > Changed > Insufficient Data > Stable > Missing > Incompatible Data.
    // We place Insufficient Data BEFORE Stable so that we never downplay a
    // metric that could not be computed just because another metric happened
    // to come out small. Combined with the early-return checks for sample
    // counts and incompatible modes, this represents the most conservative
    // reading of the comparison.
    const order = [
        'Large Change', 'Changed', 'Insufficient Data', 'Stable', 'Missing', 'Incompatible Data',
    ];
    let best = order.length - 1;
    for (const label of labels) {
        const i = order.indexOf(label);
        if (i >= 0 && i < best)
            best = i;
    }
    return order[best];
}
function safeDiff(a, b) {
    if (a === null || b === null)
        return null;
    if (!Number.isFinite(a) || !Number.isFinite(b))
        return null;
    return b - a;
}
function perMotorMetrics(device, run, filter, thresholds) {
    if (!run.deviceNames.includes(device)) {
        return {
            present: false,
            motorModeMismatch: false,
            medianVelocity: null,
            velocityEfficiency: null,
            currentCost: null,
            p95Current: null,
            possibleStallPct: null,
            n: 0,
            hasCurrent: false,
            hasVoltage: false,
        };
    }
    const { matching, motorModeMismatch } = filterSamples(run.samples, device, filter, null);
    const a = medianAbsoluteVelocity(matching, thresholds.minSamples);
    const b = velocityPerEffectiveCommand(matching, thresholds.minSamples);
    const c = currentPerMovement(matching, thresholds.currentCostMinVelocityTps, thresholds.minSamples);
    const d = p95Current(matching, thresholds.minSamples);
    const e = possibleStallPercentage(matching, thresholds, thresholds.minSamples);
    // Per-run presence flags are computed by a single linear scan of the
    // matching slice - cheaper than re-filtering and safer than relying on
    // the metric outputs (which may be null under insufficient-sample rules).
    let hasCurrent = false;
    let hasVoltage = false;
    for (const s of matching) {
        if (!hasCurrent && s.currentAmps !== null && Number.isFinite(s.currentAmps)) {
            hasCurrent = true;
        }
        if (!hasVoltage && s.batteryVoltage !== null && s.batteryVoltage > 0) {
            hasVoltage = true;
        }
        if (hasCurrent && hasVoltage)
            break;
    }
    return {
        present: true,
        motorModeMismatch,
        medianVelocity: a.value,
        velocityEfficiency: b.value,
        currentCost: c.value,
        p95Current: d.value,
        possibleStallPct: e.value,
        n: a.n,
        hasCurrent,
        hasVoltage,
    };
}
export function perMotorTrend(runs, device, filter, thresholds = DEFAULT_THRESHOLDS) {
    const sorted = [...runs].sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
    const out = [];
    for (const r of sorted) {
        const { matching } = filterSamples(r.samples, device, filter, null);
        const a = medianAbsoluteVelocity(matching, thresholds.minSamples);
        const b = velocityPerEffectiveCommand(matching, thresholds.minSamples);
        const c = currentPerMovement(matching, thresholds.currentCostMinVelocityTps, thresholds.minSamples);
        const d = p95Current(matching, thresholds.minSamples);
        const e = possibleStallPercentage(matching, thresholds, thresholds.minSamples);
        out.push({
            runId: r.runId,
            runStartedAt: r.runStartedAt,
            medianVelocity: a.value,
            velocityEfficiency: b.value,
            currentCost: c.value,
            p95Current: d.value,
            possibleStallPct: e.value,
            comparableSamples: a.n,
            activeDurationMs: a.activeMs,
        });
    }
    return out;
}
//# sourceMappingURL=comparison.js.map