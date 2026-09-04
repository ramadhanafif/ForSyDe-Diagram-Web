import { describe, expect, it } from 'vitest';
import { findDefinitionOffset, splitSubscript } from '../src/diagram/labels';

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

describe('findDefinitionOffset', () => {
  const DOC = 'module M where\nf [x] = [x]\nff [x] = [x]\n  f indented\n';

  it('finds a line-start definition', () => {
    expect(findDefinitionOffset(DOC, 'f')).toBe(DOC.indexOf('\nf [x]') + 1);
  });

  it('does not match a longer name prefix', () => {
    expect(findDefinitionOffset(DOC, 'ff')).toBe(DOC.indexOf('\nff [x]') + 1);
    expect(findDefinitionOffset('ff [x] = [x]\n', 'f')).toBe(-1);
  });

  it('treats the name as plain text, never a pattern', () => {
    expect(findDefinitionOffset('f. [x] = [x]\n', 'f.')).toBe(0);
    expect(findDefinitionOffset('f [x] = [x]\n', 'f.')).toBe(-1);
    expect(findDefinitionOffset(DOC, '')).toBe(-1);
  });
});
