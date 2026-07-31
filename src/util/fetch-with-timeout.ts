const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Thrown for failures that happen while a request is in flight (timeout, DNS
 * failure, connection reset, etc.) — as opposed to failures that happen
 * before or after the actual network call. Callers that need to know
 * whether a mutating request (e.g. a POST) might have reached the server
 * despite the error should check for this type specifically: anything else
 * thrown by application code around `fetchWithTimeout` never touched the
 * network and is always safe to treat as "definitely didn't happen".
 */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "NetworkError"
  }
}

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
      throw new NetworkError(`Request to ${input.toString()} timed out after ${timeoutMs}ms`)
    }
    // Any other failure thrown by `fetch` itself (DNS, connection reset,
    // TLS, etc.) is likewise a network-layer failure, not a bug in our code.
    throw new NetworkError(
      `Request to ${input.toString()} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  } finally {
    clearTimeout(timer)
  }
}
