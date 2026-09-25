import type { Point } from '../core/layoutBlock';

/** Guarded browser persistence: silent fallback when storage is missing or throws. */

export function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // private mode / quota / unavailable: persistence is best-effort
  }
}

/** Stored JSON object merged over a fallback; missing or corrupt data yields the fallback. */
export function storageGetJson<T extends object>(key: string, fallback: T): T {
  const raw = storageGet(key);
  if (raw == null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

/**
 * The autosaved working copy. One key, written whole, so two tabs overwrite
 * each other consistently (last writer wins) instead of mixing one tab's text
 * with the other's layout.
 */
export interface WorkingCopy {
  source: string;
  /** Text as of the last load, open, new or export; the unsaved-changes baseline. */
  baseline: string;
  /** Example the text came from, '' for a new or opened file. */
  example: string;
  positions: Map<string, Point>;
  /** The layout was dragged or tidied since the baseline was set. */
  layoutEdited: boolean;
}

/** Stored working copy; null when absent or corrupt. Malformed positions are dropped. */
export function storageGetWorkingCopy(key: string): WorkingCopy | null {
  const raw = storageGetJson<Record<string, unknown>>(key, {});
  const { source, baseline, example, layoutEdited } = raw;
  if (typeof source !== 'string') return null;
  const positions = new Map<string, Point>();
  const stored = raw.positions;
  if (stored && typeof stored === 'object') {
    for (const [id, p] of Object.entries(stored)) {
      const { x, y } = (p ?? {}) as Partial<Point>;
      if (Number.isFinite(x) && Number.isFinite(y)) positions.set(id, { x: x!, y: y! });
    }
  }
  return {
    source,
    baseline: typeof baseline === 'string' ? baseline : source,
    example: typeof example === 'string' ? example : '',
    positions,
    layoutEdited: layoutEdited === true,
  };
}

export function storageSetWorkingCopy(key: string, wc: WorkingCopy): void {
  storageSet(key, JSON.stringify({ ...wc, positions: Object.fromEntries(wc.positions) }));
}

/** System color-scheme preference; 'light' when matchMedia is missing or throws. */
export function preferredTheme(): 'dark' | 'light' {
  try {
    const mq =
      typeof globalThis.matchMedia === 'function'
        ? globalThis.matchMedia('(prefers-color-scheme: dark)')
        : null;
    return mq?.matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
