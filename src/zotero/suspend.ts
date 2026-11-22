/**
 * Holds a setting at a fixed value while any caller is inside `run`, and puts the original back
 * only when the last overlapping caller leaves. Saving and restoring per call instead loses the
 * original when calls overlap: the second call saves the first call's temporary value and
 * restores that.
 *
 * Pure (read/write are injected) so unit tests can drive it without a Zotero global.
 */
export function suspender(read: () => unknown, write: (value: unknown) => void, held: unknown) {
  let depth = 0;
  let saved: unknown;
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (depth === 0) {
      saved = read();
      write(held);
    }
    depth++;
    try {
      return await fn();
    } finally {
      depth--;
      if (depth === 0) write(saved);
    }
  };
}
