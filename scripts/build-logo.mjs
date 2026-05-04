// Rasterizes assets/github-invertocat-black.png to public/github-invertocat.png
// for the G2 display: WHITE silhouette on SOLID BLACK, no alpha channel.
//
// G2 renders white pixels as bright green ("lit") and black as "off". The
// firmware's gray4 converter does NOT consistently respect PNG alpha — a
// transparent-background PNG can render as a fully-lit rectangle on real
// glasses (works fine in the simulator, hence why this bites). Flattening
// against black before encoding strips alpha and leaves the firmware
// nothing to misinterpret.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(__dirname, '..', 'assets', 'github-invertocat-black.png')
const OUT = path.resolve(__dirname, '..', 'public', 'github-invertocat.png')
const OUT_W = 50
const OUT_H = 50

// Pipeline order matters: flatten BEFORE negate. In sharp's pipeline,
// flattening after negate doesn't composite cleanly (transparent pixels
// stay alpha=0 with white RGB, and the resulting PNG renders as a fully
// lit rectangle on G2). Doing flatten first bakes transparency against
// white, then negate inverts the whole solid image to white-on-black —
// alpha channel cleanly stripped, anti-aliased edges preserved as greys.
// `fit: 'fill'` (vs `'contain'`) deliberately skips aspect-preserving
// padding. Sharp's flatten has a bug where fully-transparent edge rows
// added by fit:contain bypass the composite, leaving alpha=0 white pixels
// after negate that survive removeAlpha as solid white — they show up as
// a bright line on glass. The Invertocat source is 294x288 (nearly
// square), so a fill-mode 50x50 resize stretches by ~2% in one dimension,
// imperceptible at this size, and produces clean output.
await sharp(SRC)
  .resize(OUT_W, OUT_H, { fit: 'fill' })
  .flatten({ background: { r: 255, g: 255, b: 255 } })
  .negate({ alpha: false })
  .removeAlpha()
  .png()
  .toFile(OUT)

const stat = await fs.stat(OUT)
console.log(`wrote ${OUT} (${stat.size} bytes, ${OUT_W}x${OUT_H})`)
