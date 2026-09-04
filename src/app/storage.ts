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
