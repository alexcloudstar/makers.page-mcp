/** Minimal valid PNG header for tests that exercise media upload validation. */
export const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
])

/** Minimal valid MP4 ftyp header for tests that exercise media upload validation. */
export const MINIMAL_MP4 = (() => {
  const buf = Buffer.alloc(8)
  buf.write("ftyp", 4, "ascii")
  return buf
})()
