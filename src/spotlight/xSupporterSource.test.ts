import { describe, expect, test } from "bun:test"
import type { XClient } from "../channels/x/client.js"
import { XSupporterSource } from "./xSupporterSource.js"

const directReplyTo = (postId: string) => [{ type: "replied_to" as const, id: postId }]

describe("XSupporterSource.fetchReplyAuthors", () => {
  test("paginates through every search page", async () => {
    let calls = 0
    const stubXClient = {
      searchRecentTweets: async (_query: string, options: { nextToken?: string }) => {
        calls += 1
        if (!options.nextToken) {
          return {
            tweets: [{ id: "r1", authorId: "1", authorUsername: "alice", referencedTweets: directReplyTo("post-1") }],
            nextToken: "token-2",
          }
        }
        return { tweets: [{ id: "r2", authorId: "2", authorUsername: "bob", referencedTweets: directReplyTo("post-1") }] }
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
          { id: "r1", authorId: "1", authorUsername: "alice", referencedTweets: directReplyTo("post-1") },
          { id: "r2", authorId: "1", authorUsername: "alice", referencedTweets: directReplyTo("post-1") },
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
          { id: "r1", authorId: "owner", authorUsername: "owner", referencedTweets: directReplyTo("post-1") },
          { id: "r2", authorId: "1", authorUsername: "alice", referencedTweets: directReplyTo("post-1") },
        ],
      }),
    } as unknown as XClient

    const source = new XSupporterSource(stubXClient)
    const authors = await source.fetchReplyAuthors("post-1", "owner")

    expect(authors.map((a) => a.username)).toEqual(["alice"])
  })

  test("excludes replies-to-replies within the same conversation (not addressed to this post)", async () => {
    const stubXClient = {
      searchRecentTweets: async () => ({
        tweets: [
          // alice replied directly to the post
          { id: "r1", authorId: "1", authorUsername: "alice", referencedTweets: directReplyTo("post-1") },
          // bob replied to alice's reply, not to the post itself — should not count
          { id: "r2", authorId: "2", authorUsername: "bob", referencedTweets: directReplyTo("r1") },
        ],
      }),
    } as unknown as XClient

    const source = new XSupporterSource(stubXClient)
    const authors = await source.fetchReplyAuthors("post-1", "owner")

    expect(authors.map((a) => a.username)).toEqual(["alice"])
  })
})
