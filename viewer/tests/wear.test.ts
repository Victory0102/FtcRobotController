import { describe, expect, it } from 'vitest';
import { buildPowerResponse, buildTimeOverlay, buildWearHistory, compareMotorWear } from '../src/wear.js';
import { FilterSelection, Run, Sample } from '../src/types.js';

const FILTER: FilterSelection = { direction: 'BOTH', powerBand: 'ALL_ACTIVE' };

function makeRun(
  id: string,
  velocityScale: number,
  currentScale: number,
  voltage = 12,
  modes: string[] = ['RUN_USING_ENCODER'],
): Run {
  const samples: Sample[] = [];
  let timestampMs = 0;
  for (let band = 1; band <= 9; band += 1) {
    const power = band / 10 + 0.05;
    for (let i = 0; i < 20; i += 1) {
      samples.push({
        runId: id,
        opmodeName: 'WearTest',
        runStartedAt: id === 'ref' ? '2026-01-01T00:00:00Z' : '2026-08-01T00:00:00Z',
        timestampMs,
        deviceName: 'left_drive',
        commandedPower: power,
        encoderPositionTicks: null,
        encoderVelocity: power * 3000 * velocityScale,
        currentAmps: power * 4 * currentScale,
        motorMode: modes[i % modes.length],
        batteryVoltage: voltage,
      });
      timestampMs += 100;
    }
  }
  return {
    schemaVersion: '1',
    runId: id,
    opmodeName: 'WearTest',
    runStartedAt: samples[0].runStartedAt,
    deviceNames: ['left_drive'],
    samples,
    truncated: false,
    invalidRowCount: 0,
    sourceFileName: `${id}.csv`,
  };
}

describe('power response matching', () => {
  it('builds stable median velocity bins without using position', () => {
    const bins = buildPowerResponse(makeRun('ref', 1, 1), 'left_drive', FILTER);
    expect(bins.length).toBe(9);
    expect(bins[0].sampleCount).toBe(20);
    expect(bins[0].medianVelocity).toBeGreaterThan(0);
  });

  it('detects lower response plus higher current as strong wear evidence', () => {
    const report = compareMotorWear(
      makeRun('ref', 1, 1),
      makeRun('cmp', 0.72, 1.35),
      'left_drive',
      FILTER,
    );
    expect(report.confidence).toBe('high');
    expect(report.responseChangePct).toBeCloseTo(-28, 1);
    expect(report.currentChangePct).toBeCloseTo(35, 1);
    expect(report.healthScore).toBeLessThan(60);
    expect(report.diagnoses.find((d) => d.graph === 'response')?.meaning)
      .toContain('mechanical load');
  });

  it('reduces confidence when motor modes are mixed', () => {
    const report = compareMotorWear(
      makeRun('ref', 1, 1),
      makeRun('cmp', 0.9, 1, 12, ['RUN_USING_ENCODER', 'RUN_WITHOUT_ENCODER']),
      'left_drive',
      FILTER,
    );
    expect(report.modeMismatch).toBe(true);
    expect(report.confidence).toBe('low');
  });

  it('does not fabricate a conclusion without overlapping samples', () => {
    const comparison = makeRun('cmp', 1, 1);
    comparison.samples = comparison.samples.filter((s) => Math.abs(s.commandedPower ?? 0) > 0.8);
    const reference = makeRun('ref', 1, 1);
    reference.samples = reference.samples.filter((s) => Math.abs(s.commandedPower ?? 0) < 0.4);
    const report = compareMotorWear(reference, comparison, 'left_drive', FILTER);
    expect(report.responseChangePct).toBeNull();
    expect(report.healthScore).toBeNull();
    expect(report.diagnoses.find((d) => d.graph === 'power')?.severity).toBe('insufficient');
  });
});

describe('time overlays', () => {
  it('normalizes each run independently from zero to 100 percent', () => {
    const points = buildTimeOverlay(makeRun('ref', 1, 1), 'left_drive', 'velocity');
    expect(points[0].x).toBe(0);
    expect(points.at(-1)?.x).toBe(100);
  });

  it('builds a chronological first-to-latest wear history', () => {
    const history = buildWearHistory([
      makeRun('cmp', 0.8, 1.2),
      makeRun('ref', 1, 1),
    ], 'left_drive', FILTER);
    expect(history.map((p) => p.runId)).toEqual(['ref', 'cmp']);
    expect(history[0].healthScore).toBe(100);
    expect(history[1].responseChangePct).toBeLessThan(-15);
  });
});
