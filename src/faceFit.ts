import type { FaceBox, Fit, Frame, PhotoInfo, SpreadDesign } from './api';
import { visibleArea } from './crop';

/** Faces much smaller than the biggest are people in the background. */
const BACKGROUND = 0.4;
/** Room kept around a face, as shares of its size. Hair needs more than a chin does. */
const ROOM = { above: 0.45, below: 0.3, beside: 0.25 };
const STEPS = 60;
const SAME = 1e-4;
const CENTRED: Fit = { scale: 1, cx: 0.5, cy: 0.5, rot_deg: 0 };

type Faces = ReadonlyMap<string, FaceBox[]>;
/** A stretch of one axis that should show, and how much it matters. */
type Span = { from: number; to: number; core: [number, number]; weight: number };

function subjects(faces: FaceBox[]): FaceBox[] {
  const biggest = Math.max(0, ...faces.map(([, , w]) => w));
  return faces.filter(([, , w]) => w >= biggest * BACKGROUND);
}

const unit = (v: number) => Math.min(1, Math.max(0, v));

/** Where a window of this length starts, so that it shows the faces as well as it can. */
function place(spans: Span[], size: number): number {
  const most = 1 - size;
  if (most <= SAME) return 0;
  const from = Math.min(...spans.map((s) => s.from));
  const to = Math.max(...spans.map((s) => s.to));
  if (to - from <= size) return Math.min(most, Math.max(0, (from + to) / 2 - size / 2));
  // Not everyone fits with room to spare: whole faces first, then as much room as possible.
  const total = spans.reduce((sum, s) => sum + s.weight, 0);
  const middle = spans.reduce((sum, s) => sum + (s.core[0] + s.core[1]) / 2 * s.weight, 0) / total;
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i <= STEPS; i += 1) {
    const at = (most * i) / STEPS;
    let score = -0.05 * total * Math.abs(at + size / 2 - middle);
    for (const s of spans) {
      const shown = Math.max(0, Math.min(at + size, s.to) - Math.max(at, s.from)) / Math.max(SAME, s.to - s.from);
      const whole = s.core[0] >= at - SAME && s.core[1] <= at + size + SAME;
      score += s.weight * (0.5 * shown + (whole ? 1 : 0));
    }
    if (score > bestScore) { best = at; bestScore = score; }
  }
  return best;
}

/** The crop that shows a photo's faces best in a frame of this shape. */
export function faceFit(photoAspect: number, frameAspect: number, found: FaceBox[] | undefined, from: Fit = CENTRED): Fit {
  if (!found?.length || from.rot_deg !== 0) return from;
  const { sw, sh } = visibleArea(photoAspect, frameAspect, from);
  const faces = subjects(found);
  const weight = (b: FaceBox) => b[2] * b[3];
  const across = faces.map((b): Span => ({
    from: unit(b[0] - b[2] * ROOM.beside), to: unit(b[0] + b[2] * (1 + ROOM.beside)),
    core: [unit(b[0]), unit(b[0] + b[2])], weight: weight(b),
  }));
  const down = faces.map((b): Span => ({
    from: unit(b[1] - b[3] * ROOM.above), to: unit(b[1] + b[3] * (1 + ROOM.below)),
    core: [unit(b[1]), unit(b[1] + b[3])], weight: weight(b),
  }));
  return { ...from, cx: place(across, sw) + sw / 2, cy: place(down, sh) + sh / 2 };
}

/** The share of the faces that matter which this crop cuts, 0 to 1. */
export function facesCut(photoAspect: number, frameAspect: number, found: FaceBox[] | undefined, fit: Fit): number {
  if (!found?.length) return 0;
  const { sx, sy, sw, sh } = visibleArea(photoAspect, frameAspect, fit);
  let all = 0;
  let cut = 0;
  for (const [x, y, w, h] of subjects(found)) {
    const seen = Math.max(0, Math.min(sx + sw, unit(x + w)) - Math.max(sx, unit(x)))
      * Math.max(0, Math.min(sy + sh, unit(y + h)) - Math.max(sy, unit(y)));
    const whole = (unit(x + w) - unit(x)) * (unit(y + h) - unit(y));
    all += w * h;
    if (whole > 0) cut += w * h * (1 - seen / whole);
  }
  return all > 0 ? cut / all : 0;
}

const aspectOf = (f: Frame) => f.rect_mm.w / f.rect_mm.h;
const same = (a: Fit, b: Fit) =>
  Math.abs(a.scale - b.scale) < SAME && Math.abs(a.cx - b.cx) < SAME && Math.abs(a.cy - b.cy) < SAME && a.rot_deg === b.rot_deg;

/** Whether a frame's crop was set by the photographer, not by a layout. */
function setByHand(frame: Frame, photo: PhotoInfo, faces: Faces): boolean {
  return !same(frame.fit, CENTRED)
    && !same(frame.fit, faceFit(photo.width / photo.height, aspectOf(frame), faces.get(photo.id)));
}

/**
 * Points every crop in a new layout at the faces. A crop the photographer set by hand
 * stays, unless the new frame's shape would make it cut a face.
 */
export function focusFaces(to: SpreadDesign, photos: ReadonlyMap<string, PhotoInfo>, faces: Faces, from?: SpreadDesign): SpreadDesign {
  const before = new Map(from?.frames.map((f) => [f.asset_id, f]));
  return {
    ...to,
    frames: to.frames.map((frame) => {
      const photo = frame.asset_id ? photos.get(frame.asset_id) : undefined;
      if (!photo) return frame;
      const aspect = photo.width / photo.height;
      const found = faces.get(photo.id);
      const old = before.get(frame.asset_id);
      if (old && setByHand(old, photo, faces)) {
        const keep = facesCut(aspect, aspectOf(frame), found, old.fit)
          <= facesCut(aspect, aspectOf(old), found, old.fit) + 0.02;
        return { ...frame, fit: keep ? old.fit : faceFit(aspect, aspectOf(frame), found, old.fit) };
      }
      return { ...frame, fit: faceFit(aspect, aspectOf(frame), found) };
    }),
  };
}

/** How badly a spread cuts faces: the sum over its photos. */
export function designCutsFaces(design: SpreadDesign, photos: ReadonlyMap<string, PhotoInfo>, faces: Faces): number {
  return design.frames.reduce((sum, f) => {
    const photo = f.asset_id ? photos.get(f.asset_id) : undefined;
    return photo ? sum + facesCut(photo.width / photo.height, aspectOf(f), faces.get(photo.id), f.fit) : sum;
  }, 0);
}
