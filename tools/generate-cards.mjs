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
const words = (l, t, r, b, text, size, more = {}) => {
  const font = more.font ?? SANS;
  // The box must hold every line plus the text engine's inset, or the words are cut off.
  // A measured box is often just the ink, so it is grown about its middle when too small.
  if (!more.rot_deg) {
    const lines = text.split('\n').length;
    const roomy = font === SIGNATURE || font === SCRIPT ? 1.55 : 1.15;
    const needed = lines * size * (more.line_height ?? 1.2) * roomy + 0.018;
    if (b - t < needed) {
      const middle = (t + b) / 2;
      t = Math.max(0, middle - needed / 2);
      b = Math.min(1, t + needed);
      t = Math.max(0, b - needed);
    }
  }
  return {
    rect_pct: rect(l, t, r, b),
    text,
    size,
    font,
    colour: INK,
    align: 'center',
    ...more,
  };
};

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
      words(0.765, 0.63, 0.895, 0.895, 'Much Love', 0.06, { font: SIGNATURE, colour: WHITE, rot_deg: 270 }),
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

const DARK = '#1E1E1E';
const STONE = '#EDECEB';
const MIST = '#DEDDDE';
const W = { colour: WHITE };

cards.push(
  // ── Landscape ──
  {
    file: '1-half-photo-dark',
    name: 'One photo beside a dark message page',
    shape: LANDSCAPE,
    background: DARK,
    frames: [photo(0, 0, 0.5, 1, { bleed: true })],
    texts: [
      words(0.58, 0.1, 0.92, 0.26, 'Thank you', 0.09, { font: SIGNATURE, ...W }),
      words(0.54, 0.31, 0.96, 0.46, MESSAGE, 0.016, { message: true, line_height: 1.6, ...W }),
      words(0.6, 0.64, 0.9, 0.71, '{First} + {Second}', 0.03, W),
      words(0.6, 0.76, 0.9, 0.8, '{date:dd.mm.yy}', 0.017, W),
      words(0.54, 0.86, 0.96, 0.93, STUDIO, 0.015, W),
    ],
  },
  {
    file: '1-half-photo-light',
    name: 'One photo beside a white message page',
    shape: LANDSCAPE,
    frames: [photo(0, 0, 0.5, 1, { bleed: true })],
    texts: [
      words(0.58, 0.1, 0.92, 0.26, 'Thank you', 0.09, { font: SIGNATURE }),
      words(0.54, 0.32, 0.96, 0.46, MESSAGE, 0.016, { message: true, line_height: 1.6 }),
      words(0.6, 0.64, 0.9, 0.71, '{First} + {Second}', 0.03),
      words(0.6, 0.76, 0.9, 0.8, '{date:dd.mm.yy}', 0.017),
      words(0.54, 0.86, 0.96, 0.93, STUDIO, 0.015),
    ],
  },
  {
    file: '1-full-with-footer',
    name: 'One photo across the card with a footer',
    shape: LANDSCAPE,
    frames: [photo(0, 0, 1, 0.893, { bleed: true })],
    texts: [
      words(0.72, 0.03, 0.98, 0.14, 'thank you !', 0.07, { font: SIGNATURE, align: 'right', ...W }),
      words(0.02, 0.9, 0.4, 0.945, '{FIRST} & {SECOND}', 0.024, { align: 'left' }),
      words(0.6, 0.9, 0.98, 0.945, '{date:dd | mm | yy}', 0.024, { align: 'right' }),
      words(0.25, 0.94, 0.75, 0.995, STUDIO, 0.014),
    ],
  },
  {
    file: '4-lead-and-three',
    name: 'A large photo and three beside it',
    shape: LANDSCAPE,
    frames: [
      photo(0.081, 0.083, 0.46, 0.93),
      photo(0.461, 0.083, 0.691, 0.539),
      photo(0.693, 0.083, 0.919, 0.539),
      photo(0.461, 0.541, 0.919, 0.93),
    ],
    texts: [
      words(0.35, 0.005, 0.65, 0.05, 'THANK YOU', 0.032, { font: SERIF }),
      words(0.35, 0.048, 0.65, 0.07, 'FOR BEING WITH US', 0.011, { font: SERIF }),
      words(0.081, 0.935, 0.45, 0.97, '{FIRST} + {SECOND}', 0.021, { align: 'left' }),
      words(0.55, 0.935, 0.919, 0.97, '{date:dd MON yyyy}', 0.021, { align: 'right' }),
      words(0.25, 0.955, 0.75, 1, STUDIO, 0.012),
    ],
  },
  {
    file: '2-panel-between',
    name: 'Two photos with a coloured column',
    shape: LANDSCAPE,
    frames: [
      photo(0.057, 0.155, 0.414, 0.843, { border: 0.002 }),
      photo(0.502, 0, 1, 1, { bleed: true }),
    ],
    panels: [panel(0.235, 0, 0.5, 1, '#4A4148', { z: -1 })],
    texts: [
      words(0.245, 0.08, 0.49, 0.15, 'THANK YOU..!', 0.035, { font: SERIF, align: 'left', ...W }),
      words(0.425, 0.2, 0.48, 0.8, STUDIO, 0.016, { rot_deg: 270, ...W }),
      words(0.245, 0.85, 0.49, 0.92, '{First} & {Second}', 0.032, { font: SERIF, ...W }),
      words(0.057, 0.85, 0.23, 0.885, '{date:MON | dd | yyyy}', 0.016, { align: 'left' }),
    ],
  },
  {
    file: '2-much-love-centre',
    name: 'Two photos and a dark centre panel',
    shape: LANDSCAPE,
    background: DARK,
    frames: [photo(0, 0, 0.373, 1, { bleed: true }), photo(0.628, 0, 1, 1, { bleed: true })],
    texts: [
      words(0.39, 0.3, 0.61, 0.44, 'Much\nLove', 0.06, { font: SERIF, line_height: 1, ...W }),
      words(0.39, 0.51, 0.61, 0.55, '{date:dd | mm | yy}', 0.017, W),
      words(0.39, 0.57, 0.61, 0.66, MESSAGE, 0.011, { message: true, line_height: 1.5, ...W }),
      words(0.39, 0.7, 0.61, 0.8, '{First}\n& {Second}', 0.034, { font: SERIF, line_height: 1.05, ...W }),
      words(0.38, 0.9, 0.62, 0.95, STUDIO, 0.011, W),
    ],
  },

  // ── Portrait ──
  {
    file: '1-single-framed',
    name: 'One photo, framed',
    shape: PORTRAIT,
    frames: [photo(0.12, 0.1, 0.877, 0.877)],
    texts: [
      words(0.3, 0.01, 0.7, 0.065, 'Thank you', 0.05, { font: SIGNATURE }),
      words(0.3, 0.06, 0.7, 0.078, 'FOR BEING WITH US', 0.008),
      words(0.2, 0.885, 0.8, 0.905, '{FIRST} & {SECOND}', 0.016),
      words(0.3, 0.903, 0.7, 0.921, '{date:dd | mm | yy}', 0.014),
      words(0.15, 0.94, 0.85, 0.985, STUDIO, 0.011),
    ],
  },
  {
    file: '4-wide-over-three',
    name: 'A wide photo over three',
    shape: PORTRAIT,
    frames: [
      photo(0, 0, 0.947, 0.326, { bleed: true }),
      photo(0.072, 0.392, 0.473, 0.93),
      photo(0.478, 0.392, 0.927, 0.718),
      photo(0.478, 0.722, 0.927, 0.93),
    ],
    texts: [
      words(0.06, 0.345, 0.32, 0.37, '{FIRST} & {SECOND}', 0.012, { align: 'left' }),
      words(0.36, 0.333, 0.64, 0.364, 'THANK YOU', 0.024, { font: SERIF }),
      words(0.36, 0.362, 0.64, 0.375, 'FOR BEING WITH US', 0.006),
      words(0.68, 0.345, 0.94, 0.37, '{date:dd . mm . yyyy}', 0.012, { align: 'right' }),
      words(0.15, 0.94, 0.85, 0.985, STUDIO, 0.011),
    ],
  },
  {
    file: '4-dark-name-panels',
    name: 'Four photos with dark name panels',
    shape: PORTRAIT,
    frames: [
      photo(0.1, 0.1, 0.497, 0.51),
      photo(0.502, 0.208, 0.899, 0.617),
      photo(0.1, 0.62, 0.375, 0.928),
      photo(0.38, 0.62, 0.899, 0.928),
    ],
    panels: [
      panel(0.502, 0.1, 0.899, 0.205, '#3D3D3D'),
      panel(0.1, 0.514, 0.497, 0.617, '#3D3D3D'),
    ],
    texts: [
      words(0.3, 0.01, 0.7, 0.085, 'thank you !', 0.05, { font: SIGNATURE }),
      words(0.52, 0.14, 0.88, 0.165, '{FIRST} & {SECOND}', 0.015, W),
      words(0.12, 0.55, 0.48, 0.562, 'MEMORABLE DAY !', 0.005, W),
      words(0.12, 0.56, 0.48, 0.582, '{date:dd . mm . yyyy}', 0.014, W),
      words(0.15, 0.945, 0.85, 0.985, STUDIO, 0.0095),
    ],
  },
  {
    file: '3-three-and-message',
    name: 'Three photos and a message panel',
    shape: PORTRAIT,
    frames: [
      photo(0.11, 0.08, 0.497, 0.495),
      photo(0.505, 0.08, 0.893, 0.495),
      photo(0.505, 0.501, 0.893, 0.915),
    ],
    panels: [panel(0.11, 0.501, 0.497, 0.915, MIST)],
    texts: [
      words(0.13, 0.555, 0.477, 0.615, 'Much Love', 0.04, { font: SIGNATURE }),
      words(0.13, 0.64, 0.477, 0.73, MESSAGE, 0.007, { message: true, line_height: 1.9 }),
      words(0.13, 0.755, 0.477, 0.772, 'SINCERELY,', 0.0055),
      words(0.13, 0.81, 0.477, 0.84, '{FIRST} + {SECOND}', 0.017),
      words(0.13, 0.84, 0.477, 0.86, '{date:dd | mm | yy}', 0.012),
      words(0.15, 0.935, 0.85, 0.985, STUDIO, 0.0105),
    ],
  },
  {
    file: '3-three-and-message-dark',
    name: 'Three photos and a message panel, on black',
    shape: PORTRAIT,
    background: '#161616',
    frames: [
      photo(0.075, 0.068, 0.497, 0.497),
      photo(0.502, 0.068, 0.923, 0.497),
      photo(0.502, 0.502, 0.923, 0.931),
    ],
    panels: [panel(0.075, 0.502, 0.497, 0.931, '#2E2E2E')],
    texts: [
      words(0.095, 0.565, 0.477, 0.63, 'Much Love', 0.04, { font: SIGNATURE, ...W }),
      words(0.095, 0.66, 0.477, 0.74, MESSAGE, 0.007, { message: true, line_height: 1.9, ...W }),
      words(0.095, 0.76, 0.477, 0.775, 'SINCERELY,', 0.0055, W),
      words(0.095, 0.82, 0.477, 0.85, '{FIRST} + {SECOND}', 0.017, W),
      words(0.095, 0.85, 0.477, 0.872, '{date:dd . mm . yyyy}', 0.012, W),
      words(0.15, 0.945, 0.85, 0.99, STUDIO, 0.0105, W),
    ],
  },
  {
    file: '6-column-and-side',
    name: 'Six photos in a column and down the side',
    shape: PORTRAIT,
    background: STONE,
    frames: [
      photo(0.056, 0.057, 0.579, 0.246),
      photo(0.056, 0.29, 0.579, 0.474),
      photo(0.056, 0.543, 0.366, 0.884),
      photo(0.368, 0.543, 0.579, 0.884),
      photo(0.64, 0, 1, 0.461, { bleed: true }),
      photo(0.64, 0.462, 1, 0.924, { bleed: true }),
    ],
    panels: [
      panel(0.056, 0.246, 0.579, 0.29, WHITE),
      panel(0.056, 0.474, 0.579, 0.543, WHITE),
      panel(0, 0.924, 1, 1, WHITE),
    ],
    texts: [
      words(0.1, 0.257, 0.54, 0.28, '{FIRST} & {SECOND}', 0.013),
      words(0.07, 0.48, 0.3, 0.535, 'thank you !', 0.03, { font: SIGNATURE, align: 'left' }),
      words(0.36, 0.49, 0.56, 0.5, 'WEDDING DAY !', 0.0045, { align: 'right' }),
      words(0.36, 0.5, 0.56, 0.52, '{date:dd MON yyyy}', 0.012, { align: 'right' }),
      words(0.15, 0.94, 0.85, 0.985, STUDIO, 0.0105),
    ],
  },
  {
    file: '5-wedding-day',
    name: 'Five photos with a wedding day panel',
    shape: PORTRAIT,
    background: STONE,
    frames: [
      photo(0.051, 0.048, 0.242, 0.483),
      photo(0.242, 0.048, 0.57, 0.385),
      photo(0.051, 0.573, 0.57, 0.853),
      photo(0.618, 0, 1, 0.461, { bleed: true }),
      photo(0.618, 0.462, 1, 0.93, { bleed: true }),
    ],
    panels: [
      panel(0.242, 0.385, 0.57, 0.483, DARK),
      panel(0.051, 0.536, 0.57, 0.89, WHITE, { z: -1 }),
      panel(0, 0.93, 1, 1, WHITE),
    ],
    texts: [
      words(0.06, 0.37, 0.23, 0.475, 'thank\nyou', 0.035, { font: SIGNATURE, line_height: 0.9 }),
      words(0.26, 0.42, 0.55, 0.44, 'WEDDING DAY', 0.009, W),
      words(0.051, 0.5, 0.25, 0.52, '{date:dd MON yyyy}', 0.009),
      words(0.07, 0.545, 0.55, 0.565, 'WELCOME TO OUR MEMORABLE DAY !', 0.008),
      words(0.07, 0.86, 0.55, 0.885, '{FIRST} & {SECOND}', 0.013),
      words(0.15, 0.94, 0.85, 0.99, STUDIO, 0.0095),
    ],
  },
  {
    file: '5-wide-over-mosaic',
    name: 'A wide photo over four',
    shape: PORTRAIT,
    frames: [
      photo(0.097, 0.074, 0.892, 0.38),
      photo(0.097, 0.453, 0.36, 0.916),
      photo(0.367, 0.453, 0.892, 0.636),
      photo(0.367, 0.64, 0.552, 0.916),
      photo(0.558, 0.64, 0.892, 0.916),
    ],
    texts: [
      words(0.3, 0.012, 0.7, 0.045, 'THANK YOU !', 0.026, { font: SERIF }),
      words(0.3, 0.042, 0.7, 0.054, 'FOR BEING WITH US', 0.005),
      words(0.17, 0.4, 0.45, 0.44, '{FIRST}\n& {SECOND}', 0.013, { font: SERIF, align: 'left' }),
      words(0.6, 0.41, 0.8, 0.42, 'WEDDING DAY !', 0.0045),
      words(0.6, 0.418, 0.8, 0.438, '{date:dd | mm | yy}', 0.014),
      words(0.08, 0.93, 0.92, 0.985, STUDIO, 0.0095),
    ],
  },
  {
    file: '5-tall-mosaic',
    name: 'A wide photo over a mosaic with the names inside',
    shape: { min: 0.6, max: 0.68 },
    frames: [
      photo(0, 0, 1, 0.283, { bleed: true }),
      photo(0.068, 0.385, 0.58, 0.588),
      photo(0.58, 0.385, 0.93, 0.677),
      photo(0.068, 0.588, 0.418, 0.882),
      photo(0.418, 0.677, 0.93, 0.882),
    ],
    panels: [panel(0.418, 0.588, 0.58, 0.677, WHITE, { z: 1 })],
    texts: [
      words(0.12, 0.322, 0.4, 0.33, 'WEDDING DAY !', 0.0045),
      words(0.12, 0.33, 0.4, 0.345, '{date:dd MON yyyy}', 0.0095),
      words(0.6, 0.325, 0.9, 0.345, 'THANK YOU', 0.016),
      words(0.425, 0.61, 0.575, 0.66, '{FIRST}\n& {SECOND}', 0.011, { line_height: 1.25 }),
      words(0.15, 0.935, 0.85, 0.98, STUDIO, 0.0095),
    ],
  },
  {
    file: '5-overlap-with-inset',
    name: 'Five photos with an inset and a names box',
    shape: PORTRAIT,
    frames: [
      photo(0, 0, 0.585, 0.668, { bleed: true }),
      photo(0.04, 0.335, 0.335, 0.636, { z: 1, border: 0.003 }),
      photo(0.587, 0, 1, 0.463, { bleed: true }),
      photo(0.587, 0.465, 1, 0.932, { bleed: true }),
      photo(0, 0.67, 0.585, 0.932, { bleed: true }),
    ],
    panels: [panel(0.335, 0.45, 0.585, 0.668, '#000000', { z: 1, opacity: 0.55 })],
    texts: [
      words(0.36, 0.008, 0.58, 0.06, 'thank you', 0.035, { font: SIGNATURE, ...W }),
      words(0.38, 0.49, 0.53, 0.56, '{FIRST}\n&\n{SECOND}', 0.011, { line_height: 1.3, ...W }),
      words(0.38, 0.59, 0.53, 0.63, '{date:dd/mm}\n{date:yyyy}', 0.016, W),
      words(0.15, 0.94, 0.85, 0.985, STUDIO, 0.0105),
    ],
  },
  {
    file: '5-stepped-with-date-box',
    name: 'Five photos stepped, with a date box',
    shape: PORTRAIT,
    frames: [
      photo(0, 0, 0.366, 0.448, { bleed: true }),
      photo(0.366, 0.168, 0.919, 0.361),
      photo(0.087, 0.502, 0.54, 0.714),
      photo(0.087, 0.716, 0.54, 0.932),
      photo(0.544, 0.502, 0.919, 0.932),
    ],
    panels: [panel(0.086, 0.168, 0.366, 0.361, WHITE, { z: 1 })],
    texts: [
      words(0.46, 0.035, 0.9, 0.12, 'Thank You', 0.055, { font: SIGNATURE }),
      words(0.5, 0.1, 0.8, 0.118, 'For being with us', 0.008),
      words(0.1, 0.235, 0.35, 0.29, '{date:dd | mm}\n{date:yyyy}', 0.017, { line_height: 1.3 }),
      words(0.56, 0.385, 0.79, 0.407, '{FIRST} | {SECOND}', 0.012),
      words(0.5, 0.42, 0.86, 0.437, 'WELCOME TO OUR DAY', 0.006),
      words(0.15, 0.945, 0.85, 0.985, STUDIO, 0.0095),
    ],
  },
  {
    file: '4-dark-wide-and-three',
    name: 'Four photos on black',
    shape: PORTRAIT,
    background: '#000000',
    frames: [
      photo(0, 0, 1, 0.33, { bleed: true }),
      photo(0.045, 0.368, 0.39, 0.66),
      photo(0.045, 0.663, 0.39, 0.92),
      photo(0.444, 0.33, 1, 0.938, { bleed: true }),
    ],
    texts: [
      words(0.38, 0.13, 0.62, 0.18, 'DREAMS', 0.035, { font: SERIF, ...W }),
      words(0.38, 0.18, 0.62, 0.195, 'COME TRUE', 0.007, W),
      words(0.38, 0.225, 0.62, 0.24, '{date:dd MON yyyy}', 0.007, W),
      words(0.06, 0.58, 0.38, 0.63, '{First} & {Second}', 0.025, { font: SCRIPT, colour: '#F3E3A0' }),
      words(0.46, 0.55, 0.62, 0.78, 'Thank\nYou', 0.05, { font: SIGNATURE, line_height: 1.4, ...W }),
      words(0.45, 0.945, 0.99, 0.985, STUDIO, 0.008, W),
    ],
  },
  {
    file: '5-grey-panel-collage',
    name: 'Five overlapping photos with grey panels',
    shape: PORTRAIT,
    frames: [
      photo(0, 0, 0.392, 0.395, { bleed: true }),
      photo(0.042, 0.324, 0.587, 0.557, { z: 1 }),
      photo(0.629, 0, 1, 0.353, { bleed: true }),
      photo(0.689, 0.245, 0.94, 0.545, { z: 1 }),
      photo(0, 0.59, 1, 0.953, { bleed: true }),
    ],
    panels: [
      panel(0.392, 0, 0.628, 0.395, '#77757A'),
      panel(0.629, 0.353, 1, 0.59, '#3A3438'),
    ],
    texts: [
      words(0.41, 0.048, 0.61, 0.073, '{FIRST} & {SECOND}', 0.012, W),
      words(0.41, 0.078, 0.61, 0.095, '{date:MON dd yyyy}', 0.0085, W),
      words(0.42, 0.17, 0.6, 0.28, 'Thank\nyou', 0.045, { font: SIGNATURE, line_height: 1.1, ...W }),
      words(0.25, 0.65, 0.75, 0.71, MESSAGE, 0.01, { message: true, line_height: 1.5, ...W }),
      words(0.04, 0.96, 0.96, 0.995, STUDIO.replace('\n', '  -  '), 0.011, { align: 'left' }),
    ],
  },
  {
    file: '5-brown-panel-pair',
    name: 'Five photos with a panel of two',
    shape: PORTRAIT,
    frames: [
      photo(0, 0, 0.63, 0.326, { bleed: true }),
      photo(0.631, 0, 0.97, 0.377),
      photo(0.11, 0.326, 0.526, 0.906),
      photo(0.578, 0.386, 0.838, 0.609, { border: 0.0015 }),
      photo(0.578, 0.61, 0.838, 0.87, { border: 0.0015 }),
    ],
    panels: [panel(0.527, 0.326, 0.894, 0.906, '#7A6F69', { z: -1 })],
    texts: [
      words(0.1, 0.2, 0.33, 0.3, 'Thankful\nfor You', 0.035, { font: SIGNATURE, line_height: 1.2, ...W }),
      words(0.54, 0.345, 0.88, 0.37, '{FIRST} & {SECOND}', 0.013, W),
      words(0.54, 0.876, 0.88, 0.896, '{date:dd Month yyyy}', 0.009, W),
      words(0.11, 0.935, 0.6, 0.96, STUDIO.replace('\n', '  -  '), 0.009, { align: 'left' }),
    ],
  },
);

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
