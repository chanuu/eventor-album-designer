import { CheckIcon, EraserIcon, MinusIcon, ZoomInIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { EDIT_PREVIEW, NO_MAKEUP, previewUrl, type Makeup, type RetouchEdits, type RetouchFace, type Rgb } from './api';

const THUMB = 64;

/** Lip shades, from barely there to bridal red, then the deeper ones. */
const LIP_SHADES: { name: string; rgb: Rgb }[] = [
  { name: 'Nude', rgb: [190, 120, 105] },
  { name: 'Soft pink', rgb: [206, 110, 118] },
  { name: 'Peach', rgb: [214, 112, 92] },
  { name: 'Rose', rgb: [178, 62, 84] },
  { name: 'Coral', rgb: [208, 74, 66] },
  { name: 'Pink', rgb: [204, 52, 104] },
  { name: 'Red', rgb: [178, 24, 40] },
  { name: 'Bridal red', rgb: [150, 14, 40] },
  { name: 'Brown', rgb: [132, 66, 54] },
  { name: 'Berry', rgb: [122, 26, 62] },
];

const BLUSH_SHADES: { name: string; rgb: Rgb }[] = [
  { name: 'Pink', rgb: [226, 110, 120] },
  { name: 'Peach', rgb: [230, 130, 100] },
  { name: 'Rose', rgb: [205, 85, 100] },
  { name: 'Warm', rgb: [195, 95, 70] },
];

const LOOKS: { name: string; makeup: Makeup }[] = [
  { name: 'Natural', makeup: { lip_rgb: [196, 98, 98], lip: 0.45, gloss: 0.15, blush_rgb: [226, 122, 118], blush: 0.3, contour: 0.2, highlight: 0.25 } },
  { name: 'Soft glam', makeup: { lip_rgb: [178, 62, 84], lip: 0.7, gloss: 0.3, blush_rgb: [226, 110, 120], blush: 0.42, contour: 0.4, highlight: 0.4 } },
  { name: 'Bridal', makeup: { lip_rgb: [165, 22, 44], lip: 0.85, gloss: 0.3, blush_rgb: [220, 95, 105], blush: 0.5, contour: 0.5, highlight: 0.5 } },
  { name: 'Face only', makeup: { ...NO_MAKEUP, contour: 0.35, highlight: 0.35 } },
];

const onFace = (face: RetouchFace, at: [number, number]) =>
  Math.hypot((at[0] - face.at[0]) / face.bounds[2], (at[1] - face.at[1]) / face.bounds[3]) < 0.5;

export const wearsMakeup = (m: Makeup) => m.lip > 0 || m.gloss > 0 || m.blush > 0 || m.contour > 0 || m.highlight > 0;

export const makeupOn = (edits: RetouchEdits, face: RetouchFace): Makeup =>
  edits.makeup?.find((m) => onFace(face, m.at))?.makeup ?? NO_MAKEUP;

/** The edits with each of these faces' makeup changed. */
export function withMakeup(edits: RetouchEdits, faces: RetouchFace[], change: Partial<Makeup>): RetouchEdits {
  let makeup = edits.makeup ?? [];
  for (const face of faces) {
    const next = { ...makeupOn({ ...edits, makeup }, face), ...change };
    makeup = makeup.filter((m) => !onFace(face, m.at));
    if (wearsMakeup(next)) makeup = [...makeup, { at: face.at, makeup: next }];
  }
  return { ...edits, makeup };
}

export const leftOutOfSkin = (edits: RetouchEdits, face: RetouchFace) => !!edits.skin_skip?.some((at) => onFace(face, at));

export function toggleSkin(edits: RetouchEdits, face: RetouchFace): RetouchEdits {
  const skip = (edits.skin_skip ?? []).filter((at) => !onFace(face, at));
  return { ...edits, skin_skip: leftOutOfSkin(edits, face) ? skip : [...skip, face.at] };
}

/** A face cut out of the photo, for choosing people by sight. */
function FaceThumb({ photoId, face, photoAspect }: { photoId: string; face: RetouchFace; photoAspect: number }) {
  // A square around the face, in shares of the photo's height.
  const side = Math.max(face.bounds[2] * photoAspect, face.bounds[3]) * 1.25;
  const height = THUMB / side;
  const width = height * photoAspect;
  return (
    <img
      src={previewUrl(photoId, EDIT_PREVIEW)}
      alt=""
      draggable={false}
      style={{ width, height, left: THUMB / 2 - face.at[0] * width, top: THUMB / 2 - face.at[1] * height }}
    />
  );
}

/** The people in the photo, to choose from in the panel. */
export function FaceList({
  photoId, photoAspect, faces, chosen, marked, cannot, onToggle, onZoom,
}: {
  photoId: string;
  photoAspect: number;
  faces: RetouchFace[];
  chosen: (face: RetouchFace) => boolean;
  /** Faces with something on them already. */
  marked: (face: RetouchFace) => boolean;
  /** Why a face cannot be chosen, if it cannot. */
  cannot?: (face: RetouchFace) => string | null;
  onToggle: (index: number) => void;
  onZoom: (face: RetouchFace) => void;
}) {
  return (
    <div className="face-list" role="group" aria-label="Faces in this photo">
      {faces.map((face, i) => {
        const why = cannot?.(face) ?? null;
        const on = chosen(face);
        return (
          <div key={face.at.join()} className={`face-card ${on ? 'on' : ''} ${why ? 'off' : ''}`}>
            <button type="button" className="face-pick" aria-pressed={on} disabled={!!why} title={why ?? `Face ${i + 1}`} aria-label={`Face ${i + 1}`} onClick={() => onToggle(i)}>
              <FaceThumb photoId={photoId} face={face} photoAspect={photoAspect} />
              <span className="face-number">{i + 1}</span>
              {on && <span className="face-tick"><CheckIcon aria-hidden="true" /></span>}
              {marked(face) && <span className="face-dot" aria-label="Has makeup" />}
            </button>
            <button type="button" className="face-zoom" title={`Zoom to face ${i + 1}`} aria-label={`Zoom to face ${i + 1}`} onClick={() => onZoom(face)}><ZoomInIcon aria-hidden="true" /></button>
          </div>
        );
      })}
    </div>
  );
}

/** The same faces, marked on the photo itself. */
export function FaceMarks({
  faces, chosen, cannot, quiet, onToggle,
}: {
  faces: RetouchFace[];
  chosen: (face: RetouchFace) => boolean;
  cannot?: (face: RetouchFace) => string | null;
  /** Lets presses through to the photo, while it is being moved. */
  quiet: boolean;
  onToggle: (index: number) => void;
}) {
  return (
    <>
      {faces.map((face, i) => {
        const [x, y, w, h] = face.bounds;
        const why = cannot?.(face) ?? null;
        const on = chosen(face);
        return (
          <button
            key={face.at.join()}
            type="button"
            className={`face-mark ${on ? 'on' : ''} ${why ? 'off' : ''}`}
            style={{ left: `${(x - w * 0.08) * 100}%`, top: `${(y - h * 0.06) * 100}%`, width: `${w * 116}%`, height: `${h * 112}%`, pointerEvents: quiet ? 'none' : undefined }}
            aria-pressed={on}
            disabled={!!why}
            title={why ?? (on ? 'Click to leave this face out' : 'Click to choose this face')}
            aria-label={`Face ${i + 1} on the photo`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onToggle(i)}
          >
            <span>{on ? <CheckIcon aria-hidden="true" /> : why ? <MinusIcon aria-hidden="true" /> : null}{i + 1}</span>
          </button>
        );
      })}
    </>
  );
}

const hex = (rgb: Rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const fromHex = (text: string): Rgb => [1, 3, 5].map((i) => parseInt(text.slice(i, i + 2), 16)) as Rgb;

function Shades({ label, shades, value, onPick }: { label: string; shades: { name: string; rgb: Rgb }[]; value: Rgb; onPick: (rgb: Rgb) => void }) {
  return (
    <div className="shades" role="group" aria-label={label}>
      {shades.map((s) => (
        <button key={s.name} type="button" className={hex(s.rgb) === hex(value) ? 'on' : ''} title={s.name} aria-label={s.name} aria-pressed={hex(s.rgb) === hex(value)} style={{ background: hex(s.rgb) }} onClick={() => onPick(s.rgb)} />
      ))}
      <label className="shade-own" title="Another colour">
        <input type="color" value={hex(value)} aria-label={`${label}, another colour`} onChange={(e) => onPick(fromHex(e.target.value))} />
      </label>
    </div>
  );
}

/** Makeup for the chosen faces. With several chosen, it shows the first one's. */
export function MakeupPanel({
  value, disabled, slider, onStart, onChange,
}: {
  value: Makeup;
  disabled: boolean;
  /** The retoucher's own slider, so these look and undo the same. */
  slider: (label: string, value: number, onChange: (v: number) => void) => ReactNode;
  onStart: () => void;
  onChange: (change: Partial<Makeup>, mergeKey?: string) => void;
}) {
  const amount = (label: string, key: 'lip' | 'gloss' | 'blush' | 'contour' | 'highlight') =>
    slider(label, value[key], (v) => onChange({ [key]: v }, `makeup:${key}`));
  // Choosing a shade puts some on, or nothing would seem to happen.
  const pick = (change: Partial<Makeup>, key: 'lip' | 'blush', least: number) => {
    onStart();
    onChange(value[key] > 0 ? change : { ...change, [key]: least });
  };
  return (
    <fieldset className="makeup" disabled={disabled}>
      <div className="looks" role="group" aria-label="Ready-made looks">
        {LOOKS.map((look) => (
          <button key={look.name} type="button" className="btn" onClick={() => { onStart(); onChange(look.makeup); }}>{look.name}</button>
        ))}
      </div>
      <h4>Lips</h4>
      <Shades label="Lip colour" shades={LIP_SHADES} value={value.lip_rgb} onPick={(lip_rgb) => pick({ lip_rgb }, 'lip', 0.6)} />
      {amount('Lip colour', 'lip')}
      {amount('Gloss', 'gloss')}
      <h4>Blush</h4>
      <Shades label="Blush colour" shades={BLUSH_SHADES} value={value.blush_rgb} onPick={(blush_rgb) => pick({ blush_rgb }, 'blush', 0.35)} />
      {amount('Blush', 'blush')}
      <h4>Face shape</h4>
      {amount('Contour', 'contour')}
      {amount('Highlight', 'highlight')}
      <button type="button" className="btn" disabled={!wearsMakeup(value)} onClick={() => { onStart(); onChange(NO_MAKEUP); }}><EraserIcon aria-hidden="true" />Remove makeup</button>
    </fieldset>
  );
}
