import type { CardDetails, LayoutOption, Spread, SpreadDesign } from './api';

/** Thank you cards: their sizes, and how the couple's details become a card's words. */

/** Short side by long side, in inches. */
export const CARD_SIZES: [number, number][] = [[4, 6], [5, 7], [5, 8], [6, 8]];

export type Orientation = 'portrait' | 'landscape';

/** What a card's message says until the studio writes its own. The export warns about it. */
export const MESSAGE_PLACEHOLDER = 'Write your message here';

export const NO_DETAILS: CardDetails = { first_name: '', second_name: '', date: '', venue: '', mua: '', studio: '' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A date typed as 2026-10-24, written the way a design asks: `dd | mm | yy`, `dd MON yyyy`. */
function writeDate(iso: string, format: string): string {
  const [, year, month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim()) ?? [];
  if (!year) return iso.trim();
  const name = MONTHS[Number(month) - 1] ?? '';
  const parts: Record<string, string> = {
    yyyy: year,
    yy: year.slice(2),
    dd: day,
    mm: month,
    MON: name.slice(0, 3).toUpperCase(),
    Month: name,
  };
  return format.replace(/yyyy|yy|dd|mm|MON|Month/g, (part) => parts[part]);
}

/**
 * Fills a design's pattern, such as `{FIRST} & {SECOND}`, with the couple's details.
 *
 * A capital name gives capital letters. A line that asks for something left blank is
 * dropped whole, so a card with no make-up artist has no "MUA |" line.
 */
export function fill(pattern: string, details: CardDetails): string {
  const values: Record<string, string> = {
    first: details.first_name.trim(),
    second: details.second_name.trim(),
    venue: details.venue.trim(),
    mua: details.mua.trim(),
    studio: details.studio.trim(),
  };
  return pattern
    .split('\n')
    .flatMap((line) => {
      let blank = false;
      const written = line.replace(/\{([A-Za-z]+)(?::([^}]*))?\}/g, (whole, name: string, format?: string) => {
        const key = name.toLowerCase();
        const value = key === 'date' ? writeDate(details.date, format ?? 'dd . mm . yyyy') : values[key];
        if (value === undefined) return whole;
        if (!value) blank = true;
        return name === name.toUpperCase() && key !== 'date' ? value.toUpperCase() : value;
      });
      return blank ? [] : [written];
    })
    .join('\n');
}

/** Whether a text block's role is a pattern to fill, not a marker such as "message". */
const isPattern = (role: string | null | undefined): role is string => !!role && role.includes('{');

/** Writes the details into a design fresh from a card template. */
export function fillDesign(design: SpreadDesign, details: CardDetails): SpreadDesign {
  return {
    ...design,
    texts: design.texts.map((t) => (isPattern(t.role) ? { ...t, text: fill(t.role, details) } : t)),
  };
}

export const fillOptions = (options: LayoutOption[], details: CardDetails): LayoutOption[] =>
  options.map((o) => ({ ...o, design: fillDesign(o.design, details) }));

/** After the details change: rewrites the words made from them, but not words edited by hand. */
function refill(design: SpreadDesign, before: CardDetails, after: CardDetails): SpreadDesign {
  return {
    ...design,
    texts: design.texts.map((t) => (
      isPattern(t.role) && t.text === fill(t.role, before) ? { ...t, text: fill(t.role, after) } : t
    )),
  };
}

export const refillCards = (cards: Spread[], before: CardDetails, after: CardDetails): Spread[] =>
  cards.map((card) => ({
    ...card,
    design: refill(card.design, before, after),
    options: card.options.map((o) => ({ ...o, design: refill(o.design, before, after) })),
  }));

/**
 * A different design for the same card. The photos keep their crop and effects, and a
 * message the studio has written moves to the new design's message.
 */
export function changeCardDesign(from: SpreadDesign, to: SpreadDesign): SpreadDesign {
  const before = new Map(from.frames.map((f) => [f.asset_id, f]));
  const written = from.texts.filter((t) => t.role === 'message' && t.text !== MESSAGE_PLACEHOLDER).map((t) => t.text);
  return {
    ...to,
    frames: to.frames.map((frame) => {
      const old = before.get(frame.asset_id);
      return old ? { ...frame, fit: old.fit, adjust: old.adjust } : frame;
    }),
    texts: to.texts.map((t) => (t.role === 'message' && written.length ? { ...t, text: written.shift()! } : t)),
  };
}

/** "2, 3 or 5", for saying how many photos to select. */
export function listCounts(counts: number[]): string {
  if (counts.length <= 1) return counts.join('');
  return `${counts.slice(0, -1).join(', ')} or ${counts[counts.length - 1]}`;
}

const STUDIO_KEY = 'card-studio-line';

/** The studio's own line is the same on every job, so it is remembered. */
export function rememberedStudio(): string {
  try {
    return localStorage.getItem(STUDIO_KEY) ?? '';
  } catch {
    return '';
  }
}

export function rememberStudio(line: string) {
  try {
    localStorage.setItem(STUDIO_KEY, line);
  } catch {
    // Only a convenience.
  }
}
