import { describe, expect, test } from "bun:test"
import { dedupeNearDuplicates, filterSpamAndDuplicates, isLikelySpam } from "./spamFilter.js"
import type { RawSignal } from "./types.js"

const signal = (overrides: Partial<RawSignal> = {}): RawSignal => ({
  id: "1",
  text: "just shipped a new feature for indie hackers",
  url: "https://x.com/i/web/status/1",
  createdAt: new Date().toISOString(),
  author: "@founder",
  metrics: { likes: 5, reposts: 1, replies: 2, quotes: 0, impressions: 100 },
  source: "x",
  ...overrides,
})

describe("isLikelySpam", () => {
  test("flags giveaway/RT-to-win posts", () => {
    expect(isLikelySpam("RT to win a free subscription! Giveaway ends soon")).toBe(true)
  })

  test("flags follow-for-follow posts", () => {
    expect(isLikelySpam("follow for follow, I follow back everyone")).toBe(true)
  })

  test("flags excessive hashtag stuffing", () => {
    expect(isLikelySpam("check this out #ai #saas #startup #buildinpublic #indiehackers #tech")).toBe(true)
  })

  test("flags shouting", () => {
    expect(isLikelySpam("THIS IS THE BIGGEST LAUNCH OF THE YEAR DO NOT MISS IT")).toBe(true)
  })

  test("does not flag a normal post", () => {
    expect(isLikelySpam("Just shipped a new onboarding flow, curious what indie hackers think of it")).toBe(false)
  })
})

describe("dedupeNearDuplicates", () => {
  test("collapses near-identical text to the highest-engagement representative", () => {
    const low = signal({ id: "1", text: "Check out my new AI tool for founders!", metrics: { likes: 1, reposts: 0, replies: 0, quotes: 0 } })
    const high = signal({ id: "2", text: "check out my new ai tool for founders", metrics: { likes: 50, reposts: 10, replies: 5, quotes: 2 } })
    const result = dedupeNearDuplicates([low, high])
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("2")
  })

  test("keeps distinct posts separate", () => {
    const a = signal({ id: "1", text: "Just launched my indie hacker product on Product Hunt today" })
    const b = signal({ id: "2", text: "Anyone have a good alternative to Notion for solo founders" })
    const result = dedupeNearDuplicates([a, b])
    expect(result.length).toBe(2)
  })
})

describe("filterSpamAndDuplicates", () => {
  test("removes spam and collapses duplicates in one pass", () => {
    const spam = signal({ id: "1", text: "RT to win a free giveaway right now" })
    const legit = signal({ id: "2", text: "Shipped a new dashboard for indie hackers today" })
    const result = filterSpamAndDuplicates([spam, legit])
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe("2")
  })
})
