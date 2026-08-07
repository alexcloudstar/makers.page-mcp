import { describe, expect, test } from "bun:test"
import { buildDefaultSpotlightPost } from "./template.js"
import type { Supporter } from "./types.js"

const supporter = (username: string): Supporter => ({
  id: username,
  username,
  interactions: ["like"],
  likeCount: 1,
  replyCount: 0,
  score: 1,
})

describe("buildDefaultSpotlightPost", () => {
  test("formats the date as a human-readable month and day", () => {
    const post = buildDefaultSpotlightPost("2026-08-06", [supporter("alice")])
    expect(post).toContain("Yesterday's supporters (August 6):")
  })

  test("mentions every supporter, one per line, in the given order", () => {
    const post = buildDefaultSpotlightPost("2026-08-06", [supporter("alice"), supporter("bob")])
    expect(post).toContain("@alice\n@bob")
  })

  test("keeps the fixed wording around the mention block", () => {
    const post = buildDefaultSpotlightPost("2026-08-06", [supporter("alice")])
    expect(post).toContain("Want more visibility on X? Start engaging")
    expect(post).toContain("No ads. No paid placements.")
    expect(post).toContain("Just giving back to the people supporting the journey")
  })
})
