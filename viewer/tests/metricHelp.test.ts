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
      'Power', 'Velocity', 'Current', 'Loop time',
      'Frequency', 'Battery voltage',
      'OpMode', 'Run ID', 'Started', 'Source', 'Size', 'Motors',
      'Channels', 'Samples', 'Build', 'Truncated', 'Baseline', 'Actions',
      'Recognized files', 'Imported runs', 'Warnings',
      'Metric', 'Reference', 'Comparison', 'Raw diff', 'Percent diff',
      'Status', 'Presence', 'Date', 'Value', 'Δ baseline', 'Δ previous',
      'Channel', 'Kind', 'Value at replay time', 'Unit', 'Group', 'Description', 'Min', 'Max',
      'Final', 'Transitions', 'Time true', 'First',
      'Motor evidence score', 'Confidence', 'Matched bands', 'Matched samples',
      'Response change', 'Current change', 'Battery difference',
      'Stable', 'Changed', 'Large change', 'Missing', 'Insufficient',
      'Commanded power', 'Encoder velocity', 'Motor current',
      'Normalized run time', 'Absolute commanded power',
      'Recording mode', 'Direction', 'Power band', 'Motor to diagnose',
      'Connection', 'Elapsed', 'Update', 'Conditions', 'Events',
      'Commanded power over run', 'Motor velocity over run',
      'Motor current over run', 'Commanded power to delivered velocity',
      'Motor signals at replay time', 'Trend chart',
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
