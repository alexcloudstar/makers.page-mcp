import { randomUUID } from "node:crypto"
import { rename, unlink, writeFile } from "node:fs/promises"

/**
 * Writes to a temp file in the same directory and renames it into place.
 * `rename` is atomic on POSIX filesystems, so readers never observe a
 * partially-written file even if the process is killed mid-write.
 *
 * The temp filename uses a `.tmp` suffix (not `.json`) so it's never picked
 * up by directory listings that filter for `.json` files (e.g.
 * `DraftStore.list`), even while a write is in flight.
 */
export const writeFileAtomic = async (
  filePath: string,
  data: string,
  options?: { mode?: number },
): Promise<void> => {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tmpPath, data, { encoding: "utf8", mode: options?.mode })
    await rename(tmpPath, filePath)
  } catch (error) {
    // Best-effort cleanup so a failed write (e.g. disk full, killed process)
    // doesn't leave a stray temp file behind. ENOENT just means the temp
    // file was never created (e.g. writeFile itself failed) — expected and
    // silent. Any other unlink failure (e.g. permissions) is unexpected and
    // worth logging so a stray temp file doesn't go unnoticed.
    await unlink(tmpPath).catch((unlinkError) => {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Failed to clean up temp file "${tmpPath}" after a failed write:`, unlinkError)
      }
    })
    throw error
  }
}
