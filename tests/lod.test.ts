import { describe, expect, it } from 'vitest';
import { LOD_FAR, LOD_MID, lodFlags, lodOf } from '../src/render/SceneView';
import { ALL_ON } from './helpers/fixtures';

describe('level of detail', () => {
  it('steps down at the two thresholds', () => {
    expect(lodOf(1)).toBe('near');
    expect(lodOf(LOD_MID)).toBe('near');
    expect(lodOf(LOD_MID - 0.01)).toBe('mid');
    expect(lodOf(LOD_FAR)).toBe('mid');
    expect(lodOf(LOD_FAR - 0.01)).toBe('far');
  });

  it('counts what a level hides as switched off, so the hover card lists it', () => {
    expect(lodFlags(ALL_ON, 'near')).toBe(ALL_ON);
    expect(lodFlags(ALL_ON, 'mid')).toMatchObject({
      signals: true,
      rates: false,
      buffers: false,
      repetitions: false,
      constructors: false,
      functions: false,
    });
    expect(lodFlags(ALL_ON, 'far').signals).toBe(false);
    // a label the SHOW panel hides stays hidden at every level
    expect(lodFlags({ ...ALL_ON, signals: false }, 'mid').signals).toBe(false);
  });
});
