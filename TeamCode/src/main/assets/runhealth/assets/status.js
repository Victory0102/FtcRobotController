/**
 * Unified status vocabulary for the FTC Run Health viewer.
 *
 * The viewer's internal comparison logic emits a small fixed set of
 * status words (Stable, Changed, Large Change, Missing, ...). The
 * redesign requires each renderer to:
 *
 *   1. Read STATUS_LABEL[rawStatus] to get the user-facing copy.
 *   2. Read STATUS_CLASS[rawStatus] to get the CSS class for colour.
 *   3. Provide ariaString values that never rely on colour alone.
 *
 * Keys intentionally cover the production enum plus legacy values
 * emitted by older runs so the comparisons gracefully degrade.
 */
/** Friendly long-form label for display in the dashboard. */
export const STATUS_LABEL = {
    'Stable': 'Stable',
    'Changed': 'Changed',
    'Large Change': 'Large change',
    'Missing': 'Missing',
    'Insufficient Data': 'Insufficient data',
    'Incompatible Data': 'Incompatible data',
    'Not comparable': 'Not comparable',
    'Not available': 'Not available',
    'No active session': 'No active session',
    'Disconnected': 'Disconnected',
    'Reconnecting': 'Reconnecting',
    'Connected': 'Connected',
    'Normal': 'Normal',
    'Check data': 'Check data',
    // Live connection-state enum (snake_case) maps to the same wording as the
    // canonical comparison enum above so the live summary chip is consistent
    // with the rest of the dashboard wording contract.
    'connected': 'Connected',
    'connecting': 'Connecting',
    'disconnected': 'Disconnected',
    'no_session': 'No active session',
};
/**
 * CSS class hook.  Mirrors what the existing styles.css used plus the
 * new utility variants introduced by this redesign (.rh-status--*).
 */
export const STATUS_CLASS = {
    'Stable': 'status-Stable rh-status--stable',
    'Changed': 'status-Changed rh-status--changed',
    'Large Change': 'status-Large rh-status--warning',
    'Missing': 'status-Missing rh-status--missing',
    'Insufficient Data': 'status-Missing rh-status--missing',
    'Incompatible Data': 'status-Missing rh-status--missing',
    'Not comparable': 'status-Missing rh-status--not-comparable',
    'Not available': 'status-Missing rh-status--missing',
    'No active session': 'rh-status--missing',
    'Disconnected': 'rh-status--disconnected',
    'Reconnecting': 'rh-status--disconnected',
    'Connected': 'rh-status--stable',
    'Normal': 'rh-status--stable',
    'Check data': 'rh-status--changed',
    // Live connection-state enum (snake_case) mirrors the canonical mappings.
    'connected': 'rh-status--stable',
    'connecting': 'rh-status--changed',
    'disconnected': 'rh-status--disconnected',
    'no_session': 'rh-status--missing',
};
export const STATUS_TONE = {
    'Stable': 'healthy',
    'Changed': 'advisory',
    'Large Change': 'warning',
    'Missing': 'missing',
    'Insufficient Data': 'missing',
    'Incompatible Data': 'missing',
    'Not comparable': 'missing',
    'Not available': 'missing',
    'No active session': 'missing',
    'Disconnected': 'disconnected',
    'Reconnecting': 'disconnected',
    'Connected': 'healthy',
    'Normal': 'healthy',
    'Check data': 'advisory',
};
export function getStatusClass(s) {
    return STATUS_CLASS[s ?? ''] ?? 'rh-status--missing';
}
export function getStatusLabel(s) {
    // Always surface a non-empty string.  null / undefined / unknown technical
    // status words all collapse to the unified 'Missing' wording so the UI
    // never renders an empty label cell.  Same single-shape pattern as
    // getStatusClass() below for symmetry.
    return STATUS_LABEL[s ?? ''] ?? STATUS_LABEL.Missing;
}
/**
 * Maps the technical "Incompatible Data" / "Not comparable" cases to the
 * localised wording the redesign requires ("Not comparable").
 * Use in places where the user is selecting two disparate runs.
 */
export function notComparable() {
    return 'Not comparable';
}
//# sourceMappingURL=status.js.map