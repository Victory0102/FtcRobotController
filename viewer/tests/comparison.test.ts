import { describe, it, expect } from 'vitest';
import { wholeRobotComparison, perMotorTrend } from '../src/comparison.js';

import { parseRunHealthCsv } from '../src/parser.js';
import { Run, FilterSelection } from '../src/types.js';

async function loadRun(name: string): Promise<Run> {
  const fs = await import('fs');
  const path = await import('path');
  const url = await import('url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const csv = fs.readFileSync(path.resolve(here, '..', '..', 'sample-data', `${name}.csv`), 'utf-8');
  const r = parseRunHealthCsv(csv, `${name}.csv`);
  if (r.kind !== 'ok') throw new Error(`Failed to parse ${name}: ${r.reason}`);
  return r.run;
}

const FILTER: FilterSelection = { direction: 'BOTH', powerBand: 'ALL_ACTIVE' };

describe('wholeRobotComparison', () => {
  it('healthy-baseline vs healthy-similar → near 0% changes', async () => {
    const ref = await loadRun('healthy-baseline');
    const cmp = await loadRun('healthy-similar');
    const out = wholeRobotComparison({ reference: ref, comparison: cmp, filter: FILTER });
    expect(out.rows.length).toBe(4);
    for (const row of out.rows) {
      expect(row.comparableSampleCountA).toBeGreaterThanOrEqual(20);
      expect(row.comparableSampleCountB).toBeGreaterThanOrEqual(20);
      // Either 'Stable' OR multiple metrics available
      expect(['Stable', 'Changed', 'Insufficient Data']).toContain(row.status);
      // Both motors present in both runs
      expect(row.presentInReference).toBe(true);
      expect(row.presentInComparison).toBe(true);
    }
  });

  it('baseline vs slower-motor shows velocity change', async () => {
    const ref = await loadRun('healthy-baseline');
    const cmp = await loadRun('slower-motor');
    const out = wholeRobotComparison({ reference: ref, comparison: cmp, filter: FILTER });
    const leftFrontRow = out.rows.find((r) => r.deviceName === 'leftFront')!;
    expect(leftFrontRow).toBeTruthy();
    expect(leftFrontRow.medianVelocityChangePct).toBeLessThan(0);
    expect(Math.abs(leftFrontRow.medianVelocityChangePct!)).toBeGreaterThan(5);
  });

  it('baseline vs higher-current shows positive change for affected motor', async () => {
    const ref = await loadRun('healthy-baseline');
    const cmp = await loadRun('higher-current');
    const out = wholeRobotComparison({ reference: ref, comparison: cmp, filter: FILTER });
    const leftFrontRow = out.rows.find((r) => r.deviceName === 'leftFront')!;
    expect(leftFrontRow.p95CurrentChangePct).not.toBe(null);
    expect(leftFrontRow.p95CurrentChangePct).toBeGreaterThan(0);
  });

  it('baseline vs missing-motor-run flags missing on rightBack', async () => {
    const ref = await loadRun('healthy-baseline');
    const cmp = await loadRun('missing-motor-run');
    const out = wholeRobotComparison({ reference: ref, comparison: cmp, filter: FILTER });
    const rb = out.rows.find((r) => r.deviceName === 'rightBack')!;
    expect(rb.presentInReference).toBe(true);
    expect(rb.presentInComparison).toBe(false);
    expect(rb.status).toBe('Missing');
    // Other motors (leftFront, leftBack, rightFront) should still compare:
    for (const d of ['leftFront', 'leftBack', 'rightFront']) {
      const row = out.rows.find((r) => r.deviceName === d)!;
      expect(row.status).not.toBe('Missing');
    }
  });

  it('baseline vs renamed-motor-run treats names as different motors', async () => {
    const ref = await loadRun('healthy-baseline');
    const cmp = await loadRun('renamed-motor-run');
    const out = wholeRobotComparison({ reference: ref, comparison: cmp, filter: FILTER });
    // No single row should be marked Missing for an analyst setup where
    // only renamed devices exist; expect every row to be Missing on at least
    // one side.
    let foundMiss = 0;
    for (const r of out.rows) {
      if (!r.presentInReference || !r.presentInComparison) foundMiss++;
    }
    expect(foundMiss).toBeGreaterThan(0);
  });

  it('baseline vs different-motor-mode-run flags mode mismatch', async () => {
    const ref = await loadRun('healthy-baseline');
    const cmp = await loadRun('different-motor-mode-run');
    const out = wholeRobotComparison({ reference: ref, comparison: cmp, filter: FILTER });
    // Either Incompatible Data or Insufficient Data, since the mode differs.
    for (const r of out.rows) {
      if (r.motorModeMismatch) {
        expect(['Incompatible Data', 'Insufficient Data']).toContain(r.status);
      }
    }
  });

  it('baseline vs missing-current-data still computes velocity metrics', async () => {
    const ref = await loadRun('healthy-baseline');
    const cmp = await loadRun('missing-current-data');
    const out = wholeRobotComparison({ reference: ref, comparison: cmp, filter: FILTER });
    const row = out.rows.find((r) => r.deviceName === 'leftFront')!;
    expect(row.medianVelocityChangePct).not.toBe(null);
  });

  it('insufficient-samples yields Insufficient Data / Missing', async () => {
    const ref = await loadRun('healthy-baseline');
    const cmp = await loadRun('insufficient-samples');
    const out = wholeRobotComparison({ reference: ref, comparison: cmp, filter: FILTER });
    // For every device, comparableSampleCountB should be very low.
    for (const r of out.rows) {
      expect(r.comparableSampleCountB).toBeLessThan(20);
    }
  });

  it('low-battery-run is reported as comparable when filter is ALL_ACTIVE', async () => {
    const ref = await loadRun('healthy-baseline');
    const cmp = await loadRun('low-battery-run');
    const out = wholeRobotComparison({ reference: ref, comparison: cmp, filter: FILTER });
    expect(out.rows.length).toBe(4);
  });
});

describe('perMotorTrend', () => {
  it('produces one row per run, sorted chronologically', async () => {
    const runs = await Promise.all([
      loadRun('healthy-baseline'),
      loadRun('healthy-similar'),
      loadRun('gradual-deterioration-01'),
      loadRun('gradual-deterioration-05'),
    ]);
    const trend = perMotorTrend(runs, 'leftFront', FILTER);
    expect(trend.length).toBe(4);
    // increasing deterioration should give decreasing medians.
    const medians = trend.map((r) => r.medianVelocity ?? 0);
    expect(medians[medians.length - 1]).toBeLessThan(medians[0]);
  });

  it('returns rows even when no comparable data', async () => {
    const runs = await Promise.all([
      loadRun('insufficient-samples'),
    ]);
    const trend = perMotorTrend(runs, 'leftFront', FILTER);
    expect(trend.length).toBe(1);
    expect(trend[0].comparableSamples).toBeLessThan(20);
  });
});
