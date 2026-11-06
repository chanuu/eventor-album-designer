/** Rectangle arithmetic for the designer view. All values are millimetres on the canvas. */

export type Rect = { x: number; y: number; w: number; h: number };

export const MIN_ITEM_MM = 3;

/** A frame this much larger than its spread would take too much memory to render. */
export const MAX_ITEM_SHARE_OF_SPREAD = 4;

export function boundsOf(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Moves and scales a rectangle so what was in `from` lands in `to`. */
export function mapRect(rect: Rect, from: Rect, to: Rect): Rect {
  const sx = to.w / from.w;
  const sy = to.h / from.h;
  return {
    x: to.x + (rect.x - from.x) * sx,
    y: to.y + (rect.y - from.y) * sy,
    w: rect.w * sx,
    h: rect.h * sy,
  };
}

/** Which side of the selection each handle moves: -1 left or top, 1 right or bottom. */
export type Handle = { key: string; dx: -1 | 0 | 1; dy: -1 | 0 | 1 };

export const HANDLES: Handle[] = [
  { key: 'nw', dx: -1, dy: -1 },
  { key: 'n', dx: 0, dy: -1 },
  { key: 'ne', dx: 1, dy: -1 },
  { key: 'e', dx: 1, dy: 0 },
  { key: 'se', dx: 1, dy: 1 },
  { key: 's', dx: 0, dy: 1 },
  { key: 'sw', dx: -1, dy: 1 },
  { key: 'w', dx: -1, dy: 0 },
];

/** The selection's new box after dragging a handle by (moveX, moveY). */
export function resizedBox(start: Rect, handle: Handle, moveX: number, moveY: number, keepShape: boolean): Rect {
  let w = start.w + moveX * handle.dx;
  let h = start.h + moveY * handle.dy;
  if (keepShape && handle.dx !== 0 && handle.dy !== 0) {
    const factor = Math.max(w / start.w, h / start.h);
    w = start.w * factor;
    h = start.h * factor;
  }
  // Keep the shape's proportions when the smallest size is reached.
  const least = Math.max(MIN_ITEM_MM / Math.max(start.w, 0.001), MIN_ITEM_MM / Math.max(start.h, 0.001));
  if (keepShape && handle.dx !== 0 && handle.dy !== 0 && w / start.w < least) {
    w = start.w * least;
    h = start.h * least;
  }
  w = Math.max(MIN_ITEM_MM, w);
  h = Math.max(MIN_ITEM_MM, h);
  return {
    x: handle.dx === -1 ? start.x + start.w - w : start.x,
    y: handle.dy === -1 ? start.y + start.h - h : start.y,
    w,
    h,
  };
}

export type SnapResult = { shift: number; line: number } | null;

/** The nearest guide within reach of any of these positions, if there is one. */
export function snapTo(values: number[], lines: number[], reach: number): SnapResult {
  let best: SnapResult = null;
  for (const value of values) {
    for (const line of lines) {
      const shift = line - value;
      if (Math.abs(shift) <= reach && (!best || Math.abs(shift) < Math.abs(best.shift))) {
        best = { shift, line };
      }
    }
  }
  return best;
}

export type AlignKind = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

/** Lines items up within the selection's box. A single item lines up with `page` instead. */
export function alignRect(rect: Rect, kind: AlignKind, box: Rect): Rect {
  switch (kind) {
    case 'left': return { ...rect, x: box.x };
    case 'centre': return { ...rect, x: box.x + (box.w - rect.w) / 2 };
    case 'right': return { ...rect, x: box.x + box.w - rect.w };
    case 'top': return { ...rect, y: box.y };
    case 'middle': return { ...rect, y: box.y + (box.h - rect.h) / 2 };
    case 'bottom': return { ...rect, y: box.y + box.h - rect.h };
  }
}
