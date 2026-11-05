// Generates the built-in layout pack from a small set of original page arrangements.
// Hand-made templates already in the pack are kept. Run: node tools/generate-layouts.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const templates = join(root, 'crates/album-core/packs/eventor-essentials/templates');
const list = join(root, 'crates/album-core/src/builtin_list.rs');

const third = 1 / 3;
const box = (x, y, w, h) => ({ x, y, w, h });
const round = (v) => Math.round(v * 10000) / 10000;

/**
 * A rectangle from its rounded edges, so neighbours share an edge exactly. Rounding the
 * width instead would let thirds overlap by a hair.
 */
function edges(left, top, right, bottom) {
  const [l, t, r, b] = [left, top, right, bottom].map(round);
  return { x: l, y: t, w: round(r - l), h: round(b - t) };
}

/** How to fill one page with a given number of photos. Fractions of that page. */
const PAGES = {
  1: [
    { key: 'full', name: 'Full page', full: true, cells: [box(0, 0, 1, 1)] },
    { key: 'framed', name: 'Framed', airy: true, cells: [box(0.14, 0.14, 0.72, 0.72)] },
    { key: 'tall', name: 'Tall', airy: true, cells: [box(0.2, 0.08, 0.6, 0.84)] },
    { key: 'wide', name: 'Wide', airy: true, cells: [box(0.08, 0.24, 0.84, 0.52)] },
  ],
  2: [
    { key: 'side', name: 'Side by side', cells: [box(0, 0, 0.5, 1), box(0.5, 0, 0.5, 1)] },
    { key: 'stack', name: 'Stacked', cells: [box(0, 0, 1, 0.5), box(0, 0.5, 1, 0.5)] },
    { key: 'big-left', name: 'Big left', cells: [box(0, 0, 0.64, 1), box(0.64, 0, 0.36, 1)] },
    { key: 'big-top', name: 'Big top', cells: [box(0, 0, 1, 0.64), box(0, 0.64, 1, 0.36)] },
    { key: 'steps', name: 'Stepped', airy: true, cells: [box(0.06, 0.08, 0.54, 0.48), box(0.4, 0.56, 0.54, 0.36)] },
  ],
  3: [
    { key: 'lead-left', name: 'Lead left', cells: [box(0, 0, 0.62, 1), box(0.62, 0, 0.38, 0.5), box(0.62, 0.5, 0.38, 0.5)] },
    { key: 'lead-right', name: 'Lead right', cells: [box(0, 0, 0.38, 0.5), box(0, 0.5, 0.38, 0.5), box(0.38, 0, 0.62, 1)] },
    { key: 'lead-top', name: 'Lead top', cells: [box(0, 0, 1, 0.6), box(0, 0.6, 0.5, 0.4), box(0.5, 0.6, 0.5, 0.4)] },
    { key: 'lead-base', name: 'Lead base', cells: [box(0, 0, 0.5, 0.4), box(0.5, 0, 0.5, 0.4), box(0, 0.4, 1, 0.6)] },
    { key: 'columns', name: 'Three columns', grid: true, cells: [box(0, 0, third, 1), box(third, 0, third, 1), box(2 * third, 0, third, 1)] },
    { key: 'rows', name: 'Three rows', grid: true, cells: [box(0, 0, 1, third), box(0, third, 1, third), box(0, 2 * third, 1, third)] },
  ],
  4: [
    { key: 'grid', name: 'Four grid', grid: true, cells: [box(0, 0, 0.5, 0.5), box(0.5, 0, 0.5, 0.5), box(0, 0.5, 0.5, 0.5), box(0.5, 0.5, 0.5, 0.5)] },
    { key: 'lead-column', name: 'Lead and column', cells: [box(0, 0, 0.66, 1), box(0.66, 0, 0.34, third), box(0.66, third, 0.34, third), box(0.66, 2 * third, 0.34, third)] },
    { key: 'lead-row', name: 'Lead and row', cells: [box(0, 0, 1, 0.64), box(0, 0.64, third, 0.36), box(third, 0.64, third, 0.36), box(2 * third, 0.64, third, 0.36)] },
    { key: 'row-lead', name: 'Row and lead', cells: [box(0, 0, third, 0.36), box(third, 0, third, 0.36), box(2 * third, 0, third, 0.36), box(0, 0.36, 1, 0.64)] },
    { key: 'pinwheel', name: 'Pinwheel', cells: [box(0, 0, 0.64, 0.38), box(0.64, 0, 0.36, 0.62), box(0.36, 0.62, 0.64, 0.38), box(0, 0.38, 0.36, 0.62)] },
  ],
};

/** How many layouts to keep for each photo count, spread evenly across the combinations. */
const KEEP = { 1: 6, 2: 12, 3: 14, 4: 16, 5: 16, 6: 16, 7: 14, 8: 14 };

function onSpread(page, side) {
  const offset = side === 'left' ? 0 : 0.5;
  return page.cells.map((c) => ({
    rect_pct: edges(offset + c.x / 2, c.y, offset + (c.x + c.w) / 2, c.y + c.h),
    ...(page.full ? { bleed: true } : {}),
  }));
}

function tagFor(left, right) {
  if (left.full || right.full) return 'hero';
  if (left.grid && right.grid) return 'grid';
  if (left.airy || right.airy) return 'airy';
  return 'clean';
}

const made = [];

for (let total = 2; total <= 8; total++) {
  const combos = [];
  for (let a = 1; a < total; a++) {
    const b = total - a;
    if (!PAGES[a] || !PAGES[b] || Math.abs(a - b) > 3) continue;
    for (const left of PAGES[a]) {
      for (const right of PAGES[b]) {
        combos.push({
          id: `${total}-${left.key}-and-${right.key}`,
          name: `${left.name} + ${right.name.toLowerCase()}`,
          tag: tagFor(left, right),
          frames: [...onSpread(left, 'left'), ...onSpread(right, 'right')],
        });
      }
    }
  }
  const step = Math.max(1, combos.length / KEEP[total]);
  for (let i = 0; i < KEEP[total] && Math.floor(i * step) < combos.length; i++) {
    made.push({ total, ...combos[Math.floor(i * step)] });
  }
}

// One page left for paper, for a single photo.
for (const side of ['left', 'right']) {
  for (const page of PAGES[1]) {
    if (side === 'right' && page.key === 'full') continue;
    if (side === 'right' && page.key === 'framed') continue;
    made.push({
      total: 1,
      id: `1-${page.key}-on-${side}`,
      name: `${page.name} on the ${side}`,
      tag: page.full ? 'hero' : 'airy',
      frames: onSpread(page, side),
    });
  }
}

// A band across the fold over smaller photos, the only frames that may cross it.
const stripCells = (count, left, width, top, height) =>
  Array.from({ length: count }, (_, i) => ({
    rect_pct: edges(left + (i * width) / count, top, left + ((i + 1) * width) / count, top + height),
  }));
for (let total = 2; total <= 8; total++) {
  const below = total - 1;
  const leftCount = Math.ceil(below / 2);
  for (const [key, label, bandTop, stripTop] of [['over', 'over', 0, 0.62], ['under', 'under', 0.38, 0]]) {
    made.push({
      total,
      id: `${total}-panorama-${key}`,
      name: `Panorama ${label} ${below}`,
      tag: 'panorama',
      frames: [
        { rect_pct: { x: 0, y: bandTop, w: 1, h: 0.62 }, bleed: true },
        ...stripCells(leftCount, 0, 0.5, stripTop, 0.38),
        ...stripCells(below - leftCount, 0.5, 0.5, stripTop, 0.38),
      ],
    });
  }
}

const shape = (frames) => frames.map((f) => JSON.stringify(f.rect_pct)).sort().join('|');
const existing = new Set(
  readdirSync(templates).map((f) => shape(JSON.parse(readFileSync(join(templates, f), 'utf8')).frames)),
);

let added = 0;
for (const layout of made) {
  const key = shape(layout.frames);
  if (existing.has(key)) continue;
  existing.add(key);
  const frames = layout.frames.map((f) => `    ${JSON.stringify(f)}`).join(',\n');
  writeFileSync(
    join(templates, `${layout.id}.json`),
    `{\n  "id": "eventor-essentials/${layout.id}",\n  "name": ${JSON.stringify(layout.name)},\n  "frame_count": ${layout.frames.length},\n  "spread_aspect": "any",\n  "tags": [${JSON.stringify(layout.tag)}],\n  "frames": [\n${frames}\n  ]\n}\n`,
  );
  added++;
}

const files = readdirSync(templates).sort();
const entries = files.map((f) => `    ("${f}", include_str!("../packs/eventor-essentials/templates/${f}")),`).join('\n');
writeFileSync(list, `// Generated by tools/generate-layouts.mjs.\npub(crate) const BUILTIN_TEMPLATES: &[(&str, &str)] = &[\n${entries}\n];\n`);

const counts = {};
for (const f of files) {
  const n = JSON.parse(readFileSync(join(templates, f), 'utf8')).frame_count;
  counts[n] = (counts[n] ?? 0) + 1;
}
console.log(`added ${added}, total ${files.length}`, counts);
