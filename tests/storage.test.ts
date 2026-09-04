import { afterEach, describe, expect, it, vi } from 'vitest';
import { preferredTheme, storageGet, storageGetJson, storageSet } from '../src/app/storage';

const FALLBACK = { signals: true, rates: false };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storageGet/storageSet', () => {
  it('reads and writes through to localStorage', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    storageSet('theme', 'dark');
    expect(storageGet('theme')).toBe('dark');
  });

  it('returns null and swallows writes when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(storageGet('theme')).toBeNull();
    expect(() => storageSet('theme', 'dark')).not.toThrow();
  });

  it('returns null when localStorage is undefined', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(storageGet('theme')).toBeNull();
    expect(() => storageSet('theme', 'dark')).not.toThrow();
  });
});

describe('storageGetJson', () => {
  it('merges stored JSON over the fallback', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{"rates":true}',
      setItem: () => {},
    });
    expect(storageGetJson('showFlags', FALLBACK)).toEqual({ signals: true, rates: true });
  });

  it('returns the fallback for corrupt JSON or absent storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'not-json{{{', setItem: () => {} });
    expect(storageGetJson('showFlags', FALLBACK)).toEqual(FALLBACK);
    vi.stubGlobal('localStorage', undefined);
    expect(storageGetJson('showFlags', FALLBACK)).toEqual(FALLBACK);
  });

  it('returns the fallback for non-object JSON', () => {
    vi.stubGlobal('localStorage', { getItem: () => '42', setItem: () => {} });
    expect(storageGetJson('showFlags', FALLBACK)).toEqual(FALLBACK);
  });
});

describe('preferredTheme', () => {
  it('follows matchMedia', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(preferredTheme()).toBe('dark');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(preferredTheme()).toBe('light');
  });

  it('defaults to light when matchMedia is undefined or throws', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(preferredTheme()).toBe('light');
    vi.stubGlobal('matchMedia', () => {
      throw new Error('denied');
    });
    expect(preferredTheme()).toBe('light');
  });
});
