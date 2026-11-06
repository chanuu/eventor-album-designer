import type { TextBlock } from './api';

/** A ready-made piece of text. Positions are fractions of the width and height it fills. */
type TemplateBlock = Pick<TextBlock, 'text' | 'font' | 'size_pt' | 'align' | 'bold' | 'italic' | 'line_height'> & {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type TextTemplate = {
  key: string;
  name: string;
  /** How much of the spread's width and height the template takes. */
  width: number;
  height: number;
  blocks: TemplateBlock[];
};

const SERIF = 'Georgia';
const SCRIPT = 'Segoe Script';
const SANS = 'Segoe UI';
const SINHALA = 'Nirmala UI';

const plain = { bold: false, italic: false };

/** All of this wording and styling is Eventor's own. Photographers replace it with theirs. */
export const TEXT_TEMPLATES: TextTemplate[] = [
  {
    key: 'names-date',
    name: 'Names and date',
    width: 0.3,
    height: 0.24,
    blocks: [
      { ...plain, text: 'Name & Name', font: SERIF, size_pt: 40, align: 'center', line_height: 1.2, x: 0, y: 0, w: 1, h: 0.6 },
      { ...plain, text: '1st January 2027', font: SANS, size_pt: 16, align: 'center', line_height: 1.3, x: 0, y: 0.62, w: 1, h: 0.38 },
    ],
  },
  {
    key: 'script-title',
    name: 'Script title',
    width: 0.3,
    height: 0.16,
    blocks: [
      { ...plain, text: 'Our Wedding Day', font: SCRIPT, size_pt: 38, align: 'center', line_height: 1.3, x: 0, y: 0, w: 1, h: 1 },
    ],
  },
  {
    key: 'part-of-day',
    name: 'Part of the day',
    width: 0.2,
    height: 0.2,
    blocks: [
      { ...plain, text: 'THE CEREMONY', font: SANS, size_pt: 22, align: 'left', line_height: 1.2, bold: true, x: 0, y: 0, w: 1, h: 0.45 },
      { ...plain, text: 'A few words about this moment.', font: SERIF, size_pt: 13, align: 'left', line_height: 1.4, x: 0, y: 0.48, w: 1, h: 0.52 },
    ],
  },
  {
    key: 'quote',
    name: 'Quote',
    width: 0.26,
    height: 0.3,
    blocks: [
      { ...plain, text: '“A few words that mean something to the two of you.”', font: SERIF, size_pt: 22, align: 'center', italic: true, line_height: 1.45, x: 0, y: 0, w: 1, h: 0.76 },
      { ...plain, text: 'Who said it', font: SANS, size_pt: 12, align: 'center', line_height: 1.3, x: 0, y: 0.8, w: 1, h: 0.2 },
    ],
  },
  {
    key: 'thank-you',
    name: 'Thank you',
    width: 0.28,
    height: 0.26,
    blocks: [
      { ...plain, text: 'Thank you', font: SCRIPT, size_pt: 36, align: 'center', line_height: 1.3, x: 0, y: 0, w: 1, h: 0.52 },
      { ...plain, text: 'To everyone who shared this day with us.', font: SERIF, size_pt: 14, align: 'center', line_height: 1.4, x: 0, y: 0.55, w: 1, h: 0.45 },
    ],
  },
  {
    key: 'sinhala-title',
    name: 'Sinhala title',
    width: 0.3,
    height: 0.2,
    blocks: [
      { ...plain, text: 'සුබ විවාහ දිනය', font: SINHALA, size_pt: 36, align: 'center', line_height: 1.4, x: 0, y: 0, w: 1, h: 1 },
    ],
  },
];
