import { describe, it, expect } from 'vitest';
import {
  fieldXToScreen,
  fieldYToScreen,
  fieldToScreen,
  screenToField,
  fieldHeadingToScreen,
  isInsideField,
  computeBounds,
  fitToContent,
  poseSeriesToPath,
  clipPathToBoundary,
  DEFAULT_ZOOM_PAN,
  FIELD_HALF_IN,
} from '../src/field.js';
import { ChannelSample } from '../src/types.js';

describe('field coord <-> screen conversion', () => {
  it('field (0,0) maps to canvas centre', () => {
    const s = fieldToScreen(0, 0, 400, 400);
    expect(s.sx).toBeCloseTo(200, 5);
    expect(s.sy).toBeCloseTo(200, 5);
  });
  it('fieldXToScreen maps full bounds', () => {
    expect(fieldXToScreen(-FIELD_HALF_IN, 200)).toBeCloseTo(0, 5);
    expect(fieldXToScreen(FIELD_HALF_IN, 200)).toBeCloseTo(200, 5);
  });
  it('Y-axis inverts (positive Y maps to small screen Y)', () => {
    expect(fieldYToScreen(72, 200)).toBeCloseTo(0, 5);
    expect(fieldYToScreen(-72, 200)).toBeCloseTo(200, 5);
  });
  it('screenToField round-trips at the centre', () => {
    const f = screenToField(200, 200, 400, 400);
    expect(f.fx).toBeCloseTo(0, 5);
    expect(f.fy).toBeCloseTo(0, 5);
  });
  it('screenToField handles zoom (zoomX = 2)', () => {
    const f = screenToField(400, 400, 800, 800, { ...DEFAULT_ZOOM_PAN, zoomX: 2, zoomY: 2 });
    // At zoom = 2 the canvas shows half the field around the centre; outside
    // canvas (400px) would map past +/-72.  Just check the inverse at the
    // centre pixel maps to 0.
    expect(f.fx).toBeCloseTo(0, 5);
    expect(f.fy).toBeCloseTo(0, 5);
  });
});

describe('fieldHeadingToScreen', () => {
  it('0 rad maps to 0 deg', () => {
    expect(fieldHeadingToScreen(0)).toBeCloseTo(0, 5);
  });
  it('+pi/2 (pointing +Y field) maps to negative screen angle', () => {
    // Y-up flips to screen-down; field +Y becomes screen rotation -90.
    expect(fieldHeadingToScreen(Math.PI / 2)).toBeCloseTo(-90, 5);
  });
});

describe('isInsideField', () => {
  it('inside', () => expect(isInsideField(0, 0)).toBe(true));
  it('on boundary is inside', () => expect(isInsideField(72, 0)).toBe(true));
  it('just outside x', () => expect(isInsideField(73, 0)).toBe(false));
});

describe('computeBounds', () => {
  it('returns null for empty', () => expect(computeBounds([])).toBe(null));
  it('finds min/max across all points', () => {
    const b = computeBounds([{ x: -1, y: -2 }, { x: 5, y: 4 }, { x: 0, y: 7 }]);
    expect(b).toEqual({ minX: -1, minY: -2, maxX: 5, maxY: 7 });
  });
});

describe('fitToContent', () => {
  it('returns default zoom/pan for null bounds', () => {
    expect(fitToContent(null, 800, 800)).toEqual(DEFAULT_ZOOM_PAN);
  });
  it('computes zoom+pan such that bounds fit with margin', () => {
    const b = computeBounds([{ x: -10, y: -10 }, { x: 10, y: 10 }])!;
    const zp = fitToContent(b, 800, 800);
    expect(zp.zoomX).toBeGreaterThan(1); // we are zoomed in vs the full field
    expect(zp.fitToField).toBe(false);
    // centre of bounds should align with canvas centre => pan should cancel
    // effectively out.  Allow ±1 px tolerance.
    expect(Math.abs(zp.panX / zp.zoomX)).toBeLessThan(1.5);
    expect(Math.abs(zp.panY / zp.zoomY)).toBeLessThan(1.5);
  });
});

describe('poseSeriesToPath', () => {
  function poseSample(t: number, x: number | null, y: number | null, h: number | null = 0): ChannelSample {
    return {
      timestampMs: t,
      channelName: 'robot.pose',
      kind: 'pose',
      valueNumber: null, valueBoolean: null, valueText: null,
      valueX: x, valueY: y, valueHeading: h, note: null,
    };
  }
  it('emits finite samples and marks gaps above 500ms', () => {
    const samples = [poseSample(0, 0, 0, 0),
                     poseSample(100, 1, 1, 0),
                     poseSample(2000, 2, 2, 0)];
    const out = poseSeriesToPath(samples, 500);
    expect(out.length).toBe(3);
    expect(out[0].gap).toBe(false);
    expect(out[1].gap).toBe(false);
    expect(out[2].gap).toBe(true);
  });
  it('skips null/non-finite x or y', () => {
    const samples = [poseSample(0, 0, 0, 0), poseSample(100, null, 5, 0),
                     poseSample(200, 5, null, 0), poseSample(300, NaN, NaN)];
    const out = poseSeriesToPath(samples, 500);
    expect(out.length).toBe(1);
    expect(out[0].tMs).toBe(0);
  });
});

describe('clipPathToBoundary', () => {
  it('marks null sentinels for out-of-bounds points', () => {
    // Arrange with at least one in-bounds + three out-of-bounds points so
    // the test exercises the null sentinel path without ambiguity.
    const arr = clipPathToBoundary([
      { x: 0, y: 0 },        // inside
      { x: 100, y: 0 },      // outside (x > 72)
      { x: -90, y: 0 },      // outside (x < -72)
      { x: 0, y: 100 },      // outside (y > 72)
    ]);
    expect(arr.length).toBe(4);
    expect(arr[0]).not.toBe(null);
    expect(arr[1]).toBe(null);
    expect(arr[2]).toBe(null);
    expect(arr[3]).toBe(null);
  });
  it('keeps in-bounds points', () => {
    const arr = clipPathToBoundary([{ x: 0, y: 0 }, { x: 50, y: -40 }]);
    expect(arr.length).toBe(2);
    expect(arr[0]).not.toBe(null);
    expect(arr[1]).not.toBe(null);
  });
});
