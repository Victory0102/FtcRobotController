import { describe, it, expect } from 'vitest';
import { METRIC_HELP, getMetricHelp } from '../src/metricHelp';

describe('metricHelp', () => {
  it('every metric the UI exposes has a localised explanation', () => {
    const expected = [
      'Median velocity', 'Velocity efficiency', 'Current cost',
      '95th-percentile current', 'Possible Stall Percentage',
      'Battery minimum', 'Battery median',
      'Loop-time median', 'Loop-time 95th percentile',
      'Baseline difference', 'Previous-run difference',
      'Power', 'Position', 'Velocity', 'Current', 'Loop time',
      'Frequency', 'Battery voltage', 'Heading',
    ];
    for (const key of expected) {
      expect(METRIC_HELP[key], `missing help for ${key}`).toBeTypeOf('string');
      expect(METRIC_HELP[key]!.length, `${key} explanation too short`).toBeGreaterThan(8);
    }
  });

  it('unknown keys return the no-description fallback', () => {
    expect(getMetricHelp('some-future-metric')).toBe('No additional description available.');
  });

  it('explicit fallback text does not leak the literal "undefined" or "NaN"', () => {
    expect(getMetricHelp('unknown')).not.toMatch(/undefined|NaN/);
  });

  it('Possible Stall Percentage wording reflects "observation, not confirmed"', () => {
    // The redesign requires measured-language sentences.
    const txt = METRIC_HELP['Possible Stall Percentage'];
    expect(txt.toLowerCase()).toMatch(/observation|not a confirmed|not confirm/);
  });
});
