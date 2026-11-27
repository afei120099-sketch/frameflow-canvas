import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const fixtureDir = path.resolve("build/runtime-fixtures");
await mkdir(fixtureDir, { recursive: true });

await writeFile(
  path.join(fixtureDir, "indicator-image.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X6bqWQAAAABJRU5ErkJggg==",
    "base64"
  )
);

// The video node only needs a File object for indicator regression coverage.
// Media decoding is outside this ShapeUtil P0; the zero-byte fixture intentionally
// exercises the node's existing unavailable-metadata state.
await writeFile(path.join(fixtureDir, "indicator-video.mp4"), Buffer.alloc(0));
