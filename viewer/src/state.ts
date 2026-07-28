/**
 * Browser-side state persistence.  Only stores non-sensitive UI state; never
 * stores raw CSV.  Reset Viewer Data clears everything.
 */

export interface ViewerState {
  baselineRunId: string | null;          // only meaningful for standalone drag-drop runs
  lastComparisonMode: 'BASELINE' | 'DIRECT';
  selectedMotor: string | null;
  selectedDirection: 'POSITIVE' | 'NEGATIVE' | 'BOTH';
  selectedPowerBand: 'LOW' | 'MEDIUM' | 'HIGH' | 'ALL_ACTIVE';
}

const KEY = 'runhealth.viewerState.v1';

export const DEFAULT_STATE: ViewerState = {
  baselineRunId: null,
  lastComparisonMode: 'BASELINE',
  selectedMotor: null,
  selectedDirection: 'BOTH',
  selectedPowerBand: 'ALL_ACTIVE',
};

export function loadState(): ViewerState {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_STATE };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
    };
  } catch (e) {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(s: ViewerState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    // Quota or disabled storage - silently keep state in memory.
  }
}

export function clearState(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    // ignore
  }
}
