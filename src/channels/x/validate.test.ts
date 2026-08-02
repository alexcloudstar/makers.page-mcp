import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  mergeDraftFields,
  validateEditEligibility,
  validateXDraft,
  validateXPostText,
  weightedLength,
} from "./validate.js"
import type { Draft } from "../../drafts/types.js"

describe("weightedLength", () => {
  test("counts plain ASCII text by code point", () => {
    expect(weightedLength("hello world")).toBe(11)
  })

  test("counts surrogate-pair emoji as a single unit, unlike string.length", () => {
    const emoji = "🚀"
    expect(emoji.length).toBe(2) // UTF-16 code units
    expect(weightedLength(emoji)).toBe(1)
  })

  test("weights each URL as 23 regardless of its real length", () => {
    const url = "https://example.com/a/very/long/path/that/is/definitely/over/23/chars"
    expect(weightedLength(url)).toBe(23)
  })

  test("combines plain text and URL weighting", () => {
    const text = "check this out https://example.com/x"
    const withoutUrl = "check this out "
    expect(weightedLength(text)).toBe(withoutUrl.length + 23)
  })

  test("handles multiple URLs", () => {
    const text = "https://a.com https://b.com"
    expect(weightedLength(text)).toBe(1 /* space between */ + 23 * 2)
  })

  test("counts trailing sentence punctuation after a URL as plain text, not part of the link", () => {
    const text = "See https://example.com/foo. Thanks"
    const withoutUrl = "See . Thanks"
    expect(weightedLength(text)).toBe([...withoutUrl].length + TCO_WEIGHT_FOR_TEST)
  })

  test("counts a trailing closing paren after a URL as plain text", () => {
    const text = "(https://example.com/foo)"
    const withoutUrl = "()"
    expect(weightedLength(text)).toBe([...withoutUrl].length + TCO_WEIGHT_FOR_TEST)
  })

  test("handles a URL with a query string", () => {
    const text = "go to https://example.com/search?q=a&b=1"
    const withoutUrl = "go to "
    expect(weightedLength(text)).toBe([...withoutUrl].length + TCO_WEIGHT_FOR_TEST)
  })
})

// Mirrors the internal TCO_WEIGHT constant; kept local since it isn't exported.
const TCO_WEIGHT_FOR_TEST = 23

describe("validateXPostText", () => {
  test("rejects empty text", () => {
    const result = validateXPostText("   ", 280)
    expect(result.ok).toBe(false)
  })

  test("accepts text within the limit", () => {
    const result = validateXPostText("hello world", 280)
    expect(result).toEqual({ ok: true })
  })

  test("rejects text over the weighted limit", () => {
    const result = validateXPostText("a".repeat(281), 280)
    expect(result.ok).toBe(false)
  })

  test("a long URL does not push a short post over the limit", () => {
    const text = `check this out https://example.com/${"a".repeat(200)}`
    const result = validateXPostText(text, 280)
    expect(result).toEqual({ ok: true })
  })

  test("emoji-heavy text is not overcounted", () => {
    const text = "🚀".repeat(100)
    // 100 code points, well under 280, even though string.length would be 200.
    const result = validateXPostText(text, 280)
    expect(result).toEqual({ ok: true })
  })

  test("accepts text exactly at the limit", () => {
    const result = validateXPostText("a".repeat(280), 280)
    expect(result).toEqual({ ok: true })
  })

  test("rejects text one character over the limit", () => {
    const result = validateXPostText("a".repeat(281), 280)
    expect(result.ok).toBe(false)
  })
})

describe("validateXDraft", () => {
  test("rejects poll + media mutual exclusion", async () => {
    const result = await validateXDraft(
      {
        text: "hello",
        poll: { options: ["a", "b"], durationMinutes: 60 },
        mediaPaths: ["/tmp/a.png"],
      },
      280,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("mutually exclusive")
  })

  test("rejects poll + quote mutual exclusion", async () => {
    const result = await validateXDraft(
      {
        text: "hello",
        poll: { options: ["a", "b"], durationMinutes: 60 },
        quoteTweetId: "1",
      },
      280,
    )
    expect(result.ok).toBe(false)
  })

  test("rejects poll on multi-part threads", async () => {
    const result = await validateXDraft(
      {
        text: "one",
        parts: ["one", "two"],
        poll: { options: ["a", "b"], durationMinutes: 60 },
      },
      280,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("Polls cannot")
  })

  test("rejects parts when text !== parts[0]", async () => {
    const result = await validateXDraft(
      {
        text: "nope",
        parts: ["one", "two"],
      },
      280,
    )
    expect(result.ok).toBe(false)
  })

  test("rejects shareWithFollowers without communityId", async () => {
    const result = await validateXDraft(
      {
        text: "hello",
        shareWithFollowers: true,
      },
      280,
    )
    expect(result.ok).toBe(false)
  })

  test("rejects poll with fewer than 2 options", async () => {
    const result = await validateXDraft(
      {
        text: "hello",
        poll: { options: ["only"], durationMinutes: 60 },
      },
      280,
    )
    expect(result.ok).toBe(false)
  })

  test("rejects relative media paths", async () => {
    const result = await validateXDraft(
      {
        text: "hello",
        mediaPaths: ["relative/pic.png"],
      },
      280,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("absolute")
  })

  test("accepts an absolute existing image path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "validate-media-"))
    try {
      const filePath = path.join(dir, "pic.png")
      await writeFile(
        filePath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      )
      const result = await validateXDraft(
        {
          text: "hello",
          mediaPaths: [filePath],
        },
        280,
      )
      expect(result).toEqual({ ok: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects mixing a GIF with an image", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "validate-mix-"))
    try {
      const png = path.join(dir, "pic.png")
      const gif = path.join(dir, "anim.gif")
      await writeFile(
        png,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      )
      await writeFile(gif, Buffer.from("GIF89a", "ascii"))
      const result = await validateXDraft(
        {
          text: "hello",
          mediaPaths: [png, gif],
        },
        280,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("GIF")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects more than one video", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "validate-vids-"))
    try {
      const a = path.join(dir, "a.mp4")
      const b = path.join(dir, "b.mp4")
      const mp4Header = Buffer.alloc(8)
      mp4Header.write("ftyp", 4, "ascii")
      await writeFile(a, mp4Header)
      await writeFile(b, mp4Header)
      const result = await validateXDraft(
        {
          text: "hello",
          mediaPaths: [a, b],
        },
        280,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("one video")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects zero-byte media files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "validate-empty-"))
    try {
      const filePath = path.join(dir, "empty.png")
      await writeFile(filePath, Buffer.alloc(0))
      const result = await validateXDraft(
        {
          text: "hello",
          mediaPaths: [filePath],
        },
        280,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("empty")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects symbolic links", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "validate-symlink-"))
    try {
      const target = path.join(dir, "real.png")
      const link = path.join(dir, "link.png")
      await writeFile(
        target,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      )
      await symlink(target, link)
      const result = await validateXDraft(
        {
          text: "hello",
          mediaPaths: [link],
        },
        280,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("symbolic link")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects files whose contents do not match the extension", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "validate-magic-"))
    try {
      const filePath = path.join(dir, "fake.png")
      await writeFile(filePath, Buffer.from("not-a-png-file", "utf8"))
      const result = await validateXDraft(
        {
          text: "hello",
          mediaPaths: [filePath],
        },
        280,
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("content sniffing")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("accepts a valid thread", async () => {
    const result = await validateXDraft(
      {
        text: "one",
        parts: ["one", "two"],
      },
      280,
    )
    expect(result).toEqual({ ok: true })
  })
})

describe("mergeDraftFields", () => {
  test("text-only update on a thread syncs parts[0] for validation", () => {
    const merged = mergeDraftFields(
      {
        text: "one",
        parts: ["one", "two"],
      },
      { text: "one edited" },
    )
    expect(merged.text).toBe("one edited")
    expect(merged.parts).toEqual(["one edited", "two"])
  })
})

describe("validateEditEligibility", () => {
  const base = (overrides: Partial<Draft> = {}): Draft => ({
    id: "00000000-0000-0000-0000-000000000001",
    channel: "x",
    text: "hello",
    status: "published",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    externalId: "1",
    url: "https://x.com/i/web/status/1",
    ...overrides,
  })

  test("accepts a plain published draft", () => {
    expect(validateEditEligibility(base())).toEqual({ ok: true })
  })

  test("rejects poll drafts", () => {
    const result = validateEditEligibility(
      base({ poll: { options: ["a", "b"], durationMinutes: 60 } }),
    )
    expect(result.ok).toBe(false)
  })

  test("rejects community drafts", () => {
    const result = validateEditEligibility(base({ communityId: "c1" }))
    expect(result.ok).toBe(false)
  })

  test("rejects non-published drafts", () => {
    const result = validateEditEligibility(base({ status: "approved" }))
    expect(result.ok).toBe(false)
  })
})

