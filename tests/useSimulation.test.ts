import { describe, expect, it } from 'vitest';
import { stepPos } from '../src/app/useSimulation';

describe('stepPos', () => {
  it('moves one step inside the trace', () => {
    expect(stepPos(2, 1, 5, true)).toBe(3);
    expect(stepPos(2, -1, 5, true)).toBe(1);
  });

  it('wraps a period at both ends, past the initial state', () => {
    expect(stepPos(5, 1, 5, true)).toBe(1);
    expect(stepPos(0, -1, 5, true)).toBe(4);
  });

  it('stops a run that does not loop at its ends', () => {
    expect(stepPos(5, 1, 5, false)).toBe(5);
    expect(stepPos(0, -1, 5, false)).toBe(0);
  });

  it('stays at the start of an empty trace', () => {
    expect(stepPos(0, 1, 0, false)).toBe(0);
    expect(stepPos(0, -1, 0, false)).toBe(0);
  });
});
