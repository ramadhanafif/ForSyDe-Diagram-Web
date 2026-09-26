import { describe, expect, it } from 'vitest';
import { cellWindow, downsample } from '../src/app/Timeline';

describe('cellWindow', () => {
  it('renders every cell of a short trace', () => {
    expect(cellWindow(50, 0, 200)).toEqual({ from: 0, to: 50 });
    expect(cellWindow(50, 40, 200)).toEqual({ from: 0, to: 50 });
  });

  it('renders radius cells either side of the center, clamped to the trace', () => {
    expect(cellWindow(100_000, 50_000, 200)).toEqual({ from: 49_800, to: 50_200 });
    expect(cellWindow(100_000, 10, 200)).toEqual({ from: 0, to: 210 });
    expect(cellWindow(100_000, 99_990, 200)).toEqual({ from: 99_790, to: 100_000 });
  });
});

describe('downsample', () => {
  it('keeps a short series point for point', () => {
    expect(downsample([3, 1, 2], 10)).toEqual([
      [0, 3],
      [1, 1],
      [2, 2],
    ]);
  });

  it('keeps the minimum and maximum of each bucket, in index order', () => {
    const values = Array.from({ length: 1000 }, (_, i) => (i === 700 ? 9 : i % 2));
    const pts = downsample(values, 100);
    expect(pts.length).toBeLessThanOrEqual(100);
    expect(pts).toContainEqual([700, 9]);
    expect(Math.min(...pts.map(([, v]) => v))).toBe(0);
    const idx = pts.map(([i]) => i);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
});
