#!/usr/bin/env node
/**
 * Image seeds → static assets + manifest
 *
 * Reads every accepted image file out of `images/` at the repo root (a plain
 * folder of source images, not part of any source-code directory — just drop
 * files in there), copies each one into this app's own served static assets
 * under a new, sequentially-numbered name, and writes one seed-card record
 * per image into `seed_images.json`.
 *
 * Hand-run, not automatic/watched — re-run this whenever images/ changes.
 * The running app never reads images/ itself, only the copies + manifest
 * this script produces (rag_web.js's `/seed-images` route just serves the
 * manifest; `/static` already serves static/, gitignored like the rest of
 * it).
 *
 * The numbering is purely positional (whatever order the filesystem lists
 * images/ in) — don't treat `seed-image-04.png` etc. as a stable id across
 * regenerations; adding, removing, or reordering source files reshuffles it.
 *
 * Usage: node seed-images.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../images');
const OUT_DIR = path.resolve(__dirname, 'static/seed-images');
const MANIFEST = path.resolve(__dirname, 'seed_images.json');

const ACCEPTED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

if (!fs.existsSync(SRC_DIR)) {
  console.log(`No images/ folder found at ${SRC_DIR} — nothing to do.`);
  fs.writeFileSync(MANIFEST, '[]\n');
  process.exit(0);
}

const files = fs.readdirSync(SRC_DIR).filter((f) => ACCEPTED.has(path.extname(f).toLowerCase()));

if (!files.length) {
  console.log(`No accepted image files (.png/.jpg/.jpeg/.gif/.webp) in ${SRC_DIR}.`);
  fs.writeFileSync(MANIFEST, '[]\n');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
// Drop whatever a previous run left behind, so removed source images don't
// linger as orphaned copies.
for (const f of fs.readdirSync(OUT_DIR)) fs.unlinkSync(path.join(OUT_DIR, f));

const records = files.map((file, i) => {
  const ext = path.extname(file).toLowerCase();
  const name = `seed-image-${String(i + 1).padStart(2, '0')}${ext}`;
  fs.copyFileSync(path.join(SRC_DIR, file), path.join(OUT_DIR, name));
  return { id: `image-${i}`, kind: 'image', src: `/static/seed-images/${name}` };
});

fs.writeFileSync(MANIFEST, `${JSON.stringify(records, null, 2)}\n`);
console.log(`Copied ${records.length} image(s) → ${path.relative(process.cwd(), OUT_DIR)}`);
console.log(`Wrote ${path.relative(process.cwd(), MANIFEST)}`);
