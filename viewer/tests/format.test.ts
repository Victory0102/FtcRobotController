import { describe, it, expect } from 'vitest';
import {
  formatPower, formatTicks, formatTps, formatAmps, formatVoltage,
  formatMs, formatHz, formatHeading, formatPct, formatXy,
  formatRate, formatDuration, MISSING,
} from '../src/format';

describe('format', () => {
  it('returns the unified missing text for null / undefined / non-finite', () => {
    expect(formatPower(null)).toBe(MISSING);
    expect(formatPower(undefined)).toBe(MISSING);
    expect(formatPower(Number.NaN)).toBe(MISSING);
    expect(formatPower(Number.POSITIVE_INFINITY)).toBe(MISSING);
    expect(formatTicks(null)).toBe(MISSING);
    expect(formatTps(null)).toBe(MISSING);
    expect(formatAmps(null)).toBe(MISSING);
    expect(formatVoltage(null)).toBe(MISSING);
    expect(formatMs(null)).toBe(MISSING);
    expect(formatHz(null)).toBe(MISSING);
    expect(formatHeading(null)).toBe(MISSING);
    expect(formatPct(null)).toBe(MISSING);
    expect(formatXy(null)).toBe(MISSING);
    expect(formatRate(null, 1)).toBe(MISSING);
    expect(formatRate(5, 0)).toBe(MISSING);
    expect(formatDuration(null)).toBe(MISSING);
    expect(formatDuration(Number.NaN)).toBe(MISSING);
  });

  it('formats power without a unit, 2 decimal places', () => {
    expect(formatPower(0)).toBe('0.00');
    expect(formatPower(1)).toBe('1.00');
    expect(formatPower(0.625)).toBe('0.63');
  });

  it('formats ticks + tps with locale thousands separators', () => {
    expect(formatTicks(14820)).toBe('14,820 ticks');
    expect(formatTicks(0)).toBe('0 ticks');
    expect(formatTps(1320)).toBe('1,320 ticks/s');
    expect(formatTps(-1234567)).toBe('-1,234,567 ticks/s');
  });

  it('formats current, voltage, milliseconds, hz, heading', () => {
    // (2.135 in IEEE‑754 rounds down to 2.13 under Number.toFixed because the
    // bit‑exact representation is just below the half‑step.  Document the
    // floating‑point behaviour the viewer exhibits so a future maintainer
    // does not think the value is wrong.)
    expect(formatAmps(2.135)).toBe('2.13 A');
    expect(formatVoltage(12.512)).toBe('12.51 V');
    expect(formatMs(18.4)).toBe('18.4 ms');
    expect(formatHz(54.3)).toBe('54.3 Hz');
    expect(formatHeading(91.4)).toBe('91.4°');
  });

  it('formats percentages with optional sign', () => {
    expect(formatPct(12.3)).toBe('12.3%');
    expect(formatPct(0)).toBe('0.0%');
    expect(formatPct(12.3, true)).toBe('+12.3%');
    expect(formatPct(-3.4, true)).toBe('-3.4%');
    expect(formatPct(0, true)).toBe('0.0%');
  });

  it('formats xy and rate and duration', () => {
    expect(formatXy(12.345, 2)).toBe('12.35 in');
    expect(formatXy(-2.5)).toBe('-2.50 in');
    expect(formatRate(5, 1000)).toBe('5.0 Hz');     // 5 samples in 1000 ms -> 5 Hz
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(8_000)).toBe('8s');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(125_000)).toBe('02:05');
  });
});
