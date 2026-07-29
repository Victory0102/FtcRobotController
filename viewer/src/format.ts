/**
 * Standardized value formatters for the FTC Run Health viewer.
 *
 * Every formatter returns the literal string "Unavailable" when the input
 * is null, undefined, or non-finite. The viewer never substitutes zero
 * or NaN for missing values; downstream UI uses the same wording so the
 * team sees "Unavailable" consistently.
 *
 *  - Power:           "0.62"                  (no unit, dimensionless)
 *  - Position:        "14,820 ticks"          (locale-aware thousands)
 *  - Velocity:        "1,320 ticks/s"
 *  - Current:         "2.14 A"
 *  - Battery voltage: "12.51 V"
 *  - Loop time:       "18.4 ms"
 *  - Frequency:       "54.3 Hz"
 *  - Heading:         "91.4°"
 *  - Percentage:      "+12.3%" / "-3.4%"      (signed when sign != 0)
 */

export const MISSING = 'Unavailable';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function formatPower(v: number | null | undefined): string {
  return isFiniteNumber(v) ? v.toFixed(2) : MISSING;
}

export function formatTicks(v: number | null | undefined): string {
  return isFiniteNumber(v) ? `${v.toLocaleString('en-US')} ticks` : MISSING;
}

export function formatTps(v: number | null | undefined): string {
  return isFiniteNumber(v) ? `${v.toLocaleString('en-US')} ticks/s` : MISSING;
}

export function formatAmps(v: number | null | undefined): string {
  return isFiniteNumber(v) ? `${v.toFixed(2)} A` : MISSING;
}

export function formatVoltage(v: number | null | undefined): string {
  return isFiniteNumber(v) ? `${v.toFixed(2)} V` : MISSING;
}

export function formatMs(v: number | null | undefined): string {
  return isFiniteNumber(v) ? `${v.toFixed(1)} ms` : MISSING;
}

export function formatHz(v: number | null | undefined): string {
  return isFiniteNumber(v) ? `${v.toFixed(1)} Hz` : MISSING;
}

export function formatHeading(v: number | null | undefined): string {
  return isFiniteNumber(v) ? `${v.toFixed(1)}°` : MISSING;
}

export function formatPct(v: number | null | undefined, signed = false): string {
  if (!isFiniteNumber(v)) return MISSING;
  const rounded = v.toFixed(1);
  if (signed) {
    if (v > 0) return `+${rounded}%`;
    if (v < 0) return `${rounded}%`;          // includes negative sign
    return '0.0%';
  }
  return `${rounded}%`;
}

export function formatXy(v: number | null | undefined, digits = 2): string {
  return isFiniteNumber(v) ? `${v.toFixed(digits)} in` : MISSING;
}

/**
 * Composite helper: turn a direction-aware input + per-second window into a
 * "N samples/sec" rate string.  Used by the live snapshot frequency chip.
 */
export function formatRate(count: number, perMs: number): string {
  if (!isFiniteNumber(count) || !isFiniteNumber(perMs) || perMs <= 0) return MISSING;
  return `${(count * 1000 / perMs).toFixed(1)} Hz`;
}

/**
 * Format a 0..1 fraction value (e.g. efficiency ratio, fraction of samples
 * meeting a criterion) as a percentage (e.g. 0.62 -> "62.0%").
 * Use this when the source value is still a fraction in [0, 1]; for
 * already-scaled percentages (0..100), use {@link formatPct} directly.
 * Missing values render as `MISSING` - never collapses to zero.
 */
export function formatFractionPct(v: number | null | undefined, signed = false): string {
  if (!isFiniteNumber(v)) return MISSING;
  const scaled = (v as number) * 100;
  return formatPct(scaled, signed);
}
export function formatFractionPctSigned(v: number | null | undefined): string {
  return formatFractionPct(v, true);
}

/**
 * Signed raw-unit delta with explicit + / - sign and the unified
 * "Unavailable" fallback.  Use this for absolute side-by-side differences
 * where missing must NOT collapse to zero.  E.g. cmp (3.5) - ref (1.0) -> "+2.50".
 */
export function formatSignedDiff(v: number | null | undefined): string {
  if (!isFiniteNumber(v)) return MISSING;
  const n = v as number;
  const rounded = n.toFixed(2);
  if (n === 0) return '0.00';
  if (n > 0) return `+${rounded}`;
  return rounded;
}

/**
 * Compose a duration like "01:42" or "00:08".
 * Returns "Not available" for null/non-finite to match the rest of the
 * unified missing-text vocabulary used in the UI.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (!isFiniteNumber(ms) || ms < 0) return MISSING;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
