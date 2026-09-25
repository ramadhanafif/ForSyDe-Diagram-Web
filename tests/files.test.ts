import { afterEach, describe, expect, it, vi } from 'vitest';
import { elaborate } from '../src/core/elaborate';
import { parse } from '../src/core/parser';
import { BLANK_MODEL, exportFileName } from '../src/app/files';
import { storageGetWorkingCopy, storageSetWorkingCopy } from '../src/app/storage';

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

describe('working copy storage', () => {
  it('round-trips source, baseline, example and positions under one key', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    const wc = {
      source: 's',
      baseline: 'b',
      example: 'e',
      positions: new Map([['a', { x: 1, y: 2 }]]),
      layoutEdited: true,
    };
    storageSetWorkingCopy('wc', wc);
    expect([...store.keys()]).toEqual(['wc']);
    expect(storageGetWorkingCopy('wc')).toEqual(wc);
  });

  it('keeps well-formed positions and drops the rest', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{"source":"s","positions":{"a":{"x":1,"y":2},"b":{"x":"no","y":0},"c":5}}',
      setItem: () => {},
    });
    expect(storageGetWorkingCopy('wc')?.positions).toEqual(new Map([['a', { x: 1, y: 2 }]]));
  });

  it('is null for corrupt JSON or a missing source', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{{', setItem: () => {} });
    expect(storageGetWorkingCopy('wc')).toBeNull();
    vi.stubGlobal('localStorage', { getItem: () => '{"positions":{}}', setItem: () => {} });
    expect(storageGetWorkingCopy('wc')).toBeNull();
  });
});
