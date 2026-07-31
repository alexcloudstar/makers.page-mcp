const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Thin wrapper around `fetch` that aborts the request after `timeoutMs`
 * instead of hanging a tool call indefinitely on a stalled connection.
 */
export const fetchWithTimeout = async (
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request to ${input.toString()} timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
