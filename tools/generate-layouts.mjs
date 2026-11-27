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
    { key: 'small', name: 'Small centred', airy: true, cells: [box(0.24, 0.27, 0.52, 0.46)] },
    { key: 'corner', name: 'Upper corner', airy: true, cells: [box(0.1, 0.1, 0.58, 0.52)] },
    { key: 'low', name: 'Low and wide', airy: true, cells: [box(0.12, 0.46, 0.76, 0.42)] },
  ],
  2: [
    { key: 'side', name: 'Side by side', cells: [box(0, 0, 0.5, 1), box(0.5, 0, 0.5, 1)] },
    { key: 'stack', name: 'Stacked', cells: [box(0, 0, 1, 0.5), box(0, 0.5, 1, 0.5)] },
    { key: 'big-left', name: 'Big left', cells: [box(0, 0, 0.64, 1), box(0.64, 0, 0.36, 1)] },
    { key: 'big-top', name: 'Big top', cells: [box(0, 0, 1, 0.64), box(0, 0.64, 1, 0.36)] },
    { key: 'steps', name: 'Stepped', airy: true, cells: [box(0.06, 0.08, 0.54, 0.48), box(0.4, 0.56, 0.54, 0.36)] },
    { key: 'pair', name: 'Floating pair', airy: true, cells: [box(0.08, 0.28, 0.4, 0.44), box(0.52, 0.28, 0.4, 0.44)] },
    { key: 'pair-stack', name: 'Floating stack', airy: true, cells: [box(0.18, 0.08, 0.64, 0.4), box(0.18, 0.52, 0.64, 0.4)] },
  ],
  3: [
    { key: 'lead-left', name: 'Lead left', cells: [box(0, 0, 0.62, 1), box(0.62, 0, 0.38, 0.5), box(0.62, 0.5, 0.38, 0.5)] },
    { key: 'lead-right', name: 'Lead right', cells: [box(0, 0, 0.38, 0.5), box(0, 0.5, 0.38, 0.5), box(0.38, 0, 0.62, 1)] },
    { key: 'lead-top', name: 'Lead top', cells: [box(0, 0, 1, 0.6), box(0, 0.6, 0.5, 0.4), box(0.5, 0.6, 0.5, 0.4)] },
    { key: 'lead-base', name: 'Lead base', cells: [box(0, 0, 0.5, 0.4), box(0.5, 0, 0.5, 0.4), box(0, 0.4, 1, 0.6)] },
    { key: 'columns', name: 'Three columns', grid: true, cells: [box(0, 0, third, 1), box(third, 0, third, 1), box(2 * third, 0, third, 1)] },
    { key: 'rows', name: 'Three rows', grid: true, cells: [box(0, 0, 1, third), box(0, third, 1, third), box(0, 2 * third, 1, third)] },
    { key: 'floating-row', name: 'Floating row', airy: true, cells: [box(0.06, 0.3, 0.28, 0.4), box(0.36, 0.3, 0.28, 0.4), box(0.66, 0.3, 0.28, 0.4)] },
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
const KEEP = { 1: 6, 2: 18, 3: 20, 4: 20, 5: 18, 6: 18, 7: 14, 8: 14 };

function onSpread(page, side) {
  const offset = side === 'left' ? 0 : 0.5;
  return page.cells.map((c) => ({
    rect_pct: edges(offset + c.x / 2, c.y, offset + (c.x + c.w) / 2, c.y + c.h),
    ...(page.full ? { bleed: true } : {}),
  }));
}

/** A layout can be more than one style: a full page beside open space is both hero and airy. */
function tagFor(left, right) {
  const tags = [];
  if (left.full || right.full) tags.push('hero');
  if (left.grid && right.grid) tags.push('grid');
  if (left.airy || right.airy) tags.push('airy');
  return tags.length ? tags : ['clean'];
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

// Fine art: photos set in open paper, a full page beside a quiet one, a band across the
// fold. Whole-spread fractions, in reading order. Neighbours share an edge, so the album's
// own gap spaces them.
const art = (left, top, right, bottom, bleed = false) => ({
  rect_pct: edges(left, top, right, bottom),
  ...(bleed ? { bleed: true } : {}),
});
const fullLeft = art(0, 0, 0.5, 1, true);
const fullRight = art(0.5, 0, 1, 1, true);
// Pages that several layouts share.
const pairLeft = [art(0.068, 0.13, 0.25, 0.87), art(0.25, 0.13, 0.432, 0.87)];
const trioLeft = [art(0.023, 0.06, 0.25, 0.5), art(0.25, 0.06, 0.477, 0.5), art(0.023, 0.5, 0.477, 0.94)];
const tallAndSquareRight = [art(0.52, 0.06, 0.75, 0.94), art(0.75, 0.06, 0.977, 0.7)];
const tallAndStackRight = [art(0.52, 0.06, 0.75, 0.94), art(0.75, 0.06, 0.977, 0.5), art(0.75, 0.5, 0.977, 0.94)];
const FINE_ART = [
  { key: 'single-framed', name: 'Single framed photo', frames: [art(0.59, 0.19, 0.91, 0.81)] },
  { key: 'single-large', name: 'Single large photo', frames: [art(0.56, 0.13, 0.94, 0.87)] },
  {
    key: 'framed-and-full', name: 'Framed beside a full page',
    frames: [art(0.06, 0.13, 0.44, 0.87), fullRight],
  },
  {
    key: 'small-framed-and-full', name: 'Small framed beside a full page',
    frames: [art(0.09, 0.19, 0.41, 0.81), fullRight],
  },
  { key: 'pair-and-full', name: 'Pair beside a full page', frames: [...pairLeft, fullRight] },
  {
    key: 'across-and-column', name: 'Across the fold with a column',
    frames: [art(0, 0, 0.67, 1, true), art(0.745, 0, 0.93, 0.47, true), art(0.745, 0.47, 0.93, 1, true)],
  },
  {
    key: 'edge-across-and-side', name: 'Edge photo and a pair across the fold',
    frames: [art(0, 0.14, 0.18, 0.855, true), art(0.35, 0.14, 0.68, 0.855), art(0.68, 0.14, 0.96, 0.855)],
  },
  { key: 'full-tall-and-square', name: 'Full page with a tall and a square', frames: [fullLeft, ...tallAndSquareRight] },
  {
    key: 'split-page-and-framed', name: 'Split page beside a framed photo',
    frames: [art(0, 0, 0.25, 1, true), art(0.25, 0, 0.5, 1, true), art(0.63, 0.21, 0.866, 0.79)],
  },
  {
    key: 'small-stack-and-across', name: 'Small stack with a photo across the fold',
    frames: [art(0.08, 0.16, 0.25, 0.5), art(0.08, 0.5, 0.25, 0.84), art(0.33, 0, 1, 1, true)],
  },
  {
    key: 'steps-and-framed', name: 'Stepped pair beside a framed photo',
    frames: [art(0.053, 0.075, 0.25, 0.925), art(0.25, 0.39, 0.45, 0.925), art(0.526, 0.14, 0.977, 0.83)],
  },
  {
    key: 'stack-across-and-tall', name: 'Stack, across the fold and tall',
    frames: [
      art(0.023, 0.06, 0.25, 0.5), art(0.023, 0.5, 0.25, 0.94),
      art(0.25, 0.06, 0.75, 0.94), art(0.75, 0.06, 0.977, 0.94),
    ],
  },
  {
    key: 'framed-tall-and-stack', name: 'Framed beside a tall and a stack',
    frames: [art(0.047, 0.13, 0.455, 0.845), ...tallAndStackRight],
  },
  { key: 'trio-and-full', name: 'Three beside a full page', frames: [...trioLeft, fullRight] },
  {
    key: 'row-and-full', name: 'Row of three beside a full page',
    frames: [art(0.036, 0.21, 0.179, 0.75), art(0.179, 0.21, 0.323, 0.75), art(0.323, 0.21, 0.466, 0.75), fullRight],
  },
  {
    key: 'lead-stack-and-full', name: 'Lead and small stack beside a full page',
    frames: [art(0.087, 0.134, 0.328, 0.868), art(0.328, 0.134, 0.414, 0.5), art(0.328, 0.5, 0.414, 0.868), fullRight],
  },
  {
    key: 'pair-tall-and-framed', name: 'Pair, tall across the fold and framed',
    frames: [
      art(0.042, 0.21, 0.227, 0.795), art(0.227, 0.21, 0.412, 0.795),
      art(0.412, 0, 0.77, 1, true), art(0.77, 0.21, 0.955, 0.795),
    ],
  },
  {
    key: 'full-and-lead-stack', name: 'Full page beside a lead and stack',
    frames: [fullLeft, art(0.571, 0.21, 0.752, 0.795), art(0.752, 0.21, 0.921, 0.5), art(0.752, 0.5, 0.921, 0.795)],
  },
  {
    key: 'band', name: 'Band across the fold between stacks',
    frames: [
      art(0, 0.09, 0.25, 0.5, true), art(0, 0.5, 0.25, 0.91, true),
      art(0.25, 0.09, 0.75, 0.91),
      art(0.75, 0.09, 1, 0.5, true), art(0.75, 0.5, 1, 0.91, true),
    ],
  },
  { key: 'pair-tall-and-stack', name: 'Pair beside a tall and a stack', frames: [...pairLeft, ...tallAndStackRight] },
  { key: 'trio-tall-and-square', name: 'Three beside a tall and a square', frames: [...trioLeft, ...tallAndSquareRight] },
  {
    key: 'tall-and-mosaic', name: 'Tall beside a mosaic of five',
    frames: [
      art(0.023, 0.06, 0.258, 0.94),
      art(0.52, 0.06, 0.652, 0.5), art(0.52, 0.5, 0.652, 0.94),
      art(0.652, 0.06, 0.845, 0.94),
      art(0.845, 0.06, 0.977, 0.5), art(0.845, 0.5, 0.977, 0.94),
    ],
  },
  {
    key: 'full-tall-and-grid', name: 'Full page with a tall and a grid',
    frames: [
      fullLeft, art(0.52, 0.06, 0.722, 0.94),
      art(0.722, 0.06, 0.85, 0.5), art(0.85, 0.06, 0.977, 0.5),
      art(0.722, 0.5, 0.85, 0.94), art(0.85, 0.5, 0.977, 0.94),
    ],
  },
];
const mirror = (frame) => ({
  ...frame,
  rect_pct: edges(1 - frame.rect_pct.x - frame.rect_pct.w, frame.rect_pct.y, 1 - frame.rect_pct.x, frame.rect_pct.y + frame.rect_pct.h),
});
const crossesFold = (f) => f.rect_pct.x < 0.5 - 1e-6 && f.rect_pct.x + f.rect_pct.w > 0.5 + 1e-6;
// Photos fill frames in order, so the mirrored frames are listed left to right again.
const readingOrder = (a, b) => a.rect_pct.x - b.rect_pct.x || a.rect_pct.y - b.rect_pct.y;
for (const layout of FINE_ART) {
  // Each also the other way round, so the full page or open paper can fall on either side.
  for (const [suffix, label, frames] of [['', '', layout.frames], ['-mirrored', ' (mirrored)', layout.frames.map(mirror).sort(readingOrder)]]) {
    made.push({
      total: frames.length,
      id: `${frames.length}-fine-art-${layout.key}${suffix}`,
      name: `${layout.name}${label}`,
      // A photo across the binding is a panorama too, so it is never mistaken for a page.
      tag: frames.some(crossesFold) ? ['fineart', 'panorama'] : 'fineart',
      frames,
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
    `{\n  "id": "eventor-essentials/${layout.id}",\n  "name": ${JSON.stringify(layout.name)},\n  "frame_count": ${layout.frames.length},\n  "spread_aspect": "any",\n  "tags": ${JSON.stringify([layout.tag].flat())},\n  "frames": [\n${frames}\n  ]\n}\n`,
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
