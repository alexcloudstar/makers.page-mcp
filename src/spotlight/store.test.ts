import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Supporter } from "./types.js"
import { SpotlightStore } from "./store.js"

let spotlightsDir: string
let store: SpotlightStore

beforeEach(async () => {
  spotlightsDir = await mkdtemp(path.join(os.tmpdir(), "spotlights-test-"))
  store = new SpotlightStore({ spotlightsDir })
})

afterEach(async () => {
  await rm(spotlightsDir, { recursive: true, force: true })
})

const supporters: Supporter[] = [{ id: "1", username: "alice", interactions: ["like"] }]

describe("SpotlightStore", () => {
  test("get returns undefined when nothing has been saved yet", async () => {
    expect(await store.get("2026-08-06")).toBeUndefined()
  })

  test("save persists supporters with an empty generatedPost", async () => {
    const saved = await store.save("2026-08-06", supporters)
    expect(saved.generatedPost).toBe("")
    expect(saved.supporters).toEqual(supporters)

    const fetched = await store.get("2026-08-06")
    expect(fetched).toEqual(saved)
  })

  test("setGeneratedPost updates an existing spotlight without touching supporters", async () => {
    await store.save("2026-08-06", supporters)
    const updated = await store.setGeneratedPost("2026-08-06", "Thanks everyone!")
    expect(updated?.generatedPost).toBe("Thanks everyone!")
    expect(updated?.supporters).toEqual(supporters)
  })

  test("setGeneratedPost returns undefined when no spotlight exists yet", async () => {
    expect(await store.setGeneratedPost("2026-08-06", "Thanks!")).toBeUndefined()
  })

  test("get rejects a malformed date key rather than reading arbitrary paths", async () => {
    expect(await store.get("../../etc/passwd")).toBeUndefined()
  })

  test("save keeps entries for different dates independent", async () => {
    await store.save("2026-08-05", supporters)
    await store.save("2026-08-06", [{ id: "2", username: "bob", interactions: ["reply"] }])

    expect((await store.get("2026-08-05"))?.supporters).toEqual(supporters)
    expect((await store.get("2026-08-06"))?.supporters[0]?.username).toBe("bob")
  })
})
