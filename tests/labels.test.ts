import { describe, expect, it } from 'vitest';
import { splitSubscript } from '../src/diagram/labels';

describe('splitSubscript', () => {
  it('returns null when there is no underscore', () => {
    expect(splitSubscript('abc')).toBeNull();
  });

  it('returns null for a leading underscore', () => {
    expect(splitSubscript('_abc')).toBeNull();
  });

  it('returns null for a trailing underscore', () => {
    expect(splitSubscript('abc_')).toBeNull();
  });

  it('splits on a single underscore', () => {
    expect(splitSubscript('s_in')).toEqual(['s', 'in']);
  });

  it('joins later underscores with commas', () => {
    expect(splitSubscript('s_in_1')).toEqual(['s', 'in,1']);
  });
});
