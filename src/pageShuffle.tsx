import { ShuffleIcon } from 'lucide-react';
import type { Frame, PageSide, SpreadDesign } from './api';

export type ShuffleSide = PageSide | 'both';

/** A frame may reach this far over the fold and still belong to one page. */
const FOLD_SLACK_MM = 1;

/** One page's frames and all the rest, or null when a photo runs across the fold. */
export function splitAtFold(design: SpreadDesign, side: PageSide): { page: Frame[]; rest: Frame[] } | null {
  const fold = design.size_mm.w / 2;
  const left = (f: Frame) => f.rect_mm.x + f.rect_mm.w <= fold + FOLD_SLACK_MM;
  const right = (f: Frame) => f.rect_mm.x >= fold - FOLD_SLACK_MM;
  if (!design.frames.every((f) => left(f) || right(f))) return null;
  const on = side === 'left' ? left : right;
  return { page: design.frames.filter(on), rest: design.frames.filter((f) => !on(f)) };
}

/** Where a page's frames are, for telling arrangements apart. */
export const pageShape = (frames: Frame[]) =>
  frames.map(({ rect_mm: r }) => [r.x, r.y, r.w, r.h].map((v) => Math.round(v / 4)).join()).sort().join('|');

/** The spread with one page's frames replaced, each photo keeping its frame's id. */
export function withPage(design: SpreadDesign, page: Frame[], rest: Frame[], made: Frame[]): SpreadDesign {
  const old = [...page];
  const placed = made.map((f) => {
    const at = old.findIndex((o) => o.asset_id === f.asset_id);
    const was = at >= 0 ? old.splice(at, 1)[0] : undefined;
    return { ...f, id: was?.id ?? crypto.randomUUID() };
  });
  return { ...design, template_id: null, frames: [...rest, ...placed] };
}

const SIDES: { id: ShuffleSide; name: string; title: string }[] = [
  { id: 'left', name: 'L', title: 'Shuffle only the left page' },
  { id: 'both', name: 'Both', title: 'Shuffle both pages' },
  { id: 'right', name: 'R', title: 'Shuffle only the right page' },
];

const HINTS: Record<ShuffleSide, string> = {
  left: 'Try a different layout on the left page. The right page stays as it is.',
  both: 'Try a different layout for these photos. Click again for another.',
  right: 'Try a different layout on the right page. The left page stays as it is.',
};

/** The Shuffle button, and which pages it changes. */
export function ShuffleControl({
  side, onSide, onShuffle, className, pages = true,
}: {
  side: ShuffleSide;
  onSide: (side: ShuffleSide) => void;
  onShuffle: () => void;
  className: string;
  /** Cards have no left and right page to choose from. */
  pages?: boolean;
}) {
  return (
    <>
      {pages && (
        <span className="shuffle-side" role="group" aria-label="Pages to shuffle">
          {SIDES.map((s) => (
            <button key={s.id} type="button" className={side === s.id ? 'on' : ''} aria-pressed={side === s.id} aria-label={s.title} title={s.title} onClick={() => onSide(s.id)}>{s.name}</button>
          ))}
        </span>
      )}
      <button type="button" className={className} title={HINTS[side]} onClick={onShuffle}><ShuffleIcon aria-hidden="true" />Shuffle</button>
    </>
  );
}
