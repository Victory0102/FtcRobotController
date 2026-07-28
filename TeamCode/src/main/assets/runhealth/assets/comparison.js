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
            medianVelocityChangePct: medianVelocityChange.value,
            velocityEfficiencyChangePct: velEffChange.value,
            currentCostChangePct: currentCostChange.value,
            p95CurrentChangePct: p95Change.value,
            possibleStallChangePct: stallChange.value,
            comparableSampleCountA: ref.n,
            comparableSampleCountB: cmp.n,
            motorModeMismatch: ref.motorModeMismatch || cmp.motorModeMismatch,
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
        };
    }
    const { matching, motorModeMismatch } = filterSamples(run.samples, device, filter, null);
    const a = medianAbsoluteVelocity(matching, thresholds.minSamples);
    const b = velocityPerEffectiveCommand(matching, thresholds.minSamples);
    const c = currentPerMovement(matching, thresholds.currentCostMinVelocityTps, thresholds.minSamples);
    const d = p95Current(matching, thresholds.minSamples);
    const e = possibleStallPercentage(matching, thresholds, thresholds.minSamples);
    return {
        present: true,
        motorModeMismatch,
        medianVelocity: a.value,
        velocityEfficiency: b.value,
        currentCost: c.value,
        p95Current: d.value,
        possibleStallPct: e.value,
        n: a.n,
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