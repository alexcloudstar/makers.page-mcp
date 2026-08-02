import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeFileAtomic, PRIVATE_FILE_MODE } from "./atomic-write.js"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "atomic-write-test-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("writeFileAtomic", () => {
  test("writes the file with the given contents", async () => {
    const filePath = path.join(dir, "draft.json")
    await writeFileAtomic(filePath, JSON.stringify({ a: 1 }), { mode: PRIVATE_FILE_MODE })
    expect(await readFile(filePath, "utf8")).toBe(JSON.stringify({ a: 1 }))
  })

  test("leaves no temp files behind after a successful write", async () => {
    const filePath = path.join(dir, "draft.json")
    await writeFileAtomic(filePath, "hello")
    const files = await readdir(dir)
    expect(files).toEqual(["draft.json"])
  })

  test("cleans up the temp file if the write fails", async () => {
    // Writing into a directory that doesn't exist makes the initial
    // writeFile call fail, exercising the cleanup path.
    const filePath = path.join(dir, "missing-subdir", "draft.json")
    await expect(writeFileAtomic(filePath, "hello")).rejects.toThrow()
    // Nothing should exist under `dir` at all: no temp file, no target.
    const files = await readdir(dir)
    expect(files).toEqual([])
  })
})
