import { filterSamples, median, possibleStallPercentage } from './metrics.js';
import { DEFAULT_THRESHOLDS } from './types.js';
const BIN_WIDTH = 0.1;
const MIN_BIN_SAMPLES = 5;
function finiteMedian(values) {
    return median(values.filter((v) => v !== null && Number.isFinite(v)));
}
function normalizedResponse(sample) {
    if (sample.commandedPower === null || sample.encoderVelocity === null)
        return null;
    const command = Math.abs(sample.commandedPower);
    if (command < 0.1)
        return null;
    const voltageFactor = sample.batteryVoltage !== null && sample.batteryVoltage > 0
        ? sample.batteryVoltage / 12
        : 1;
    const effectiveCommand = command * voltageFactor;
    return effectiveCommand > 0 ? Math.abs(sample.encoderVelocity) / effectiveCommand : null;
}
export function buildPowerResponse(run, motor, filter, minSamples = MIN_BIN_SAMPLES) {
    const { matching } = filterSamples(run.samples, motor, filter, null);
    const buckets = new Map();
    for (const sample of matching) {
        if (sample.commandedPower === null || sample.encoderVelocity === null)
            continue;
        const power = Math.abs(sample.commandedPower);
        if (power < 0.1 || power > 1.001)
            continue;
        const index = Math.min(9, Math.floor((power + 1e-9) / BIN_WIDTH) - 1);
        const bucket = buckets.get(index) ?? [];
        bucket.push(sample);
        buckets.set(index, bucket);
    }
    const out = [];
    for (const [index, samples] of buckets) {
        if (samples.length < minSamples)
            continue;
        const velocity = finiteMedian(samples.map((s) => s.encoderVelocity === null ? null : Math.abs(s.encoderVelocity)));
        const response = finiteMedian(samples.map(normalizedResponse));
        if (velocity === null || response === null)
            continue;
        out.push({
            power: Math.min(1, (index + 1.5) * BIN_WIDTH),
            sampleCount: samples.length,
            medianVelocity: velocity,
            medianResponse: response,
            medianCurrent: finiteMedian(samples.map((s) => s.currentAmps)),
        });
    }
    return out.sort((a, b) => a.power - b.power);
}
function weightedChange(ref, cmp, pick) {
    const cmpByPower = new Map(cmp.map((b) => [b.power.toFixed(2), b]));
    let weighted = 0;
    let weight = 0;
    let bins = 0;
    let samples = 0;
    for (const a of ref) {
        const b = cmpByPower.get(a.power.toFixed(2));
        if (!b)
            continue;
        const av = pick(a);
        const bv = pick(b);
        if (av === null || bv === null || !Number.isFinite(av) || !Number.isFinite(bv) || Math.abs(av) < 1e-9)
            continue;
        const w = Math.min(a.sampleCount, b.sampleCount, 100);
        weighted += ((bv - av) / Math.abs(av)) * 100 * w;
        weight += w;
        samples += Math.min(a.sampleCount, b.sampleCount);
        bins += 1;
    }
    return { value: weight > 0 ? weighted / weight : null, bins, samples };
}
function motorModes(run, motor) {
    return new Set(run.samples
        .filter((s) => s.deviceName === motor && s.motorMode)
        .map((s) => s.motorMode));
}
function medianBattery(run, motor) {
    return finiteMedian(run.samples
        .filter((s) => s.deviceName === motor)
        .map((s) => s.batteryVoltage));
}
function diagnosis(graph, severity, title, finding, meaning, inspection) {
    return { graph, severity, title, finding, meaning, inspection };
}
function pct(value) {
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}
export function compareMotorWear(reference, comparison, motor, filter) {
    const referenceBins = buildPowerResponse(reference, motor, filter);
    const comparisonBins = buildPowerResponse(comparison, motor, filter);
    const response = weightedChange(referenceBins, comparisonBins, (b) => b.medianResponse);
    const velocity = weightedChange(referenceBins, comparisonBins, (b) => b.medianVelocity);
    const current = weightedChange(referenceBins, comparisonBins, (b) => b.medianCurrent);
    const refSamples = filterSamples(reference.samples, motor, filter, null);
    const cmpSamples = filterSamples(comparison.samples, motor, filter, null);
    const refStall = possibleStallPercentage(refSamples.matching, DEFAULT_THRESHOLDS, 5).value;
    const cmpStall = possibleStallPercentage(cmpSamples.matching, DEFAULT_THRESHOLDS, 5).value;
    const stallChangePoints = refStall === null || cmpStall === null ? null : cmpStall - refStall;
    const refBattery = medianBattery(reference, motor);
    const cmpBattery = medianBattery(comparison, motor);
    const batteryDeltaV = refBattery === null || cmpBattery === null ? null : cmpBattery - refBattery;
    const refModes = motorModes(reference, motor);
    const cmpModes = motorModes(comparison, motor);
    const modeMismatch = refSamples.motorModeMismatch || cmpSamples.motorModeMismatch
        || (refModes.size > 0 && cmpModes.size > 0 && [...refModes].every((m) => !cmpModes.has(m)));
    let confidence = 'low';
    let confidenceReason = 'Too little matched command coverage for a reliable wear comparison.';
    if (!modeMismatch && response.bins >= 5 && response.samples >= 100) {
        confidence = 'high';
        confidenceReason = `${response.bins} matched power bands and ${response.samples} paired samples support this comparison.`;
    }
    else if (!modeMismatch && response.bins >= 2 && response.samples >= 30) {
        confidence = 'medium';
        confidenceReason = `${response.bins} matched power bands and ${response.samples} paired samples provide useful but limited evidence.`;
    }
    else if (modeMismatch) {
        confidenceReason = 'Motor modes differ within or between runs, so performance changes may not represent wear.';
    }
    const diagnoses = [];
    if (response.value === null) {
        diagnoses.push(diagnosis('power', 'insufficient', 'Command coverage does not overlap', 'The runs do not contain enough samples in the same power bands.', 'A speed difference would not be an apples-to-apples comparison.', 'Repeat the same test route with similar commands, battery state, payload, and floor surface.'));
    }
    else {
        diagnoses.push(diagnosis('power', response.bins >= 3 ? 'healthy' : 'watch', 'Matched command coverage', `${response.bins} power bands overlap across the two runs.`, response.bins >= 3 ? 'The response comparison controls for commanded power.' : 'The result is sensitive to a narrow command range.', response.bins >= 3 ? 'Keep using the same repeatable test route.' : 'Exercise low, medium, and high power during the next test.'));
    }
    if (velocity.value === null) {
        diagnoses.push(diagnosis('velocity', 'insufficient', 'Velocity comparison unavailable', 'There are not enough matched velocity samples.', 'No motor-speed conclusion is justified yet.', 'Verify encoders report velocity, then repeat a consistent drive test.'));
    }
    else if (velocity.value <= -15) {
        diagnoses.push(diagnosis('velocity', 'warning', 'Motor speed dropped at matched commands', `Median velocity changed ${pct(velocity.value)} after matching power bands.`, 'This can indicate added mechanical resistance, drivetrain loading, motor or gearbox wear, encoder issues, or different test conditions.', 'Lift the robot safely, check wheel/shaft freedom, inspect gears and bearings, verify encoder wiring, then repeat under the same load.'));
    }
    else if (velocity.value <= -8) {
        diagnoses.push(diagnosis('velocity', 'watch', 'Motor speed is trending lower', `Median velocity changed ${pct(velocity.value)} at matched commands.`, 'The change is worth tracking but is not enough by itself to identify a fault.', 'Inspect for rubbing or binding and repeat the same test to confirm the trend.'));
    }
    else {
        diagnoses.push(diagnosis('velocity', 'healthy', 'Velocity response is stable', `Median velocity changed ${pct(velocity.value)} at matched commands.`, 'No meaningful loss of speed is visible under the selected conditions.', 'Continue collecting the same test periodically to establish a stronger history.'));
    }
    if (current.value === null) {
        diagnoses.push(diagnosis('current', 'insufficient', 'Current comparison unavailable', 'One or both runs do not contain enough motor-current samples.', 'Velocity-based diagnosis still works, but electrical and friction clues are weaker.', 'Confirm the installed hub and motor port expose current sensing, then collect another run.'));
    }
    else if (current.value >= 20) {
        diagnoses.push(diagnosis('current', 'warning', 'Current demand increased', `Median current changed ${pct(current.value)} in matched power bands.`, 'Higher current for the same command can accompany friction, binding, heavier load, wheel contact, or electrical problems.', 'Check drivetrain freedom, wheel alignment, wiring and connectors, and compare again with the same payload.'));
    }
    else if (current.value >= 10) {
        diagnoses.push(diagnosis('current', 'watch', 'Current demand is trending higher', `Median current changed ${pct(current.value)} in matched power bands.`, 'A developing load or friction change is possible, especially if velocity is also falling.', 'Inspect the local mechanism and repeat the test before replacing parts.'));
    }
    else {
        diagnoses.push(diagnosis('current', 'healthy', 'Current demand is stable', `Median current changed ${pct(current.value)} in matched power bands.`, 'No large increase in electrical effort is visible.', 'Continue periodic comparison using the same battery and mechanical load.'));
    }
    if (response.value === null) {
        diagnoses.push(diagnosis('response', 'insufficient', 'Power-to-velocity response unavailable', 'Matched power bins are insufficient.', 'The dashboard will not guess at degradation without comparable commands.', 'Run a repeatable test that includes steady low, medium, and high power segments.'));
    }
    else {
        const responseSeverity = response.value <= -15 ? 'warning' : response.value <= -8 ? 'watch' : 'healthy';
        let meaning = 'Velocity delivered per effective command is consistent between runs.';
        let inspection = 'Keep this run as a reference and repeat the same test later.';
        if (response.value <= -8 && current.value !== null && current.value >= 10) {
            meaning = 'Less motion plus more current strengthens evidence of added mechanical load or developing drivetrain resistance.';
            inspection = 'Prioritize wheel, shaft, bearing, gearbox, chain/belt tension, and frame-contact checks on this motor path.';
        }
        else if (response.value <= -8 && batteryDeltaV !== null && batteryDeltaV <= -0.5) {
            meaning = 'The comparison run used meaningfully lower voltage, so battery or power delivery may explain part of the response loss.';
            inspection = 'Retest with similarly charged batteries and inspect high-current connectors before attributing the change to motor wear.';
        }
        else if (response.value <= -8) {
            meaning = 'The motor delivered less velocity per battery-adjusted command; wear, drag, load, or test-condition changes are possible.';
            inspection = 'Repeat under controlled conditions, then inspect the motor and local drivetrain if the loss persists.';
        }
        diagnoses.push(diagnosis('response', responseSeverity, 'Command-to-motion response', `Battery-adjusted response changed ${pct(response.value)}.`, meaning, inspection));
    }
    if (stallChangePoints !== null && stallChangePoints >= 5) {
        diagnoses.push(diagnosis('overall', 'warning', 'Possible-stall exposure increased', `High-command, low-velocity samples increased by ${stallChangePoints.toFixed(1)} percentage points.`, 'This pattern can occur with obstruction, binding, disconnected encoders, or a mechanism intentionally holding position.', 'Review the matching time interval and inspect the mechanism before running it under prolonged load.'));
    }
    let healthScore = null;
    if (response.value !== null) {
        const responsePenalty = Math.min(45, Math.max(0, -response.value) * 2);
        const currentPenalty = current.value === null ? 0 : Math.min(20, Math.max(0, current.value) * 0.8);
        const stallPenalty = stallChangePoints === null ? 0 : Math.min(25, Math.max(0, stallChangePoints) * 2);
        healthScore = Math.round(Math.max(0, 100 - responsePenalty - currentPenalty - stallPenalty));
    }
    return {
        motor,
        confidence,
        confidenceReason,
        healthScore,
        matchedBins: response.bins,
        matchedSamples: response.samples,
        responseChangePct: response.value,
        velocityChangePct: velocity.value,
        currentChangePct: current.value,
        stallChangePoints,
        batteryDeltaV,
        modeMismatch,
        referenceBins,
        comparisonBins,
        diagnoses,
    };
}
export function buildTimeOverlay(run, motor, metric) {
    const samples = run.samples.filter((s) => s.deviceName === motor);
    if (samples.length === 0)
        return [];
    const start = samples[0].timestampMs;
    const end = samples[samples.length - 1].timestampMs;
    const span = Math.max(1, end - start);
    const out = [];
    for (const sample of samples) {
        const value = metric === 'power' ? sample.commandedPower
            : metric === 'velocity' ? sample.encoderVelocity
                : sample.currentAmps;
        if (value === null || !Number.isFinite(value))
            continue;
        out.push({ x: ((sample.timestampMs - start) / span) * 100, y: value });
    }
    return out;
}
export function buildWearHistory(runs, motor, filter) {
    const eligible = [...runs]
        .filter((run) => run.deviceNames.includes(motor))
        .sort((a, b) => a.runStartedAt.localeCompare(b.runStartedAt));
    const baseline = eligible[0];
    if (!baseline)
        return [];
    return eligible.map((run, index) => {
        if (index === 0) {
            return {
                runId: run.runId,
                runStartedAt: run.runStartedAt,
                healthScore: 100,
                responseChangePct: 0,
                currentChangePct: 0,
                confidence: 'high',
            };
        }
        const report = compareMotorWear(baseline, run, motor, filter);
        return {
            runId: run.runId,
            runStartedAt: run.runStartedAt,
            healthScore: report.healthScore,
            responseChangePct: report.responseChangePct,
            currentChangePct: report.currentChangePct,
            confidence: report.confidence,
        };
    });
}
//# sourceMappingURL=wear.js.map