import '@fontsource/great-vibes/latin-400.css';
import '@fontsource/pinyon-script/latin-400.css';
import '@fontsource/cormorant-garamond/latin-400.css';
import '@fontsource/cormorant-garamond/latin-400-italic.css';
import '@fontsource/cormorant-garamond/latin-500.css';
import type { Cover, ProjectSpec } from './api';

/**
 * The digital album's cover: a material drawn with its weave or grain, and the couple's
 * names, date and venue pressed into it in foil.
 *
 * Everything is drawn on a canvas, so the same picture is shown in the app and uploaded to
 * Eventor, where it becomes the first and last page of the flip album. The fonts are
 * bundled (all under the SIL Open Font License), so every computer draws the same cover.
 */

export const MATERIALS = [
  { id: 'linen', name: 'Linen', note: 'Woven, with natural slubs' },
  { id: 'leather', name: 'Leather', note: 'Soft pebbled grain' },
  { id: 'fabric', name: 'Fabric', note: 'A fine, tight book cloth' },
  { id: 'velvet', name: 'Velvet', note: 'Soft pile with a sheen' },
] as const;

export const COLOURS = [
  { id: 'sand', name: 'Sand', hex: '#cbb99c' },
  { id: 'ivory', name: 'Ivory', hex: '#e6ddcb' },
  { id: 'blush', name: 'Blush', hex: '#d6aea5' },
  { id: 'taupe', name: 'Taupe', hex: '#8c7a69' },
  { id: 'sage', name: 'Sage', hex: '#8b977f' },
  { id: 'navy', name: 'Navy', hex: '#25314a' },
  { id: 'plum', name: 'Plum', hex: '#4a2b45' },
  { id: 'burgundy', name: 'Burgundy', hex: '#5b1e28' },
  { id: 'forest', name: 'Forest', hex: '#263a2f' },
  { id: 'charcoal', name: 'Charcoal', hex: '#3a3a3d' },
  { id: 'black', name: 'Black', hex: '#1b1a1c' },
] as const;

/** Each foil is a band of metal tones, light where it catches the light. */
export const FOILS = [
  { id: 'gold', name: 'Gold', tones: ['#7d5d24', '#c9a24e', '#f6e3a1', '#d8b25e', '#8f6a2a', '#e9cd7f'] },
  { id: 'rose-gold', name: 'Rose gold', tones: ['#80493b', '#c98d7a', '#f8d7c9', '#d79c88', '#8a5444', '#e8b7a5'] },
  { id: 'silver', name: 'Silver', tones: ['#626569', '#b9bcc1', '#fbfcfd', '#c9ccd1', '#6d7075', '#e2e4e8'] },
  { id: 'blind', name: 'Pressed', tones: [] },
] as const;

export const DESIGNS = [
  { id: 'signature', name: 'Signature', note: 'Names in a flowing hand' },
  { id: 'classic', name: 'Classic', note: 'Stacked capitals' },
  { id: 'seal', name: 'Seal', note: 'Words around the date' },
  { id: 'monogram', name: 'Monogram', note: 'Initials in a ring' },
  { id: 'modern', name: 'Modern', note: 'Set low and to the left' },
] as const;

const SCRIPT = 'Great Vibes';
const SCRIPT_FINE = 'Pinyon Script';
const SERIF = 'Cormorant Garamond';

export type CoverSide = 'front' | 'back' | 'plain';

/** Names taken from an album called "Nimal & Sachini", so a new cover starts filled in. */
export function defaultCover(albumName: string): Cover {
  const [first = '', second = ''] = albumName
    .split(/\s*(?:&|\+|\band\b|\bweds\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    material: 'linen',
    colour: 'sand',
    foil: 'gold',
    design: 'signature',
    first_name: second ? first : albumName.trim().slice(0, 40),
    second_name: second,
    date: '',
    venue: '',
  };
}

export function colourOf(cover: Cover): string {
  return (COLOURS.find((c) => c.id === cover.colour) ?? COLOURS[0]).hex;
}

/** The cover is one page of the book, so it has the page's shape. */
export function coverSize(spec: ProjectSpec, longSide: number): { w: number; h: number } {
  const aspect = spec.trim_w_mm / spec.trim_h_mm;
  return aspect >= 1
    ? { w: longSide, h: Math.round(longSide / aspect) }
    : { w: Math.round(longSide * aspect), h: longSide };
}

let fontsReady: Promise<unknown> | null = null;

export function loadCoverFonts(): Promise<unknown> {
  fontsReady ??= Promise.all([
    document.fonts.load(`64px "${SCRIPT}"`),
    document.fonts.load(`64px "${SCRIPT_FINE}"`),
    document.fonts.load(`400 64px "${SERIF}"`),
    document.fonts.load(`italic 400 64px "${SERIF}"`),
    document.fonts.load(`500 64px "${SERIF}"`),
  ]).catch(() => undefined);
  return fontsReady;
}

// ─── The material ────────────────────────────────────────────────────────────

/** A small seeded generator, so a material looks the same every time it is drawn. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth random values over the surface, varying over about `cell` pixels. */
function smoothNoise(w: number, h: number, cell: number, rand: () => number): Float32Array {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const grid = Float32Array.from({ length: gw * gh }, rand);
  const out = new Float32Array(w * h);
  const ease = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < h; y++) {
    const gy = y / cell;
    const iy = Math.floor(gy);
    const fy = ease(gy - iy);
    for (let x = 0; x < w; x++) {
      const gx = x / cell;
      const ix = Math.floor(gx);
      const fx = ease(gx - ix);
      const a = grid[iy * gw + ix];
      const b = grid[iy * gw + ix + 1];
      const c = grid[(iy + 1) * gw + ix];
      const d = grid[(iy + 1) * gw + ix + 1];
      out[y * w + x] = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    }
  }
  return out;
}

/** Light and shade of a plain weave: threads passing over and under each other. */
function weave(out: Float32Array, w: number, h: number, rand: () => number, pitch: number, depth: number, slubs: number) {
  const rows = Float32Array.from({ length: Math.ceil(h / pitch) + 1 }, () => (rand() - 0.5) * slubs + (rand() < 0.06 ? slubs * 0.9 : 0));
  const cols = Float32Array.from({ length: Math.ceil(w / pitch) + 1 }, () => (rand() - 0.5) * slubs + (rand() < 0.06 ? slubs * 0.9 : 0));
  const broad = smoothNoise(w, h, pitch * 36, rand);
  for (let y = 0; y < h; y++) {
    const ty = y / pitch;
    const iy = Math.floor(ty);
    const fy = ty - iy;
    for (let x = 0; x < w; x++) {
      const tx = x / pitch;
      const ix = Math.floor(tx);
      const fx = tx - ix;
      const across = (ix + iy) & 1 ? fy : fx;
      let d = (ix + iy) & 1 ? rows[iy] : cols[ix];
      d += depth * (Math.sin(across * Math.PI) - 0.62);
      if (fx < 0.1 || fy < 0.1) d -= depth * 0.6;
      d += (broad[y * w + x] - 0.5) * slubs * 0.8 + (rand() - 0.5) * depth * 0.5;
      out[y * w + x] = d;
    }
  }
}

/** Pebbled leather: rounded cells with creases between them, lit from the top left. */
function pebble(out: Float32Array, w: number, h: number, rand: () => number) {
  const cell = Math.max(4, w / 95);
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const px = Float32Array.from({ length: gw * gh }, rand);
  const py = Float32Array.from({ length: gw * gh }, rand);
  const height = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cell);
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / cell);
      let f1 = Infinity;
      let f2 = Infinity;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const gx = cx + i;
          const gy = cy + j;
          if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
          const k = gy * gw + gx;
          const dx = (gx + px[k]) * cell - x;
          const dy = (gy + py[k]) * cell - y;
          const dist = dx * dx + dy * dy;
          if (dist < f1) { f2 = f1; f1 = dist; } else if (dist < f2) f2 = dist;
        }
      }
      height[y * w + x] = Math.min(1, (Math.sqrt(f2) - Math.sqrt(f1)) / cell * 1.8);
    }
  }
  const mottle = smoothNoise(w, h, cell * 14, rand);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const slope = height[i - w - 1] - height[i + w + 1];
      out[i] = slope * 0.32 + (height[i] - 0.6) * 0.07 + (mottle[i] - 0.5) * 0.09 + (rand() - 0.5) * 0.025;
    }
  }
}

function pile(out: Float32Array, w: number, h: number, rand: () => number) {
  const broad = smoothNoise(w, h, Math.max(8, w / 9), rand);
  const fine = smoothNoise(w, h, Math.max(2, w / 160), rand);
  for (let i = 0; i < out.length; i++) {
    out[i] = (broad[i] - 0.5) * 0.16 + (fine[i] - 0.5) * 0.05 + (rand() - 0.5) * 0.035;
  }
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function context(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('This computer could not draw the cover.');
  return ctx;
}

type Surface = { texture: HTMLCanvasElement; relief: HTMLCanvasElement };
const surfaces = new Map<string, Surface>();
const MAX_SURFACES = 8;

/** The material's colour with its texture, and the texture alone in grey for the foil. */
function surface(material: string, hex: string, w: number, h: number): Surface {
  const key = `${material}|${hex}|${w}x${h}`;
  const known = surfaces.get(key);
  if (known) return known;

  const rand = seeded(material.length * 7919 + w * 31 + h);
  const shade = new Float32Array(w * h);
  const scale = Math.max(w, h);
  if (material === 'leather') pebble(shade, w, h, rand);
  else if (material === 'velvet') pile(shade, w, h, rand);
  else if (material === 'fabric') weave(shade, w, h, rand, Math.max(1.6, scale / 720), 0.07, 0.035);
  else weave(shade, w, h, rand, Math.max(2, scale / 520), 0.11, 0.05);

  const texture = canvas(w, h);
  const relief = canvas(w, h);
  const colour = context(texture).createImageData(w, h);
  const grey = context(relief).createImageData(w, h);
  const [r, g, b] = rgb(hex);
  for (let i = 0; i < shade.length; i++) {
    const d = shade[i];
    const o = i * 4;
    // Dark colours need some light added, or their texture cannot be seen at all.
    colour.data[o] = r * (1 + d * 1.5) + d * 55;
    colour.data[o + 1] = g * (1 + d * 1.5) + d * 55;
    colour.data[o + 2] = b * (1 + d * 1.5) + d * 55;
    colour.data[o + 3] = 255;
    const v = 128 + d * 420;
    grey.data[o] = v;
    grey.data[o + 1] = v;
    grey.data[o + 2] = v;
    grey.data[o + 3] = 255;
  }
  context(texture).putImageData(colour, 0, 0);
  context(relief).putImageData(grey, 0, 0);

  const made = { texture, relief };
  surfaces.set(key, made);
  if (surfaces.size > MAX_SURFACES) surfaces.delete(surfaces.keys().next().value as string);
  return made;
}

/** Light falling across a board: from the top left, with rounded edges and the hinge. */
function light(ctx: CanvasRenderingContext2D, material: string, w: number, h: number, side: CoverSide) {
  const glow = ctx.createRadialGradient(w * 0.22, h * 0.12, 0, w * 0.22, h * 0.12, Math.hypot(w, h));
  glow.addColorStop(0, 'rgb(255 255 255 / 11%)');
  glow.addColorStop(0.45, 'rgb(255 255 255 / 0%)');
  glow.addColorStop(1, 'rgb(0 0 0 / 24%)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  if (material === 'velvet') {
    const sheen = ctx.createLinearGradient(0, 0, w, h);
    sheen.addColorStop(0.2, 'rgb(255 255 255 / 0%)');
    sheen.addColorStop(0.42, 'rgb(255 255 255 / 13%)');
    sheen.addColorStop(0.62, 'rgb(255 255 255 / 0%)');
    sheen.addColorStop(1, 'rgb(0 0 0 / 22%)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);
  }
  if (material === 'leather') {
    const gloss = ctx.createRadialGradient(w * 0.35, h * 0.28, 0, w * 0.35, h * 0.28, w * 0.7);
    gloss.addColorStop(0, 'rgb(255 255 255 / 8%)');
    gloss.addColorStop(1, 'rgb(255 255 255 / 0%)');
    ctx.fillStyle = gloss;
    ctx.fillRect(0, 0, w, h);
  }

  // The board's wrapped edges are rounded, so they catch light at the top and fall away below.
  const e = Math.max(2, Math.max(w, h) * 0.009);
  const edge = (x0: number, y0: number, x1: number, y1: number, colour: string) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, colour);
    g.addColorStop(1, 'rgb(0 0 0 / 0%)');
    return g;
  };
  ctx.fillStyle = edge(0, 0, 0, e, 'rgb(255 255 255 / 16%)');
  ctx.fillRect(0, 0, w, e);
  ctx.fillStyle = edge(0, h, 0, h - e, 'rgb(0 0 0 / 30%)');
  ctx.fillRect(0, h - e, w, e);
  ctx.fillStyle = edge(0, 0, e, 0, 'rgb(255 255 255 / 8%)');
  ctx.fillRect(0, 0, e, h);
  ctx.fillStyle = edge(w, 0, w - e, 0, 'rgb(0 0 0 / 24%)');
  ctx.fillRect(w - e, 0, e, h);

  if (side === 'plain') return;
  // The hinge: a groove pressed in beside the spine, which is on the left of the front.
  const at = side === 'front' ? w * 0.058 : w * 0.942;
  const half = Math.max(3, w * 0.012);
  const groove = ctx.createLinearGradient(at - half, 0, at + half, 0);
  const stops: [number, string][] = [
    [0, 'rgb(0 0 0 / 0%)'],
    [0.38, 'rgb(0 0 0 / 26%)'],
    [0.5, 'rgb(0 0 0 / 38%)'],
    [0.62, 'rgb(255 255 255 / 12%)'],
    [1, 'rgb(255 255 255 / 0%)'],
  ];
  for (const [at2, c] of side === 'front' ? stops : stops.map(([s, c2]) => [1 - s, c2] as [number, string])) groove.addColorStop(at2, c);
  ctx.fillStyle = groove;
  ctx.fillRect(at - half, 0, half * 2, h);
  const spine = side === 'front' ? ctx.createLinearGradient(0, 0, at, 0) : ctx.createLinearGradient(w, 0, at, 0);
  spine.addColorStop(0, 'rgb(0 0 0 / 20%)');
  spine.addColorStop(1, 'rgb(0 0 0 / 0%)');
  ctx.fillStyle = spine;
  side === 'front' ? ctx.fillRect(0, 0, at, h) : ctx.fillRect(at, 0, w - at, h);
}

// ─── The words ───────────────────────────────────────────────────────────────

type Type = { family: string; size: number; italic?: boolean; weight?: number; tracking?: number; caps?: boolean };

function setType(ctx: CanvasRenderingContext2D, t: Type) {
  ctx.font = `${t.italic ? 'italic ' : ''}${t.weight ?? 400} ${t.size}px "${t.family}"`;
  (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${(t.tracking ?? 0) * t.size}px`;
}

const shown = (text: string, t: Type) => (t.caps ? text.toUpperCase() : text);

/** The type made smaller until the words fit the width. */
function fitted(ctx: CanvasRenderingContext2D, text: string, t: Type, maxWidth: number): Type {
  let size = t.size;
  for (let i = 0; i < 40; i++) {
    setType(ctx, { ...t, size });
    if (ctx.measureText(shown(text, t)).width <= maxWidth) break;
    size *= 0.95;
  }
  return { ...t, size };
}

function write(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, t: Type, align: CanvasTextAlign = 'center') {
  if (!text) return;
  setType(ctx, t);
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  // Letter spacing is added after each letter, so centred words sit half a space to the left.
  const nudge = align === 'center' ? ((t.tracking ?? 0) * t.size) / 2 : 0;
  ctx.fillText(shown(text, t), x + nudge, y);
}

/** Words set around a circle: over the top reading clockwise, or along the bottom. */
function arc(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, r: number, t: Type, top: boolean) {
  const words = shown(text, t);
  setType(ctx, { ...t, tracking: 0 });
  const space = (t.tracking ?? 0) * t.size;
  const widths = [...words].map((ch) => ctx.measureText(ch).width + space);
  const total = widths.reduce((a, b) => a + b, 0) - space;
  ctx.textAlign = 'center';
  ctx.textBaseline = top ? 'alphabetic' : 'top';
  let angle = top ? -Math.PI / 2 - total / (2 * r) : Math.PI / 2 + total / (2 * r);
  [...words].forEach((ch, i) => {
    const half = (widths[i] - space) / 2 / r;
    angle += top ? half : -half;
    ctx.save();
    ctx.translate(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    ctx.rotate(top ? angle + Math.PI / 2 : angle - Math.PI / 2);
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    angle += top ? half + space / r : -(half + space / r);
  });
}

function rule(ctx: CanvasRenderingContext2D, cx: number, y: number, width: number, h: number) {
  ctx.fillRect(cx - width / 2, y, width, Math.max(1, h * 0.0017));
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
  ctx.fill();
}

/** Lays out the words of each design, in white on a clear canvas. */
function words(ctx: CanvasRenderingContext2D, cover: Cover, w: number, h: number, side: CoverSide) {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  const first = cover.first_name.trim();
  const second = cover.second_name.trim();
  const date = cover.date.trim();
  const venue = cover.venue.trim();
  const names = first && second ? `${first} & ${second}` : first || second;
  // Lettering is sized from the shorter way across, so it sits the same on any shape of album.
  const unit = Math.min(h, w * 1.25) * 1.24;
  // The visual centre is right of the middle, since the hinge takes the left edge.
  const cx = side === 'front' ? w * 0.527 : w / 2;
  const room = w * 0.74;

  if (side === 'back') {
    const initials = [first[0], second[0]].filter(Boolean).join(' & ');
    write(ctx, initials, cx, h * 0.9, { family: SERIF, size: unit * 0.032, italic: true, tracking: 0.08 });
    return;
  }
  if (side === 'plain') return;

  const small: Type = { family: SERIF, size: unit * 0.026, weight: 500, tracking: 0.32, caps: true };
  const details = (y: number, gap: number, align: CanvasTextAlign = 'center', x = cx) => {
    if (date) write(ctx, date, x, y, fitted(ctx, date, small, room), align);
    if (venue) write(ctx, venue, x, date ? y + gap : y, fitted(ctx, venue, { ...small, tracking: 0.26 }, room), align);
  };

  switch (cover.design) {
    case 'classic': {
      const caps: Type = { family: SERIF, size: unit * 0.07, tracking: 0.14, caps: true };
      if (first && second) {
        write(ctx, first, cx, h * 0.42, fitted(ctx, first, caps, room));
        write(ctx, '&', cx, h * 0.5, { family: SERIF, size: unit * 0.062, italic: true });
        write(ctx, second, cx, h * 0.585, fitted(ctx, second, caps, room));
      } else {
        write(ctx, names, cx, h * 0.5, fitted(ctx, names, caps, room));
      }
      details(h * 0.7, unit * 0.045);
      break;
    }
    case 'seal': {
      const r = Math.min(w, h) * 0.29;
      const cy = h * 0.48;
      const ring: Type = { family: SERIF, size: unit * 0.031, weight: 500, tracking: 0.3, caps: true };
      // Arc text cannot shrink to fit a line, so long words get smaller type instead.
      const arcType = (text: string) => ({ ...ring, size: Math.min(ring.size, (Math.PI * r * 0.9) / Math.max(1, text.length * 1.0)) });
      arc(ctx, names, cx, cy, r, arcType(names), true);
      if (venue) arc(ctx, venue, cx, cy, r, arcType(venue), false);
      diamond(ctx, cx - r - unit * 0.004, cy - unit * 0.004, unit * 0.007);
      diamond(ctx, cx + r + unit * 0.004, cy - unit * 0.004, unit * 0.007);
      const parts = date.split(/\s*[./\-\s]\s*/).filter(Boolean);
      const big: Type = { family: SERIF, size: unit * 0.07, tracking: 0.06 };
      if (parts.length === 3) {
        const lineH = big.size * 1.02;
        parts.forEach((part, i) => write(ctx, part, cx, cy + (i - 1) * lineH + big.size * 0.33, big));
        rule(ctx, cx, cy - lineH * 0.55, r * 0.22, h);
        rule(ctx, cx, cy + lineH * 0.5, r * 0.22, h);
      } else if (date) {
        write(ctx, date, cx, cy + big.size * 0.2, fitted(ctx, date, { ...big, size: big.size * 0.6 }, r * 1.4));
      } else if (first || second) {
        write(ctx, [first[0], second[0]].filter(Boolean).join('&'), cx, cy + unit * 0.035, { family: SCRIPT, size: unit * 0.11 });
      }
      break;
    }
    case 'monogram': {
      const cy = h * 0.42;
      const r = unit * 0.15;
      ctx.lineWidth = Math.max(1, unit * 0.0028);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, unit * 0.0014);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.93, 0, Math.PI * 2);
      ctx.stroke();
      const initials = [first[0], second[0]].filter(Boolean);
      if (initials.length === 2) {
        const letter: Type = { family: SCRIPT_FINE, size: unit * 0.14 };
        write(ctx, initials[0], cx - r * 0.34, cy + r * 0.2, letter);
        write(ctx, '&', cx + r * 0.02, cy + r * 0.24, { family: SERIF, size: unit * 0.045, italic: true });
        write(ctx, initials[1], cx + r * 0.38, cy + r * 0.3, letter);
      } else if (initials.length === 1) {
        write(ctx, initials[0], cx, cy + r * 0.28, { family: SCRIPT_FINE, size: unit * 0.17 });
      }
      write(ctx, names, cx, h * 0.68, fitted(ctx, names, { ...small, size: unit * 0.03, tracking: 0.28 }, room));
      details(h * 0.735, unit * 0.04);
      break;
    }
    case 'modern': {
      const x = w * 0.15;
      const caps: Type = { family: SERIF, size: unit * 0.058, weight: 500, tracking: 0.08, caps: true };
      const width = w * 0.74;
      if (first && second) {
        write(ctx, first, x, h * 0.69, fitted(ctx, first, caps, width), 'left');
        write(ctx, `& ${second}`, x, h * 0.755, fitted(ctx, `& ${second}`, caps, width), 'left');
      } else {
        write(ctx, names, x, h * 0.755, fitted(ctx, names, caps, width), 'left');
      }
      ctx.fillRect(x, h * 0.79, w * 0.08, Math.max(1, h * 0.0017));
      const line = [date, venue].filter(Boolean).join('  ·  ');
      if (line) write(ctx, line, x, h * 0.835, fitted(ctx, line, { ...small, tracking: 0.28 }, width), 'left');
      break;
    }
    default: {
      // Signature: the names written by hand, with the date and venue set quietly below.
      const script: Type = { family: SCRIPT, size: unit * 0.115 };
      const one = fitted(ctx, names, script, room);
      let below: number;
      if (one.size >= script.size * 0.72 || !(first && second)) {
        write(ctx, names, cx, h * 0.48, one);
        below = h * 0.48 + one.size * 0.5;
      } else {
        write(ctx, first, cx, h * 0.41, fitted(ctx, first, script, room));
        write(ctx, '&', cx, h * 0.41 + script.size * 0.62, { family: SCRIPT, size: script.size * 0.6 });
        write(ctx, second, cx, h * 0.41 + script.size * 1.3, fitted(ctx, second, script, room));
        below = h * 0.41 + script.size * 1.8;
      }
      if (date || venue) {
        rule(ctx, cx, below, w * 0.05, h);
        details(below + unit * 0.06, unit * 0.04);
      }
    }
  }
}

// ─── Foil ────────────────────────────────────────────────────────────────────

function tinted(mask: HTMLCanvasElement, colour: string): HTMLCanvasElement {
  const c = canvas(mask.width, mask.height);
  const ctx = context(c);
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

function shaded(hex: string, by: number): string {
  const [r, g, b] = rgb(hex);
  return `rgb(${r * by} ${g * by} ${b * by})`;
}

/** Presses the words into the board and fills them with foil that picks up the weave. */
function press(ctx: CanvasRenderingContext2D, mask: HTMLCanvasElement, cover: Cover, relief: HTMLCanvasElement) {
  const { width: w, height: h } = mask;
  const s = Math.max(1, Math.max(w, h) * 0.0016);
  const foil = FOILS.find((f) => f.id === cover.foil) ?? FOILS[0];
  const blind = foil.tones.length === 0;

  // The lower lip of the impression catches the light.
  ctx.save();
  ctx.filter = `blur(${s * 0.6}px)`;
  ctx.globalAlpha = blind ? 0.5 : 0.35;
  ctx.drawImage(tinted(mask, '#fff'), 0, s * 1.1);
  ctx.restore();

  const metal = canvas(w, h);
  const m = context(metal);
  if (blind) {
    m.fillStyle = shaded(colourOf(cover), 0.72);
    m.fillRect(0, 0, w, h);
  } else {
    const band = m.createLinearGradient(0, 0, w * 0.55, h);
    const tones = [...foil.tones, ...foil.tones, foil.tones[0]];
    tones.forEach((tone, i) => band.addColorStop(i / (tones.length - 1), tone));
    m.fillStyle = band;
    m.fillRect(0, 0, w, h);
  }
  m.globalCompositeOperation = 'overlay';
  m.globalAlpha = blind ? 0.8 : 0.45;
  m.drawImage(relief, 0, 0);
  m.globalAlpha = 1;
  m.globalCompositeOperation = 'destination-in';
  m.drawImage(mask, 0, 0);

  // Shadow inside the top edge of each letter, where the impression's wall faces away.
  const outside = canvas(w, h);
  const o = context(outside);
  o.fillStyle = '#000';
  o.fillRect(0, 0, w, h);
  o.globalCompositeOperation = 'destination-out';
  o.drawImage(mask, 0, 0);
  m.globalCompositeOperation = 'source-atop';
  m.filter = `blur(${s}px)`;
  m.globalAlpha = blind ? 0.75 : 0.5;
  m.drawImage(outside, 0, s * 1.3);
  m.filter = 'none';
  m.globalAlpha = 1;

  ctx.drawImage(metal, 0, 0);
}

export type DrawnCover = { canvas: HTMLCanvasElement; foil: HTMLCanvasElement };

/** Draws one side of the cover. The fonts must be loaded first, with `loadCoverFonts`. */
export function drawCover(cover: Cover, w: number, h: number, side: CoverSide): DrawnCover {
  const material = MATERIALS.some((m) => m.id === cover.material) ? cover.material : 'linen';
  const { texture, relief } = surface(material, colourOf(cover), w, h);
  const out = canvas(w, h);
  const ctx = context(out);
  ctx.drawImage(texture, 0, 0);
  light(ctx, material, w, h, side);

  const foil = canvas(w, h);
  words(context(foil), cover, w, h, side);
  press(ctx, foil, cover, relief);
  return { canvas: out, foil };
}

function encoded(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The cover could not be prepared.'))), type, quality);
  });
}

export async function coverBlob(c: HTMLCanvasElement, type = 'image/jpeg'): Promise<Blob> {
  return encoded(c, type, 0.9);
}

/** The size the cover is uploaded at: as sharp as the published spreads. */
export const PUBLISHED_COVER_PX = 1800;

/** The front and back of the cover, as JPEG files for the digital album. */
export async function coverJpegs(cover: Cover, spec: ProjectSpec): Promise<{ front: Uint8Array; back: Uint8Array }> {
  await loadCoverFonts();
  const { w, h } = coverSize(spec, PUBLISHED_COVER_PX);
  const [front, back] = await Promise.all(
    (['front', 'back'] as const).map(async (side) => {
      const blob = await coverBlob(drawCover(cover, w, h, side).canvas);
      return new Uint8Array(await blob.arrayBuffer());
    }),
  );
  return { front, back };
}
