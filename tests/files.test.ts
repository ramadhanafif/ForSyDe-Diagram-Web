import { afterEach, describe, expect, it, vi } from 'vitest';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { BLANK_MODEL, exportFileName } from '../src/app/files';
import { storageGetPositions } from '../src/app/storage';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('blank model', () => {
  it('parses and elaborates with zero diagnostics', () => {
    const { module: mod, diagnostics } = parse(BLANK_MODEL);
    const { ir, diagnostics: elab } = elaborate(mod);
    expect([...diagnostics, ...elab]).toEqual([]);
    expect(ir?.processes.map((p) => p.name)).toEqual(['a_1']);
    expect(ir?.inputs).toEqual(['s_in']);
    expect(ir?.outputs).toEqual(['s_out']);
  });
});

describe('exportFileName', () => {
  it('names the file after the module', () => {
    expect(exportFileName(BLANK_MODEL)).toBe('Model.hs');
    expect(exportFileName('-- c\nmodule Foo.Bar where\n')).toBe('Foo.Bar.hs');
  });

  it('falls back to model.hs without a module header', () => {
    expect(exportFileName('f x = x\n')).toBe('model.hs');
  });
});

describe('storageGetPositions', () => {
  it('keeps well-formed entries and drops the rest', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{"a":{"x":1,"y":2},"b":{"x":"no","y":0},"c":5}',
      setItem: () => {},
    });
    expect(storageGetPositions('positions')).toEqual(new Map([['a', { x: 1, y: 2 }]]));
  });

  it('is empty for corrupt JSON', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{{', setItem: () => {} });
    expect(storageGetPositions('positions').size).toBe(0);
  });
});
