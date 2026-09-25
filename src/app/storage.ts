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

/** Stored node positions (JSON object of id -> {x, y}); malformed entries are dropped. */
export function storageGetPositions(key: string): Map<string, Point> {
  const positions = new Map<string, Point>();
  for (const [id, p] of Object.entries(storageGetJson<Record<string, unknown>>(key, {}))) {
    const { x, y } = (p ?? {}) as Partial<Point>;
    if (Number.isFinite(x) && Number.isFinite(y)) positions.set(id, { x: x!, y: y! });
  }
  return positions;
}

export function storageSetPositions(key: string, positions: Map<string, Point>): void {
  storageSet(key, JSON.stringify(Object.fromEntries(positions)));
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
