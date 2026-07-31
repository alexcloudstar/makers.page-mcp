/**
 * A tiny per-key async mutex. Callers awaiting `withLock` for the same key
 * run strictly one at a time, in call order; different keys never block
 * each other. Used to serialize read-modify-write sequences (e.g. draft
 * status transitions, token refresh) that would otherwise race across
 * concurrent tool calls.
 */
export const createKeyedLock = () => {
  const tails = new Map<string, Promise<unknown>>()

  const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const settled = run.catch(() => undefined)
    tails.set(key, settled)
    settled.finally(() => {
      if (tails.get(key) === settled) tails.delete(key)
    })
    return run
  }

  return { withLock }
}
