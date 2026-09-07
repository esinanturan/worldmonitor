/**
 * `localStorage` accessors that survive a browser without usable storage.
 *
 * Two distinct failure shapes, and a guard for one does not cover the other.
 * Sandboxed iframes and blocked cookies make `localStorage` THROW on access.
 * Android WebView with DOM storage disabled exposes it as NULL, so the call
 * itself is a TypeError (WORLDMONITOR-122). `typeof localStorage !== 'undefined'`
 * is true for null and protects neither, which is why every accessor here pairs
 * optional chaining with a try/catch.
 *
 * Reads degrade to "key absent" and writes to a no-op, so callers treat storage
 * as a best-effort cache rather than branching on availability.
 */

export function safeStorageGet(key: string): string | null {
  try {
    return localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeStorageSet(key: string, value: string): void {
  try {
    localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable or full */
  }
}

export function safeStorageRemove(key: string): void {
  try {
    localStorage?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
