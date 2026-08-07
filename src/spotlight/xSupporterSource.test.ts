import { describe, expect, test } from "bun:test"
import type { XClient } from "../channels/x/client.js"
import { XSupporterSource } from "./xSupporterSource.js"

describe("XSupporterSource.fetchReplyAuthors", () => {
  test("paginates through every search page", async () => {
    let calls = 0
    const stubXClient = {
      searchRecentTweets: async (_query: string, options: { nextToken?: string }) => {
        calls += 1
        if (!options.nextToken) {
          return {
            tweets: [{ id: "r1", authorId: "1", authorUsername: "alice" }],
            nextToken: "token-2",
          }
        }
        return { tweets: [{ id: "r2", authorId: "2", authorUsername: "bob" }] }
      },
    } as unknown as XClient

    const source = new XSupporterSource(stubXClient)
    const authors = await source.fetchReplyAuthors("post-1", "me")

    expect(calls).toBe(2)
    expect(authors.map((a) => a.username)).toEqual(["alice", "bob"])
  })

  test("returns one entry per reply tweet, not deduped, so repeated repliers count each time", async () => {
    const stubXClient = {
      searchRecentTweets: async () => ({
        tweets: [
          { id: "r1", authorId: "1", authorUsername: "alice" },
          { id: "r2", authorId: "1", authorUsername: "alice" },
        ],
      }),
    } as unknown as XClient

    const source = new XSupporterSource(stubXClient)
    const authors = await source.fetchReplyAuthors("post-1", "me")

    expect(authors).toHaveLength(2)
  })

  test("excludes the root tweet and the post owner's own replies", async () => {
    const stubXClient = {
      searchRecentTweets: async () => ({
        tweets: [
          { id: "post-1", authorId: "owner" },
          { id: "r1", authorId: "owner", authorUsername: "owner" },
          { id: "r2", authorId: "1", authorUsername: "alice" },
        ],
      }),
    } as unknown as XClient

    const source = new XSupporterSource(stubXClient)
    const authors = await source.fetchReplyAuthors("post-1", "owner")

    expect(authors.map((a) => a.username)).toEqual(["alice"])
  })
})
