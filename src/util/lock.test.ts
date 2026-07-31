import { describe, expect, test } from "bun:test"
import { createKeyedLock } from "./lock.js"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("createKeyedLock", () => {
  test("serializes calls for the same key in call order", async () => {
    const lock = createKeyedLock()
    const order: number[] = []

    const first = lock.withLock("draft-1", async () => {
      await delay(20)
      order.push(1)
    })
    const second = lock.withLock("draft-1", async () => {
      order.push(2)
    })

    await Promise.all([first, second])
    expect(order).toEqual([1, 2])
  })

  test("does not block different keys from running concurrently", async () => {
    const lock = createKeyedLock()
    const order: string[] = []

    const slow = lock.withLock("a", async () => {
      await delay(20)
      order.push("a")
    })
    const fast = lock.withLock("b", async () => {
      order.push("b")
    })

    await Promise.all([slow, fast])
    expect(order).toEqual(["b", "a"])
  })

  test("a rejected call does not poison later calls for the same key", async () => {
    const lock = createKeyedLock()

    await expect(
      lock.withLock("draft-1", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    const result = await lock.withLock("draft-1", async () => "ok")
    expect(result).toBe("ok")
  })

  test("propagates the return value of the wrapped function", async () => {
    const lock = createKeyedLock()
    const result = await lock.withLock("k", async () => 42)
    expect(result).toBe(42)
  })
})
