import { describe, it, expect } from 'vitest';
import {
  STATUS_LABEL, STATUS_CLASS, STATUS_TONE,
  getStatusClass, getStatusLabel, notComparable,
} from '../src/status';

describe('status', () => {
  const KNOWN_STATUSES = [
    'Stable', 'Changed', 'Large Change', 'Missing',
    'Insufficient Data', 'Incompatible Data', 'Not comparable',
    'Not available', 'No active session',
    'Disconnected', 'Reconnecting', 'Connected',
    'Normal', 'Check data',
  ];

  it('every known status word has a label, class, and tone', () => {
    for (const s of KNOWN_STATUSES) {
      expect(STATUS_LABEL[s], `missing label for ${s}`).toBeDefined();
      expect(STATUS_CLASS[s], `missing class for ${s}`).toBeDefined();
      expect(STATUS_TONE[s], `missing tone for ${s}`).toBeDefined();
    }
  });

  it('Stable maps to the healthy class', () => {
    expect(STATUS_CLASS.Stable).toContain('status-Stable');
    expect(STATUS_TONE.Stable).toBe('healthy');
  });

  it('Large Change maps to the warning tone', () => {
    expect(STATUS_TONE['Large Change']).toBe('warning');
  });

  it('Disconnected maps to the disconnected tone', () => {
    expect(STATUS_TONE.Disconnected).toBe('disconnected');
  });

  it('Connected maps to the healthy tone', () => {
    expect(STATUS_TONE.Connected).toBe('healthy');
  });

  it('null and undefined inputs fall back to the missing class', () => {
    expect(getStatusClass(null)).toContain('rh-status--missing');
    expect(getStatusClass(undefined)).toContain('rh-status--missing');
    expect(getStatusLabel(null)).toBe('Missing');
    expect(getStatusLabel(undefined)).toBe('Missing');
  });

  it('unknown technical status words still get a sensible label', () => {
    const cls = getStatusClass('UNKNOWN_FUTURE_STATUS');
    expect(cls).toContain('rh-status--missing');
  });

  it('notComparable returns the spec-mandated wording', () => {
    expect(notComparable()).toBe('Not comparable');
  });
});
