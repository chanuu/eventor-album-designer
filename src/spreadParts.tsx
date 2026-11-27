import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { previewText, previewUrl, type Frame, type PhotoInfo, type SpreadDesign, type TextBlock } from './api';
import type { Album } from './App';
import { visibleArea } from './crop';

/** The pieces that draw a spread, shared by the album view and the designer. */

export const DRAG_PHOTOS = 'application/x-album-photos';

/** How long a slider must rest before the adjusted picture is fetched. */
const EFFECT_SETTLE_MS = 90;

/** How long typing must rest before the text is drawn again. */
const TEXT_SETTLE_MS = 120;

/** How close a dragged text block must come to a guide before it snaps to it. */
const SNAP_MM = 2;

const MIN_TEXT_BOX_MM = 8;

/** How far each side of the fold the binding takes. A magazine fold hides much more. */
const GUTTER_MM: Record<string, number> = { layflat: 3, magazine: 10 };

/** The fold, and the band beside it that the binding may hide. */
export function foldStyle(binding: string, spreadWidthMm: number): CSSProperties {
  return { width: percent((GUTTER_MM[binding] ?? 6) * 2, spreadWidthMm) };
}

export function percent(part: number, whole: number): string {
  return `${(part / whole) * 100}%`;
}

/** A frame's border, drawn inside it as the print does, and sized with the spread. */
export function FrameBorder({ frame, design }: { frame: Frame; design: SpreadDesign }) {
  if (frame.style.border_mm <= 0) return null;
  const { w } = design.size_mm;
  return (
    <span
      className="frame-border"
      style={{
        borderWidth: `${(frame.style.border_mm / w) * 100}cqw`,
        borderColor: frame.style.border_colour,
        borderRadius: `${(frame.corner_radius_mm / w) * 100}cqw`,
      }}
    />
  );
}

export function frameStyle(frame: Frame, design: SpreadDesign): React.CSSProperties {
  const { rect_mm: r } = frame;
  return {
    left: percent(r.x, design.size_mm.w),
    top: percent(r.y, design.size_mm.h),
    width: percent(r.w, design.size_mm.w),
    height: percent(r.h, design.size_mm.h),
    zIndex: frame.z,
    opacity: frame.style.opacity,
    borderRadius: `${(frame.corner_radius_mm / design.size_mm.w) * 100}cqw`,
  };
}

/**
 * The address to show, swapped only once the new picture has loaded.
 *
 * While a slider moves, each value is a new picture from Rust. Waiting for a pause and
 * for the download avoids flicker, and avoids asking for pictures nobody will see.
 */
function useSettledImage(url: string): string {
  const [shown, setShown] = useState(url);
  useEffect(() => {
    if (url === shown) return;
    let current = true;
    const timer = setTimeout(() => {
      const image = new Image();
      image.onload = () => { if (current) setShown(url); };
      image.onerror = () => { if (current) setShown(url); };
      image.src = url;
    }, EFFECT_SETTLE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [url, shown]);
  return shown;
}

export function FramedPhoto({
  photo, frame, width, original,
}: {
  photo: PhotoInfo;
  frame: Frame;
  width: number;
  original?: boolean;
}) {
  const area = visibleArea(photo.width / photo.height, frame.rect_mm.w / frame.rect_mm.h, frame.fit);
  const src = useSettledImage(previewUrl(photo.id, width, original ? undefined : frame.adjust));
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className="framed"
      style={{
        width: `${100 / area.sw}%`,
        height: `${100 / area.sh}%`,
        left: `${(-area.sx / area.sw) * 100}%`,
        top: `${(-area.sy / area.sh) * 100}%`,
      }}
    />
  );
}

/**
 * The drawn picture of a text block. Rust draws it, using the same code as the print, so
 * what is seen is what prints. Typing waits for a pause before asking again.
 */
export function useTextImage(block: TextBlock, onOverflow?: (overflowed: boolean) => void): string | null {
  const [url, setUrl] = useState<string | null>(null);
  // Moving a box does not change its picture, so its position is left out of this.
  const { x: _x, y: _y, ...size } = block.rect_mm;
  const looks = JSON.stringify({ ...block, rect_mm: size });
  const report = useRef(onOverflow);
  report.current = onOverflow;

  useEffect(() => {
    let current = true;
    let made: string | null = null;
    const timer = setTimeout(() => {
      previewText(JSON.parse(looks.replace('"rect_mm":{', '"rect_mm":{"x":0,"y":0,')) as TextBlock)
        .then(({ png, overflowed }) => {
          if (!current) return;
          made = URL.createObjectURL(png);
          setUrl(made);
          report.current?.(overflowed);
        })
        .catch(() => {});
    }, TEXT_SETTLE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
      // The old picture stays on screen until the new one is ready, then this frees it.
      if (made) {
        const old = made;
        setTimeout(() => URL.revokeObjectURL(old), 2000);
      }
    };
  }, [looks]);
  return url;
}

export function ThumbText({ block, design }: { block: TextBlock; design: SpreadDesign }) {
  const url = useTextImage(block);
  const r = block.rect_mm;
  return (
    <span
      className="thumb-text"
      style={{
        left: percent(r.x, design.size_mm.w),
        top: percent(r.y, design.size_mm.h),
        width: percent(r.w, design.size_mm.w),
        height: percent(r.h, design.size_mm.h),
        zIndex: 4,
        opacity: block.opacity,
      }}
    >
      {url && <img src={url} alt="" />}
    </span>
  );
}

/** The lines a dragged text block snaps to, in millimetres. */
function snapTargets(spec: Album['spec'], w: number, h: number) {
  const inset = spec.bleed_mm + spec.safe_mm;
  return {
    edgesX: [inset, w / 2 - spec.safe_mm, w / 2 + spec.safe_mm, w - inset],
    centresX: [w / 4, w / 2, (w * 3) / 4],
    edgesY: [inset, h - inset],
    centresY: [h / 2],
  };
}

function nearest(values: number[], targets: number[]): { shift: number; line: number } | null {
  let best: { shift: number; line: number } | null = null;
  for (const value of values) {
    for (const line of targets) {
      const shift = line - value;
      if (Math.abs(shift) <= SNAP_MM && (!best || Math.abs(shift) < Math.abs(best.shift))) {
        best = { shift, line };
      }
    }
  }
  return best;
}

export function TextOnSpread({
  block, design, spec, selected, overflowing, onSelect, onChange, onGestureStart, onOverflow, onSnap,
}: {
  block: TextBlock;
  design: SpreadDesign;
  spec: Album['spec'];
  selected: boolean;
  overflowing: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, change: Partial<TextBlock>) => void;
  onGestureStart: () => void;
  onOverflow: (id: string, overflowed: boolean) => void;
  onSnap: (lines: { x: number | null; y: number | null }) => void;
}) {
  const { w, h } = design.size_mm;
  const url = useTextImage(block, (overflowed) => onOverflow(block.id, overflowed));
  const drag = useRef<{ mode: 'move' | 'size'; x: number; y: number; rect: TextBlock['rect_mm']; mmPerPx: number } | null>(null);
  const r = block.rect_mm;

  const begin = (e: React.PointerEvent, mode: 'move' | 'size') => {
    e.stopPropagation();
    onSelect(block.id);
    onGestureStart();
    const spread = e.currentTarget.closest('.spread');
    if (!spread) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, rect: r, mmPerPx: w / spread.getBoundingClientRect().width };
  };

  const move = (e: React.PointerEvent) => {
    const start = drag.current;
    if (!start) return;
    const dx = (e.clientX - start.x) * start.mmPerPx;
    const dy = (e.clientY - start.y) * start.mmPerPx;
    if (start.mode === 'size') {
      onChange(block.id, {
        rect_mm: {
          ...start.rect,
          w: Math.min(w - start.rect.x, Math.max(MIN_TEXT_BOX_MM, start.rect.w + dx)),
          h: Math.min(h - start.rect.y, Math.max(MIN_TEXT_BOX_MM, start.rect.h + dy)),
        },
      });
      return;
    }
    let x = start.rect.x + dx;
    let y = start.rect.y + dy;
    const targets = snapTargets(spec, w, h);
    const edgeX = nearest([x, x + r.w], targets.edgesX);
    const centreX = nearest([x + r.w / 2], targets.centresX);
    const snapX = centreX ?? edgeX;
    const edgeY = nearest([y, y + r.h], targets.edgesY);
    const centreY = nearest([y + r.h / 2], targets.centresY);
    const snapY = centreY ?? edgeY;
    if (snapX) x += snapX.shift;
    if (snapY) y += snapY.shift;
    onSnap({ x: snapX?.line ?? null, y: snapY?.line ?? null });
    onChange(block.id, {
      rect_mm: {
        ...start.rect,
        x: Math.min(w - r.w, Math.max(0, x)),
        y: Math.min(h - r.h, Math.max(0, y)),
      },
    });
  };

  const end = () => {
    drag.current = null;
    onSnap({ x: null, y: null });
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Text: ${block.text.slice(0, 40)}`}
      aria-pressed={selected}
      className={`text-block ${selected ? 'selected' : ''} ${overflowing ? 'overflowing' : ''}`}
      style={{
        left: percent(r.x, w),
        top: percent(r.y, h),
        width: percent(r.w, w),
        height: percent(r.h, h),
        opacity: block.opacity,
      }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => begin(e, 'move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {url && <img src={url} alt="" draggable={false} />}
      {selected && (
        <span
          className="text-handle"
          onPointerDown={(e) => begin(e, 'size')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      )}
    </div>
  );
}
