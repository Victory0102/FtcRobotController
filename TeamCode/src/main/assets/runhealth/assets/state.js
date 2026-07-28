/**
 * Browser-side state persistence.  Only stores non-sensitive UI state; never
 * stores raw CSV.  Reset Viewer Data clears everything.
 */
const KEY = 'runhealth.viewerState.v1';
export const DEFAULT_STATE = {
    baselineRunId: null,
    lastComparisonMode: 'BASELINE',
    selectedMotor: null,
    selectedDirection: 'BOTH',
    selectedPowerBand: 'ALL_ACTIVE',
};
export function loadState() {
    if (typeof localStorage === 'undefined')
        return { ...DEFAULT_STATE };
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw)
            return { ...DEFAULT_STATE };
        const parsed = JSON.parse(raw);
        return {
            ...DEFAULT_STATE,
            ...parsed,
        };
    }
    catch (e) {
        return { ...DEFAULT_STATE };
    }
}
export function saveState(s) {
    if (typeof localStorage === 'undefined')
        return;
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    }
    catch (e) {
        // Quota or disabled storage - silently keep state in memory.
    }
}
export function clearState() {
    if (typeof localStorage === 'undefined')
        return;
    try {
        localStorage.removeItem(KEY);
    }
    catch (e) {
        // ignore
    }
}
//# sourceMappingURL=state.js.map