import { randomUUID } from "node:crypto"
import { rename, writeFile } from "node:fs/promises"

/**
 * Writes to a temp file in the same directory and renames it into place.
 * `rename` is atomic on POSIX filesystems, so readers never observe a
 * partially-written file even if the process is killed mid-write.
 */
export const writeFileAtomic = async (
  filePath: string,
  data: string,
  options?: { mode?: number },
): Promise<void> => {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(tmpPath, data, { encoding: "utf8", mode: options?.mode })
  await rename(tmpPath, filePath)
}
