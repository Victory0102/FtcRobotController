import { formatPower, formatTicks, formatTps, formatAmps, formatVoltage, formatMs, formatHz, formatFractionPct, formatFractionPctSigned, formatSignedDiff, MISSING, } from './format.js';
import { getStatusClass, getStatusLabel } from './status.js';
/* ============================================================ Live summary */
function formatElapsed(ms) {
    if (ms == null || !Number.isFinite(ms) || ms < 0)
        return MISSING;
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec - m * 60;
    if (m > 0)
        return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
}
function connectionClass(state) {
    switch (state) {
        case 'connected': return 'rh-status--stable';
        case 'connecting': return 'rh-status--changed';
        case 'disconnected': return 'rh-status--disconnected';
        case 'no_session': return 'rh-status--missing';
        default: return 'rh-status--missing';
    }
}
export function buildLiveSummaryChips(args) {
    const out = [];
    const connection = {
        kind: 'connection',
        label: 'Connection',
        value: getStatusLabel(args.connectionState),
        statusClass: `${connectionClass(args.connectionState)} rh-status`,
    };
    out.push(connection);
    out.push({
        kind: 'opMode',
        label: 'OpMode',
        value: args.snap?.op_mode ?? MISSING,
        secondary: args.snap?.session_id ? `session ${args.snap.session_id.slice(0, 8)}` : undefined,
    });
    out.push({
        kind: 'elapsed',
        label: 'Elapsed',
        value: formatElapsed(args.snap?.elapsed_ms),
    });
    const bV = args.snap?.battery_voltage;
    out.push({
        kind: 'battery',
        label: 'Battery',
        value: formatVoltage(bV),
        unit: bV != null && Number.isFinite(bV) ? 'V' : undefined,
        secondary: bV == null ? 'no battery reading' : undefined,
    });
    out.push({
        kind: 'loopTime',
        label: 'Loop time',
        value: formatMs(args.snap?.loop_time_ms),
        secondary: args.snap?.loop_time_ms == null ? 'no loop reading' : undefined,
    });
    out.push({
        kind: 'frequency',
        label: 'Update',
        value: formatHz(args.observedHz),
    });
    out.push({
        kind: 'motorCount',
        label: 'Motors',
        value: String(args.motorCount),
    });
    out.push({
        kind: 'channelCount',
        label: 'Channels',
        value: String(args.channelCount),
    });
    out.push({
        kind: 'eventCount',
        label: 'Events',
        value: String(args.eventCount),
    });
    out.push({
        kind: 'conditionCount',
        label: 'Conditions',
        value: String(args.conditions.length),
        secondary: args.conditions.length === 0 ? 'no advisories this window' : undefined,
    });
    return out;
}
/* ============================================================ Motor cards */
/**
 * Returns the FIRST finite entry of `arr` (the most-recent value when the
 * live store pushes to the FRONT of the history array).  Walks from index 0
 * upward and skips null/non-finite entries so a trailing bad value never
 * locks the card to stale data.
 */
function firstFinite(arr) {
    for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (e.v != null && Number.isFinite(e.v)) {
            return { v: e.v, t: e.t };
        }
    }
    return null;
}
export function buildMotorCardDescriptors(args) {
    const out = [];
    const snapMotors = args.snap?.motors ?? [];
    const snapByName = new Map();
    for (const m of snapMotors) {
        if (m && typeof m.device_name === 'string')
            snapByName.set(m.device_name, m);
    }
    const names = args.store.getMotorNames();
    for (const name of names) {
        const slice = args.store.getMotor(name);
        const live = slice;
        const snapMotor = snapByName.get(name);
        // Live history convention: most-recent value is at INDEX 0 (push-to-front).
        // Use firstFinite (not lastFinite) so the displayed value tracks the freshest sample.
        const power = firstFinite(live?.powerHistory ?? []);
        const position = firstFinite(live?.positionHistory ?? []);
        const velocity = firstFinite(live?.velocityHistory ?? []);
        const current = firstFinite(live?.currentHistory ?? []);
        const lastUpdateMs = power?.t ?? null;
        const rows = [
            { label: 'Power', value: formatPower(power?.v ?? snapMotor?.power), tone: power == null ? 'missing' : 'normal' },
            { label: 'Position', value: formatTicks(position?.v ?? snapMotor?.position_ticks), tone: 'normal' },
            { label: 'Velocity', value: formatTps(velocity?.v ?? snapMotor?.velocity_ticks_per_second), tone: velocity == null ? 'missing' : 'normal' },
            { label: 'Current', value: formatAmps(current?.v ?? snapMotor?.current_amps), tone: current == null ? 'missing' : 'normal' },
        ];
        out.push({
            deviceName: name,
            mode: live?.mode ?? snapMotor?.mode ?? '\u2014',
            metricRows: rows,
            lastUpdateMs,
            canvasId: `rh-live-motor-canvas-${cssEscapeSafe(name)}`,
        });
    }
    return out;
}
function cssEscapeSafe(s) {
    // Lightweight escape for stable DOM id derivation.  No HTML injection.
    return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}
/* ============================================================ Compare summary */
function runLabel(run) {
    if (!run)
        return 'Not selected';
    return `${run.opmodeName} – ${run.runId.slice(0, 8)}`;
}
function medianBattery(run) {
    if (!run)
        return null;
    const v = [];
    for (const s of run.samples) {
        if (s.batteryVoltage != null && Number.isFinite(s.batteryVoltage) && s.batteryVoltage > 0) {
            v.push(s.batteryVoltage);
        }
    }
    if (v.length === 0)
        return null;
    v.sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function medianLoopMs(run) {
    if (!run)
        return null;
    const dt = [];
    for (let i = 1; i < run.samples.length; i++) {
        const g = run.samples[i].timestampMs - run.samples[i - 1].timestampMs;
        if (g > 0 && g <= 1000)
            dt.push(g);
    }
    if (dt.length === 0)
        return null;
    dt.sort((a, b) => a - b);
    const m = Math.floor(dt.length / 2);
    return dt.length % 2 ? dt[m] : (dt[m - 1] + dt[m]) / 2;
}
export function buildCompareSummary(args) {
    const chips = [];
    let cards = [];
    chips.push({
        kind: 'refRun', label: 'Reference', value: runLabel(args.ref),
    });
    chips.push({
        kind: 'cmpRun', label: 'Comparison', value: runLabel(args.cmp),
    });
    if (args.out) {
        let stable = 0, changed = 0, large = 0, missing = 0, insufficient = 0;
        for (const r of args.out.rows) {
            switch (r.status) {
                case 'Stable':
                    stable += 1;
                    break;
                case 'Changed':
                    changed += 1;
                    break;
                case 'Large Change':
                    large += 1;
                    break;
                case 'Missing':
                    missing += 1;
                    break;
                case 'Insufficient Data':
                    insufficient += 1;
                    break;
                case 'Incompatible Data':
                    insufficient += 1;
                    break;
            }
        }
        chips.push({ kind: 'stable', label: 'Stable', value: String(stable),
            statusClass: 'rh-status--stable' });
        chips.push({ kind: 'changed', label: 'Changed', value: String(changed),
            statusClass: 'rh-status--changed' });
        chips.push({ kind: 'largeChange', label: 'Large change', value: String(large),
            statusClass: 'rh-status--warning' });
        chips.push({ kind: 'missing', label: 'Missing', value: String(missing),
            statusClass: 'rh-status--missing' });
        chips.push({ kind: 'insufficient', label: 'Insufficient', value: String(insufficient),
            statusClass: 'rh-status--missing' });
        cards = args.out.rows.map((r) => buildCompareCard(r));
    }
    else {
        // Return a "Comparison not loaded" indicator chip so the chips array
        // remains stable (>=5 mandatory entries) regardless of whether the
        // caller has supplied the comparison result yet.  Use a distinct kind
        // ('awaiting') so this state can never collide with the live status
        // counter chips (which share the 'insufficient' kind for insufficient
        // sample totals).
        chips.push({
            kind: 'awaiting',
            label: 'Comparison',
            value: MISSING,
            secondary: 'Select a baseline and a comparison run to populate this strip.',
            statusClass: 'rh-status--missing',
        });
    }
    // Battery + loop-time deltas.
    const refBat = medianBattery(args.ref);
    const cmpBat = medianBattery(args.cmp);
    chips.push({
        kind: 'batteryDelta',
        label: 'Battery median',
        value: formatVoltage(refBat == null || cmpBat == null ? null : cmpBat - refBat),
        unit: refBat == null || cmpBat == null ? undefined : 'V',
        secondary: refBat == null || cmpBat == null ? 'Battery unavailable in one or both runs' : undefined,
    });
    const refLoop = medianLoopMs(args.ref);
    const cmpLoop = medianLoopMs(args.cmp);
    chips.push({
        kind: 'loopTimeDelta',
        label: 'Loop-time median',
        value: formatSignedDiff(refLoop == null || cmpLoop == null ? null : cmpLoop - refLoop),
        unit: refLoop == null || cmpLoop == null ? undefined : 'ms',
        secondary: refLoop == null || cmpLoop == null ? 'Loop timing unavailable in one or both runs' : undefined,
    });
    return {
        refRunLabel: runLabel(args.ref),
        cmpRunLabel: runLabel(args.cmp),
        chips,
        cards,
    };
}
function buildCompareCard(r) {
    const sampleConf = `${r.comparableSampleCountA}/${r.comparableSampleCountB}`;
    // Collapse every cell to `Unavailable` ONLY when the motor is structurally
    // missing from the comparison - that is, status==='Missing'.  For "Incompatible
    // Data" (e.g. motor-mode mismatch RUN_WITHOUT_ENCODER vs RUN_USING_ENCODER)
    // the underlying numbers may still be valid; we surface them where they are
    // finite and expose the mode mismatch via the card's outer status class.
    const isMissing = r.status === 'Missing';
    const gate = (formatFn) => isMissing
        ? () => MISSING
        : formatFn;
    const expandedRows = [
        {
            metric: 'Median velocity',
            reference: gate(formatTps)(r.refMedianVelocity),
            comparison: gate(formatTps)(r.cmpMedianVelocity),
            rawDifference: gate(formatSignedDiff)(r.absDiffMedianVelocity),
            percentDifference: gate(formatFractionPctSigned)(r.medianVelocityChangePct),
        },
        {
            metric: 'Velocity efficiency',
            reference: gate(formatFractionPct)(r.refVelocityEfficiency),
            comparison: gate(formatFractionPct)(r.cmpVelocityEfficiency),
            rawDifference: gate(formatSignedDiff)(r.absDiffVelocityEfficiency),
            percentDifference: gate(formatFractionPctSigned)(r.velocityEfficiencyChangePct),
        },
        {
            metric: 'Current cost',
            reference: gate(formatTps)(r.refCurrentCost),
            comparison: gate(formatTps)(r.cmpCurrentCost),
            rawDifference: gate(formatSignedDiff)(r.absDiffCurrentCost),
            percentDifference: gate(formatFractionPctSigned)(r.currentCostChangePct),
        },
        {
            metric: 'P95 current',
            reference: gate(formatAmps)(r.refP95Current),
            comparison: gate(formatAmps)(r.cmpP95Current),
            rawDifference: gate(formatSignedDiff)(r.absDiffP95Current),
            percentDifference: gate(formatFractionPctSigned)(r.p95CurrentChangePct),
        },
        {
            metric: 'Possible stall %',
            reference: gate(formatFractionPct)(r.refStallPct),
            comparison: gate(formatFractionPct)(r.cmpStallPct),
            rawDifference: gate(formatSignedDiff)(r.absDiffStallPct),
            percentDifference: gate(formatFractionPctSigned)(r.possibleStallChangePct),
        },
    ];
    return {
        deviceName: r.deviceName,
        statusLabel: getStatusLabel(r.status),
        statusClass: getStatusClass(r.status),
        presence: r.presenceStatus,
        sampleConfidence: sampleConf,
        expandedRows,
    };
}
/* ============================================================ Import */
export function buildImportSummary(args) {
    return {
        recognizedFiles: args.importedRunIds.length + args.rejected.filter((r) => r.ok).length,
        runCount: args.importedRunIds.length,
        warningCount: args.rejected.filter((r) => !r.ok).length,
        rejected: args.rejected,
        openRunId: args.importedRunIds.length > 0 ? args.importedRunIds[args.importedRunIds.length - 1] : null,
        importedRunIds: args.importedRunIds.slice(),
    };
}
export function buildConditionRows(conds) {
    return conds.map((c) => ({
        severity: c.severity,
        severityClass: c.severity === 'warning' ? 'rh-condition--warning' : 'rh-condition--info',
        target: c.target,
        body: c.observation,
        inspection: c.suggestedInspection,
        whenMs: c.latestTimestampMs,
        count: c.repetitionCount,
        values: c.values ?? [],
    }));
}
//# sourceMappingURL=cards.js.map