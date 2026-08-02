import { describe, expect, test } from "bun:test"
import { resolveOAuthCallbackListenTarget } from "./oauth2.js"

describe("resolveOAuthCallbackListenTarget", () => {
  test("accepts 127.0.0.1 and binds to loopback", () => {
    expect(resolveOAuthCallbackListenTarget("http://127.0.0.1:8879/callback")).toEqual({
      host: "127.0.0.1",
      port: 8879,
      pathname: "/callback",
    })
  })

  test("maps localhost to 127.0.0.1 for listening", () => {
    expect(resolveOAuthCallbackListenTarget("http://localhost:8879/callback")).toEqual({
      host: "127.0.0.1",
      port: 8879,
      pathname: "/callback",
    })
  })

  test("accepts IPv6 loopback", () => {
    expect(resolveOAuthCallbackListenTarget("http://[::1]:8879/callback")).toEqual({
      host: "::1",
      port: 8879,
      pathname: "/callback",
    })
  })

  test("rejects non-loopback hosts", () => {
    expect(() => resolveOAuthCallbackListenTarget("http://0.0.0.0:8879/callback")).toThrow(
      /loopback host/,
    )
    expect(() => resolveOAuthCallbackListenTarget("http://192.168.1.10:8879/callback")).toThrow(
      /loopback host/,
    )
  })
})
