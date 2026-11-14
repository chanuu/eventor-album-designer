// Writes the thank you card designs and the list that compiles them into the app.
//
// Each design is described by its edges as shares of the card, measured from a printed
// sample: (left, top, right, bottom). Run with: node tools/generate-cards.mjs

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'crates/album-core/packs/eventor-cards/templates');
const list = join(root, 'crates/album-core/src/card_list.rs');

const PORTRAIT = { min: 0.6, max: 0.85 };
const LANDSCAPE = { min: 1.2, max: 1.7 };

const SANS = 'Jost';
const SERIF = 'Cormorant Garamond';
const SIGNATURE = 'Mrs Saint Delafield';
const SCRIPT = 'Great Vibes';

const INK = '#2A2A2A';
const WHITE = '#FFFFFF';

const round = (v) => Math.round(v * 10000) / 10000;
const rect = (l, t, r, b) => ({ x: round(l), y: round(t), w: round(r - l), h: round(b - t) });

/** A photo. */
const photo = (l, t, r, b, more = {}) => ({ rect_pct: rect(l, t, r, b), ...more });
/** A flat panel of colour. */
const panel = (l, t, r, b, colour, more = {}) => ({ rect_pct: rect(l, t, r, b), colour, ...more });
/** Words. `size` is the letter height as a share of the card's height. */
const words = (l, t, r, b, text, size, more = {}) => ({
  rect_pct: rect(l, t, r, b),
  text,
  size,
  font: SANS,
  colour: INK,
  align: 'center',
  ...more,
});

const MESSAGE = 'Write your message here';
const STUDIO = '{STUDIO}\nMUA | {MUA}';

const cards = [
  {
    file: '3-three-across',
    name: 'Three across',
    shape: LANDSCAPE,
    frames: [
      photo(0, 0.157, 0.317, 0.792, { bleed: true }),
      photo(0.319, 0.157, 0.681, 0.792),
      photo(0.683, 0.157, 1, 0.792, { bleed: true }),
    ],
    texts: [
      words(0.07, 0.035, 0.42, 0.145, 'Thank You', 0.085, { font: SIGNATURE, align: 'left' }),
      words(0.07, 0.86, 0.5, 0.905, '{FIRST} | {SECOND}', 0.024, { align: 'left' }),
      words(0.6, 0.86, 0.93, 0.905, '{date:dd | mm | yy}', 0.024, { align: 'right' }),
      words(0.2, 0.915, 0.8, 0.975, STUDIO, 0.014),
    ],
  },
  {
    file: '2-two-with-message-panels',
    name: 'Two photos and two message panels',
    shape: PORTRAIT,
    frames: [photo(0.131, 0.106, 0.496, 0.497), photo(0.503, 0.503, 0.868, 0.893)],
    panels: [
      panel(0.503, 0.106, 0.868, 0.497, '#DEDDDE', { z: -1 }),
      panel(0.131, 0.503, 0.496, 0.893, '#DEDDDE', { z: -1 }),
    ],
    texts: [
      words(0.52, 0.235, 0.85, 0.325, 'Beyond\nThankful', 0.034, { font: SERIF, line_height: 1.05 }),
      words(0.53, 0.333, 0.84, 0.36, MESSAGE, 0.007, { message: true }),
      words(0.15, 0.595, 0.477, 0.69, MESSAGE, 0.008, { message: true, line_height: 1.7 }),
      words(0.15, 0.692, 0.477, 0.715, 'SINCERELY,', 0.0075),
      words(0.15, 0.736, 0.477, 0.765, '{FIRST} + {SECOND}', 0.017),
      words(0.15, 0.763, 0.477, 0.785, '{date:dd | mm | yy}', 0.0125),
      words(0.15, 0.93, 0.85, 0.975, STUDIO, 0.011),
    ],
  },
  {
    file: '3-pair-over-group',
    name: 'A pair over a wide photo',
    shape: PORTRAIT,
    frames: [
      photo(0.143, 0.091, 0.497, 0.471),
      photo(0.502, 0.091, 0.855, 0.471),
      photo(0, 0.55, 1, 0.917, { bleed: true }),
    ],
    texts: [
      words(0.25, 0.008, 0.75, 0.066, 'Thank you', 0.045, { font: SIGNATURE }),
      words(0.25, 0.058, 0.75, 0.074, 'FOR BEING WITH US', 0.0075),
      words(0.2, 0.492, 0.8, 0.515, '{FIRST} & {SECOND}', 0.0155),
      words(0.2, 0.513, 0.8, 0.533, '{date:dd | mm | yyyy}', 0.0125),
      words(0.15, 0.932, 0.85, 0.978, STUDIO, 0.0105),
    ],
  },
  {
    file: '5-dark-stagger',
    name: 'Five staggered on black',
    shape: PORTRAIT,
    background: '#0B0B0B',
    frames: [
      photo(0.109, 0.17, 0.449, 0.482),
      photo(0.455, 0.055, 0.759, 0.35),
      photo(0.455, 0.355, 0.891, 0.595),
      photo(0.184, 0.487, 0.449, 0.827),
      photo(0.455, 0.6, 0.759, 0.895),
    ],
    texts: [
      words(0.12, 0.082, 0.44, 0.148, '{FIRST}\n& {SECOND}', 0.024, { font: SERIF, colour: WHITE, line_height: 1.15 }),
      words(0.184, 0.845, 0.449, 0.86, 'MEMORABLE DAY !', 0.006, { colour: WHITE }),
      words(0.184, 0.857, 0.449, 0.885, '{date:dd MON yyyy}', 0.0165, { colour: WHITE }),
      words(0.775, 0.63, 0.875, 0.895, 'Much Love', 0.06, { font: SIGNATURE, colour: WHITE, rot_deg: 270 }),
      words(0.1, 0.922, 0.9, 0.968, STUDIO, 0.0095, { colour: WHITE }),
    ],
  },
  {
    file: '5-mosaic-with-footer',
    name: 'Five in a mosaic with a footer',
    shape: LANDSCAPE,
    frames: [
      photo(0, 0, 0.393, 0.442, { bleed: true }),
      photo(0.396, 0, 0.609, 0.442, { bleed: true }),
      photo(0.612, 0, 1, 0.896, { bleed: true }),
      photo(0, 0.446, 0.169, 0.896, { bleed: true }),
      photo(0.172, 0.446, 0.609, 0.896),
    ],
    texts: [
      words(0.016, 0.014, 0.3, 0.065, 'THANK YOU !', 0.032, { font: SERIF, colour: WHITE, align: 'left' }),
      words(0.058, 0.903, 0.45, 0.945, '{FIRST} + {SECOND}', 0.023, { align: 'left' }),
      words(0.6, 0.903, 0.948, 0.945, '{date:dd . mm . yy}', 0.023, { align: 'right' }),
      words(0.25, 0.938, 0.75, 0.995, STUDIO, 0.0135),
    ],
  },
  {
    file: '4-offset-grid',
    name: 'Four in an offset grid',
    shape: PORTRAIT,
    frames: [
      photo(0.095, 0.108, 0.478, 0.462),
      photo(0.483, 0.108, 0.905, 0.497),
      photo(0.095, 0.467, 0.478, 0.895),
      photo(0.483, 0.502, 0.905, 0.895),
    ],
    texts: [
      words(0.09, 0.025, 0.45, 0.098, 'Thank you!', 0.05, { font: SIGNATURE, align: 'left' }),
      words(0.55, 0.07, 0.905, 0.084, 'MEMORABLE DAY !', 0.0055, { align: 'right' }),
      words(0.55, 0.08, 0.905, 0.104, '{date:dd MON yyyy}', 0.0155, { align: 'right' }),
      words(0.4, 0.9, 0.905, 0.928, '{FIRST} & {SECOND}', 0.0165, { align: 'right' }),
      words(0.05, 0.94, 0.95, 0.985, STUDIO, 0.0105),
    ],
  },
];

mkdirSync(out, { recursive: true });
for (const old of readdirSync(out)) rmSync(join(out, old));

const files = [];
for (const card of cards) {
  const template = {
    id: `eventor-cards/${card.file}`,
    name: card.name,
    frame_count: card.frames.length,
    spread_aspect: card.shape,
    tags: ['card'],
    frames: card.frames,
    ...(card.background ? { background: card.background } : {}),
    ...(card.panels ? { panels: card.panels } : {}),
    texts: card.texts,
  };
  if (!card.file.startsWith(`${card.frames.length}-`)) throw new Error(`${card.file} should start with its photo count`);
  writeFileSync(join(out, `${card.file}.json`), `${JSON.stringify(template, null, 2)}\n`);
  files.push(`${card.file}.json`);
}

files.sort();
const entries = files
  .map((file) => `    (\n        "${file}",\n        include_str!("../packs/eventor-cards/templates/${file}"),\n    ),`)
  .join('\n');
writeFileSync(list, `// Generated by tools/generate-cards.mjs.\npub(crate) const CARD_TEMPLATES: &[(&str, &str)] = &[\n${entries}\n];\n`);
console.log(`${files.length} card designs`);
