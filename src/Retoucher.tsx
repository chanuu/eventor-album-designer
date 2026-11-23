import { ask } from '@tauri-apps/plugin-dialog';
import {
  BandageIcon, BrushIcon, CircleIcon, ClipboardCopyIcon, ClipboardPasteIcon, CrosshairIcon, HandIcon,
  MoonIcon, MousePointer2Icon, PipetteIcon, Redo2Icon, RotateCcwIcon, SaveIcon, SmileIcon, SparklesIcon,
  SquareSplitHorizontalIcon, StampIcon, SunIcon, Undo2Icon, WandSparklesIcon, XIcon, ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  EDIT_PREVIEW, GRID_PREVIEW, NO_RETOUCH, NO_SKIN, neutralAt, prepareSkin, previewUrl, retouchPreview, suggestColour,
  type Adjustments, type PhotoInfo, type RetouchEdits, type RetouchTool, type SkinSettings, type Stroke,
} from './api';
import EffectsPanel, { NO_ADJUSTMENTS } from './EffectsPanel';
import { useHistory } from './history';

/** One photo in the retoucher, with its edits and colour as they stand. */
export type RetouchItem = { photo: PhotoInfo; edits: RetouchEdits; adjust: Adjustments };

type Work = { edits: RetouchEdits; adjust: Adjustments };

/** Tools that are not brushes: Magic skin works on every face, the others on colour. */
type PanelTool = 'skin' | 'picker' | 'target' | 'hand';

type ToolInfo = {
  id: RetouchTool | PanelTool;
  name: string;
  key: string;
  icon: ReactNode;
  help: string;
  /** Size in pixels of the editing preview, then softness and strength, 0 to 1. */
  size: number;
  softness: number;
  strength: number;
};

const TOOLS: ToolInfo[] = [
  { id: 'skin', name: 'Magic skin', key: 'm', icon: <SparklesIcon aria-hidden="true" />, help: 'Smooths, brightens and evens the skin of every face at once. Eyes, brows and lips are left sharp, and each person keeps their own skin colour.', size: 0, softness: 0, strength: 0 },
  { id: 'heal', name: 'Spot healing', key: 'j', icon: <BandageIcon aria-hidden="true" />, help: 'Paint over a pimple, mark or stray hair. It is replaced with matching skin from around it.', size: 14, softness: 0.4, strength: 1 },
  { id: 'clone', name: 'Clone stamp', key: 's', icon: <StampIcon aria-hidden="true" />, help: 'Alt-click where to copy from, then paint. Use it where healing guesses wrong, such as a sign behind a head.', size: 24, softness: 0.5, strength: 1 },
  { id: 'smooth', name: 'Smooth skin', key: 'b', icon: <BrushIcon aria-hidden="true" />, help: 'Paint smoothing just where you want it. Fine grain is kept so skin still looks like skin.', size: 60, softness: 0.7, strength: 0.6 },
  { id: 'brighten', name: 'Brighten', key: 'o', icon: <SunIcon aria-hidden="true" />, help: 'Lift under-eye circles or a face in shadow. Alt-click the tool, or press O again, for Darken.', size: 50, softness: 0.8, strength: 0.4 },
  { id: 'darken', name: 'Darken', key: 'o', icon: <MoonIcon aria-hidden="true" />, help: 'Calm a shiny forehead or a bright patch.', size: 50, softness: 0.8, strength: 0.4 },
  { id: 'whiten', name: 'Whiten teeth and eyes', key: 'w', icon: <SmileIcon aria-hidden="true" />, help: 'Paint over teeth or the whites of the eyes to take the yellow out.', size: 18, softness: 0.5, strength: 0.7 },
  { id: 'red_eye', name: 'Red eye', key: 'r', icon: <CircleIcon aria-hidden="true" />, help: 'Click the middle of a red eye. Only the red is changed.', size: 16, softness: 0.3, strength: 1 },
  { id: 'picker', name: 'White balance picker', key: 'i', icon: <PipetteIcon aria-hidden="true" />, help: 'Click something that should be white or grey, such as a shirt or a wall, to correct the colour of the whole photo.', size: 0, softness: 0, strength: 0 },
  { id: 'target', name: 'Drag a colour', key: 't', icon: <CrosshairIcon aria-hidden="true" />, help: 'Press on a colour in the photo and drag up or down to change it, as in the colour mixer.', size: 0, softness: 0, strength: 0 },
  { id: 'hand', name: 'Move around', key: 'h', icon: <HandIcon aria-hidden="true" />, help: 'Drag to move around the photo. Hold Space with any tool to do the same.', size: 0, softness: 0, strength: 0 },
];

/** Magic skin's one-click setting: a natural retouch that keeps skin texture. */
const SKIN_PRESET: SkinSettings = { smooth: 0.45, brighten: 0.25, even: 0.3 };

/** The mixer's colours, as hues in degrees, in Rust's order. */
const MIX_HUES = [0, 30, 60, 120, 180, 240, 270, 300];

/** How much a hue belongs to each mixer colour; the same sharing as Rust's band_weights. */
function bandWeights(hue: number): number[] {
  const h = ((hue % 360) + 360) % 360;
  const weights = new Array(8).fill(0);
  for (let i = 0; i < 8; i += 1) {
    const next = (i + 1) % 8;
    const start = MIX_HUES[i];
    const end = next === 0 ? 360 : MIX_HUES[next];
    if (h >= start && h < end) {
      const t = (h - start) / (end - start);
      weights[i] = 1 - t;
      weights[next] = t;
      break;
    }
  }
  return weights;
}

function hueOf([r, g, b]: number[]): { hue: number; colourful: boolean } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 12) return { hue: 0, colourful: false };
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue *= 60;
  return { hue: (hue + 360) % 360, colourful: true };
}

type MixChannel = 'mix_hue' | 'mix_saturation' | 'mix_luminance';

/** Colour copied from one photo, to paste on others. Kept while the app is open. */
let copiedColour: Adjustments | null = null;

const MIN_ZOOM_OF_FIT = 0.5;
/**
 * The quick picture shown while things change is about as big as it is on screen, so the
 * full one taking over is not seen. Sizes go in steps, as each new one starts afresh.
 */
const DRAFT_STEP = 256;
const DRAFT_LEAST = 768;
const DRAFT_MOST = 1536;
/** How long changes must stop before the full-size picture is drawn. */
const SETTLE_MS = 250;
/** Brushes whose result shows while painting. Healing looks around the whole mark first. */
const LIVE_TOOLS: RetouchTool[] = ['clone', 'smooth', 'brighten', 'darken', 'whiten'];
const MAX_ZOOM = 4;

/**
 * Magic Retouch: spot healing, clone stamp, brushes, red eye and colour, on one photo
 * at a time. Nothing here changes a file; saving hands the edits back.
 */
export default function Retoucher({
  items, startIndex = 0, mode, onSave, onClose,
}: {
  items: RetouchItem[];
  startIndex?: number;
  /** In an album the edits go back to the album; otherwise a copy is saved beside the photo. */
  mode: 'album' | 'files';
  /** Saves one photo. Resolves to a message for the photographer. */
  onSave: (item: RetouchItem) => Promise<string>;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(Math.min(startIndex, Math.max(0, items.length - 1)));
  const [work, setWork] = useState<Record<string, Work>>(() =>
    Object.fromEntries(items.map((i) => [i.photo.id, { edits: i.edits, adjust: i.adjust }])));
  const [saved, setSaved] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((i) => [i.photo.id, JSON.stringify({ edits: i.edits, adjust: i.adjust })])));
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [hasCopied, setHasCopied] = useState(copiedColour !== null);
  const [pasteTick, setPasteTick] = useState(0);

  const item = items[index];
  const unsaved = (id: string) => JSON.stringify(work[id]) !== saved[id];
  const anyUnsaved = items.some((i) => unsaved(i.photo.id));

  const change = useCallback((id: string, next: Work) => {
    setWork((all) => (all[id] === next ? all : { ...all, [id]: next }));
  }, []);

  async function save() {
    if (!item) return;
    const current = work[item.photo.id];
    setSaving(true);
    setNotice('');
    try {
      const message = await onSave({ photo: item.photo, ...current });
      setSaved((all) => ({ ...all, [item.photo.id]: JSON.stringify(current) }));
      setNotice(message);
      if (mode === 'album') onClose();
    } catch (e) {
      setNotice(`Could not save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function close() {
    if (anyUnsaved) {
      const leave = await ask('You have retouching that is not saved. Close without saving it?', {
        title: 'Magic Retouch',
        kind: 'warning',
        okLabel: 'Close without saving',
        cancelLabel: 'Keep retouching',
      });
      if (!leave) return;
    }
    onClose();
  }

  if (!item) return null;

  return (
    <div className="retoucher" role="dialog" aria-modal="true" aria-label="Magic Retouch">
      <header className="rt-head">
        <div className="rt-title">
          <WandSparklesIcon aria-hidden="true" />
          <strong>Magic Retouch</strong>
          <span className="muted">{item.photo.file_name}{items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}</span>
        </div>
        {notice && <span className="rt-notice" role="status">{notice}</span>}
        <div className="rt-head-actions">
          {items.length > 1 && (
            <button
              type="button"
              className="btn"
              disabled={!hasCopied}
              title="Give every photo here the copied colour"
              onClick={() => {
                if (!copiedColour) return;
                const colour = copiedColour;
                setWork((all) => Object.fromEntries(Object.entries(all).map(([id, w]) => [id, { ...w, adjust: colour }])));
                setPasteTick((t) => t + 1);
                setNotice(`Pasted the colour onto all ${items.length} photos. Save each one you want to keep.`);
              }}
            ><ClipboardPasteIcon aria-hidden="true" />Paste colour to all</button>
          )}
          <button type="button" className="btn" onClick={() => void close()}><XIcon aria-hidden="true" />{mode === 'album' ? 'Cancel' : 'Close'}</button>
          <button type="button" className="btn-primary" disabled={saving || (mode === 'files' && !unsaved(item.photo.id))} onClick={() => void save()}>
            <SaveIcon aria-hidden="true" />{saving ? 'Saving…' : mode === 'album' ? 'Apply to album' : 'Save copy'}
          </button>
        </div>
      </header>

      <PhotoEditor
        key={item.photo.id}
        photo={item.photo}
        initial={work[item.photo.id]}
        onChange={(next) => change(item.photo.id, next)}
        onNotice={setNotice}
        pasteTick={pasteTick}
        onCopied={() => setHasCopied(true)}
      />

      {items.length > 1 && (
        <nav className="rt-strip" aria-label="Photos to retouch">
          {items.map((i, at) => (
            <button
              key={i.photo.id}
              type="button"
              className={`rt-thumb ${at === index ? 'on' : ''}`}
              aria-current={at === index}
              title={i.photo.file_name}
              onClick={() => { setNotice(''); setIndex(at); }}
            >
              <img src={previewUrl(i.photo.id, GRID_PREVIEW)} alt={i.photo.file_name} loading="lazy" draggable={false} />
              {unsaved(i.photo.id) && <span className="rt-dot" aria-label="Not saved" />}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Draws a picture over the whole canvas. The size never changes, so it never goes blank. */
function paintPicture(canvas: HTMLCanvasElement, picture: ImageData) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (picture.width === canvas.width && picture.height === canvas.height) {
    ctx.putImageData(picture, 0, 0);
    return;
  }
  const small = document.createElement('canvas');
  small.width = picture.width;
  small.height = picture.height;
  small.getContext('2d')?.putImageData(picture, 0, 0);
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
}

/** A picture that does not change, such as the untouched photo. */
function Picture({ picture, className, style }: { picture: ImageData; className: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => { if (ref.current) paintPicture(ref.current, picture); }, [picture]);
  return <canvas ref={ref} className={className} style={style} width={picture.width} height={picture.height} aria-hidden="true" />;
}

function PhotoEditor({
  photo, initial, onChange, onNotice, pasteTick, onCopied,
}: {
  photo: PhotoInfo;
  initial: Work;
  onChange: (work: Work) => void;
  onNotice: (message: string) => void;
  /** Goes up when the colour is pasted onto every photo, this one included. */
  pasteTick: number;
  onCopied: () => void;
}) {
  const history = useHistory<Work>(initial);
  const work = history.present;
  const [toolId, setToolId] = useState<ToolInfo['id']>('heal');
  const [settings, setSettings] = useState<Record<string, { size: number; softness: number; strength: number }>>(
    () => Object.fromEntries(TOOLS.map((t) => [t.id, { size: t.size, softness: t.softness, strength: t.strength }])),
  );
  /** Whether the first picture has been drawn. */
  const [ready, setReady] = useState(false);
  const [original, setOriginal] = useState<ImageData | null>(null);
  const pictureRef = useRef<HTMLCanvasElement | null>(null);
  const pictures = useRef(0);
  const [busy, setBusy] = useState(false);
  // The editing preview's size, known from the photo, so a half-size draft and the full
  // picture line up and the brush means the same on both.
  const natural = useMemo(() => {
    const scale = Math.min(1, EDIT_PREVIEW / Math.max(photo.width, photo.height));
    return { w: Math.round(photo.width * scale), h: Math.round(photo.height * scale) };
  }, [photo.width, photo.height]);
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: 800, h: 600 });
  const [view, setView] = useState<{ zoom: number; x: number; y: number } | null>(null);
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(0.5);
  /** Once the line has been moved, the hint to drag it is not needed. */
  const [dragged, setDragged] = useState(false);
  const splitting = useRef(false);
  /** The brush outline hides while the pointer is on the before/after line. */
  const [onDivider, setOnDivider] = useState(false);
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [cloneSource, setCloneSource] = useState<[number, number] | null>(null);
  const [cloneOffset, setCloneOffset] = useState<[number, number] | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [faces, setFaces] = useState<number | null>(null);
  const [channel, setChannel] = useState<MixChannel>('mix_saturation');
  const targeting = useRef<{ y: number; weights: number[]; base: number[] } | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const photoRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef<{ points: [number, number][]; tool: RetouchTool } | null>(null);
  const panning = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const request = useRef(0);

  const tool = TOOLS.find((t) => t.id === toolId) ?? TOOLS[0];
  const setting = settings[tool.id];
  const longEdge = natural ? Math.max(natural.w, natural.h) : 2048;

  useEffect(() => { onChange(work); }, [work, onChange]);

  // Pasting onto every photo includes this one, which keeps its own undo.
  const firstTick = useRef(pasteTick);
  useEffect(() => {
    if (pasteTick === firstTick.current || !copiedColour) return;
    const colour = copiedColour;
    history.seal();
    history.set((w) => ({ ...w, adjust: colour }));
  }, [pasteTick, history]);

  // Magic skin needs the faces; finding them once, when the tool is first chosen.
  useEffect(() => {
    if (toolId !== 'skin' || faces !== null) return;
    prepareSkin(photo.id)
      .then(setFaces)
      .catch((e) => { setFaces(0); onNotice(`Could not look for faces: ${String(e)}`); });
  }, [toolId, faces, photo.id, onNotice]);

  const skin = work.edits.skin ?? NO_SKIN;
  const setSkin = (change: Partial<SkinSettings>, merge?: string) =>
    history.set((w) => ({ ...w, edits: { ...w.edits, skin: { ...NO_SKIN, ...w.edits.skin, ...change } } }), merge);

  /** The colour of the picture under the pointer, 0 to 255. */
  function colourAt(p: [number, number]): number[] | null {
    const ctx = pictureRef.current?.getContext('2d');
    if (!ctx) return null;
    const x = Math.min(natural.w - 1, Math.max(0, Math.round(p[0] * natural.w)));
    const y = Math.min(natural.h - 1, Math.max(0, Math.round(p[1] * natural.h)));
    return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
  }

  const clearOverlay = useCallback(() => {
    const c = overlayRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }, []);

  /*
   * The picture, drawn by Rust with every edit so far.
   *
   * One drawing at a time: while one is being made, changes only note that another is
   * wanted, so dragging a slider never piles up work. While changes keep coming, a quick
   * smaller picture follows them; once they stop, the full-size one replaces it.
   */
  const latest = useRef(work);
  const drawing_ = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftEdge = useRef(DRAFT_LEAST);
  const draw = useCallback((full: boolean) => {
    drawing_.current = true;
    setBusy(true);
    const asked = latest.current;
    const ticket = request.current + 1;
    request.current = ticket;
    retouchPreview(photo.id, asked.edits, asked.adjust, full ? EDIT_PREVIEW : draftEdge.current)
      .then((picture) => {
        if (request.current !== ticket) return;
        const canvas = pictureRef.current;
        if (!canvas) return;
        paintPicture(canvas, picture);
        pictures.current += 1;
        canvas.dataset.drawn = String(pictures.current);
        // The trail goes once the picture has the stroke that left it.
        if (latest.current === asked && !drawing.current) clearOverlay();
        setReady(true);
      })
      .catch((e) => { if (request.current === ticket) onNotice(`Could not draw the photo: ${String(e)}`); })
      .finally(() => {
        if (request.current !== ticket) return;
        drawing_.current = false;
        if (latest.current !== asked) {
          draw(false);
        } else if (!full) {
          settle.current = setTimeout(() => { if (!drawing_.current) draw(true); }, SETTLE_MS);
        } else {
          setBusy(false);
        }
      });
  }, [photo.id, onNotice, clearOverlay]);

  const first = useRef(true);
  useEffect(() => {
    latest.current = work;
    if (settle.current) clearTimeout(settle.current);
    settle.current = null;
    // The first picture is the full one; after that, quick ones while things change.
    const full = first.current;
    first.current = false;
    if (!drawing_.current) draw(full);
  }, [work, draw]);

  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current);
    // Whatever is still being drawn is for a photo no longer shown.
    request.current += 1;
    drawing_.current = false;
  }, []);

  // The untouched photo, for comparing.
  useEffect(() => {
    let live = true;
    retouchPreview(photo.id, NO_RETOUCH, NO_ADJUSTMENTS)
      .then((picture) => { if (live) setOriginal(picture); })
      .catch(() => {});
    return () => { live = false; };
  }, [photo.id]);

  // Measure the area the photo sits in.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStage({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fitZoom = natural ? Math.min((stage.w - 48) / natural.w, (stage.h - 48) / natural.h) : 1;
  const shown = view ?? { zoom: fitZoom, x: 0, y: 0 };

  useEffect(() => {
    const onScreen = longEdge * shown.zoom * window.devicePixelRatio;
    draftEdge.current = Math.min(DRAFT_MOST, Math.max(DRAFT_LEAST, Math.ceil(onScreen / DRAFT_STEP) * DRAFT_STEP));
  }, [longEdge, shown.zoom]);

  const setZoom = useCallback((zoom: number, around?: { x: number; y: number }) => {
    setView((v) => {
      const now = v ?? { zoom: fitZoom, x: 0, y: 0 };
      const next = Math.min(MAX_ZOOM, Math.max(fitZoom * MIN_ZOOM_OF_FIT, zoom));
      if (!around) return { zoom: next, x: now.x * (next / now.zoom), y: now.y * (next / now.zoom) };
      // Keep the point under the pointer where it is.
      const px = (around.x - now.x) / now.zoom;
      const py = (around.y - now.y) / now.zoom;
      return { zoom: next, x: around.x - px * next, y: around.y - py * next };
    });
  }, [fitZoom]);

  function toPhoto(e: { clientX: number; clientY: number }): [number, number] | null {
    const box = photoRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return null;
    return [(e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height];
  }

  function stagePoint(e: { clientX: number; clientY: number }) {
    const box = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - box.left - box.width / 2, y: e.clientY - box.top - box.height / 2 };
  }

  function paintTrail(p: [number, number]) {
    const c = overlayRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const r = setting.size;
    ctx.fillStyle = tool.id === 'clone' ? 'rgb(80 160 255 / 35%)' : 'rgb(233 30 120 / 32%)';
    ctx.beginPath();
    ctx.arc(p[0] * c.width, p[1] * c.height, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /** The stroke being painted, as it stands. */
  function strokeSoFar(d: { points: [number, number][]; tool: RetouchTool }): Stroke {
    const stroke: Stroke = {
      tool: d.tool,
      points: [...d.points],
      radius: setting.size / longEdge,
      softness: setting.softness,
      strength: setting.strength,
    };
    if (d.tool === 'clone' && cloneSource) {
      // The first stroke after choosing a copy point sets the offset; later strokes keep
      // it, so the copy moves along with the brush.
      stroke.source = cloneOffset ?? [cloneSource[0] - d.points[0][0], cloneSource[1] - d.points[0][1]];
    }
    return stroke;
  }

  /** Draws the stroke being painted into the picture, before it is finished. */
  function showStroke() {
    if (!drawing.current) return;
    latest.current = { ...work, edits: { ...work.edits, strokes: [...work.edits.strokes, strokeSoFar(drawing.current)] } };
    if (settle.current) clearTimeout(settle.current);
    settle.current = null;
    if (!drawing_.current) draw(false);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!natural) return;
    const panWanted = tool.id === 'hand' || spaceHeld || e.button === 1;
    if (panWanted) {
      e.currentTarget.setPointerCapture(e.pointerId);
      panning.current = { x: e.clientX, y: e.clientY, vx: shown.x, vy: shown.y };
      return;
    }
    if (e.button !== 0) return;
    const p = toPhoto(e);
    if (!p || p[0] < 0 || p[1] < 0 || p[0] > 1 || p[1] > 1) return;
    if (tool.id === 'skin') return;
    if (tool.id === 'picker') {
      neutralAt(photo.id, p[0], p[1])
        .then(([temperature, tint]) => {
          history.seal();
          history.set((w) => ({ ...w, adjust: { ...NO_ADJUSTMENTS, ...w.adjust, temperature, tint } }));
          onNotice('White balance set from that spot.');
        })
        .catch((err) => onNotice(String(err)));
      return;
    }
    if (tool.id === 'target') {
      const colour = colourAt(p);
      if (!colour) return;
      const { hue, colourful } = hueOf(colour);
      if (!colourful) {
        onNotice('That spot is grey, so it has no colour to change. Press on something colourful.');
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      history.seal();
      const now = { ...NO_ADJUSTMENTS, ...work.adjust };
      targeting.current = { y: e.clientY, weights: bandWeights(hue), base: [...now[channel]] };
      return;
    }
    const id = tool.id as RetouchTool;
    if (id === 'clone' && e.altKey) {
      setCloneSource(p);
      setCloneOffset(null);
      onNotice('Copy point set. Now paint where you want it copied.');
      return;
    }
    if (id === 'clone' && !cloneSource) {
      onNotice('Alt-click where to copy from first.');
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = { points: [p], tool: id };
    if (LIVE_TOOLS.includes(id)) showStroke();
    else paintTrail(p);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    setCursor(stagePoint(e));
    if (panning.current) {
      const from = panning.current;
      setView({ zoom: shown.zoom, x: from.vx + (e.clientX - from.x), y: from.vy + (e.clientY - from.y) });
      return;
    }
    const aim = targeting.current;
    if (aim) {
      // Up is more; a full photo height of drag is the whole range.
      const amount = (aim.y - e.clientY) / 200;
      const next = aim.base.map((v, i) => Math.max(-1, Math.min(1, v + aim.weights[i] * amount)));
      history.set((w) => ({ ...w, adjust: { ...NO_ADJUSTMENTS, ...w.adjust, [channel]: next } }), 'target');
      return;
    }
    const d = drawing.current;
    if (!d || d.tool === 'red_eye') return;
    const p = toPhoto(e);
    if (!p) return;
    const last = d.points[d.points.length - 1];
    const gap = Math.hypot((p[0] - last[0]) * (natural?.w ?? 1), (p[1] - last[1]) * (natural?.h ?? 1));
    if (gap < Math.max(1, setting.size * 0.2)) return;
    d.points.push(p);
    if (LIVE_TOOLS.includes(d.tool)) showStroke();
    else paintTrail(p);
  }

  function onPointerUp() {
    panning.current = null;
    if (targeting.current) {
      targeting.current = null;
      history.seal();
    }
    const d = drawing.current;
    drawing.current = null;
    if (!d) return;
    const stroke = strokeSoFar(d);
    if (stroke.source && !cloneOffset) setCloneOffset(stroke.source);
    history.set((w) => ({ ...w, edits: { ...w.edits, strokes: [...w.edits.strokes, stroke] } }));
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (!natural) return;
    setZoom(shown.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), stagePoint(e));
  }

  // Keys: tools, brush size, undo, and holding \ to see the original.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // A slider keeps the focus after it is moved, and types nothing.
      const typing = target instanceof HTMLInputElement && target.type !== 'range';
      if (typing || target?.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); history.redo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); setSpaceHeld(true); return; }
      if (e.key === '\\') { setHoldOriginal(true); return; }
      if (e.key === '[' || e.key === ']') {
        const f = e.key === ']' ? 1.15 : 1 / 1.15;
        setSettings((all) => ({ ...all, [toolId]: { ...all[toolId], size: Math.min(400, Math.max(2, Math.round(all[toolId].size * f))) } }));
        return;
      }
      if (k === 'o') { setToolId((t) => (t === 'brighten' ? 'darken' : 'brighten')); return; }
      const picked = TOOLS.find((t) => t.key === k);
      if (picked) setToolId(picked.id);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceHeld(false);
      if (e.key === '\\') setHoldOriginal(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [history, toolId]);

  const setTool = (id: ToolInfo['id'], alt: boolean) => {
    if (alt && id === 'brighten') setToolId('darken');
    else setToolId(id);
  };

  const changed = useMemo(
    () => work.edits.strokes.length > 0 || JSON.stringify(work.edits.skin ?? NO_SKIN) !== JSON.stringify(NO_SKIN) || JSON.stringify({ ...NO_ADJUSTMENTS, ...work.adjust }) !== JSON.stringify(NO_ADJUSTMENTS),
    [work],
  );

  const panMode = tool.id === 'hand' || spaceHeld;
  const brush = !['hand', 'skin', 'picker', 'target'].includes(tool.id);
  const showOriginalOnly = holdOriginal && original !== null;
  const cursorSize = setting.size * 2 * shown.zoom;

  return (
    <div className="rt-body">
      <div className="rt-tools" role="toolbar" aria-label="Retouch tools" aria-orientation="vertical">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`rt-tool ${toolId === t.id ? 'on' : ''}`}
            aria-pressed={toolId === t.id}
            aria-label={`${t.name} (${t.key.toUpperCase()})`}
            title={`${t.name} (${t.key.toUpperCase()})`}
            onClick={(e) => setTool(t.id, e.altKey)}
          >
            {t.icon}
          </button>
        ))}
      </div>

      <div
        ref={stageRef}
        className={`rt-stage ${panMode ? 'pan' : ''} ${brush ? '' : 'pointer'} ${tool.id === 'target' ? 'target' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {!ready && <div className="loader"><span className="loader-ring" aria-hidden="true" />Opening the photo…</div>}
        {natural && (
          <div
            ref={photoRef}
            className="rt-photo"
            style={{
              visibility: ready ? 'visible' : 'hidden',
              width: (natural?.w ?? 0) * shown.zoom,
              height: (natural?.h ?? 0) * shown.zoom,
              transform: `translate(calc(-50% + ${shown.x}px), calc(-50% + ${shown.y}px))`,
            }}
          >
            <canvas ref={pictureRef} className="rt-image" width={natural.w} height={natural.h} role="img" aria-label={photo.file_name} />
            {holdOriginal && original && <Picture picture={original} className="rt-image" />}
            {compare && original && !showOriginalOnly && (
              <>
                {/* Retouched on the left, the original on the right, as a printed before-and-after reads. */}
                <Picture picture={original} className="rt-original" style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }} />
                <span className="rt-compare-tag after" aria-hidden="true">After</span>
                <span className="rt-compare-tag before" aria-hidden="true">Before</span>
                <div
                  className="rt-divider"
                  style={{ left: `${split * 100}%` }}
                  onPointerDown={(e) => {
                    // Moving the line is not painting.
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    splitting.current = true;
                    setDragged(true);
                  }}
                  onPointerMove={(e) => {
                    if (!splitting.current) return;
                    const box = photoRef.current?.getBoundingClientRect();
                    if (box && box.width > 0) setSplit(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)));
                  }}
                  onPointerUp={() => { splitting.current = false; }}
                  onPointerCancel={() => { splitting.current = false; }}
                  onPointerEnter={() => setOnDivider(true)}
                  onPointerLeave={() => setOnDivider(false)}
                >
                  <span className="rt-divider-line" aria-hidden="true" />
                  <button
                    type="button"
                    className="rt-divider-handle"
                    role="slider"
                    aria-label="Where before and after meet"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(split * 100)}
                    onKeyDown={(e) => {
                      const step = e.shiftKey ? 0.1 : 0.02;
                      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); setDragged(true); setSplit((s) => Math.max(0, s - step)); }
                      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setDragged(true); setSplit((s) => Math.min(1, s + step)); }
                    }}
                  >‹ ›</button>
                </div>
              </>
            )}
            <canvas ref={overlayRef} className="rt-overlay" width={natural?.w ?? 1} height={natural?.h ?? 1} />
            {tool.id === 'clone' && cloneSource && (
              <span className="rt-source" style={{ left: `${cloneSource[0] * 100}%`, top: `${cloneSource[1] * 100}%` }} aria-hidden="true" />
            )}
          </div>
        )}
        {compare && !dragged && ready && (
          <span className="rt-compare-hint" aria-hidden="true"><MousePointer2Icon />Drag to compare</span>
        )}
        {cursor && !panMode && brush && ready && !(compare && onDivider) && (
          <span
            className="rt-cursor"
            style={{ width: cursorSize, height: cursorSize, transform: `translate(calc(${cursor.x}px - 50%), calc(${cursor.y}px - 50%))` }}
            aria-hidden="true"
          />
        )}
        {busy && ready && <span className="rt-busy"><span className="loader-ring" aria-hidden="true" />Working…</span>}
        {showOriginalOnly && <span className="rt-badge">Original</span>}
      </div>

      <aside className="rt-side" aria-label="Tool settings and colour">
        <section className="rt-section">
          <h3>{tool.name}</h3>
          <p className="muted">{tool.help}</p>
          {tool.id === 'skin' && (
            <>
              {faces === null && <p className="loader"><span className="loader-ring" aria-hidden="true" />Finding faces…</p>}
              {faces === 0 && <p className="warn">No face found in this photo, so Magic skin has nothing to do. The brushes still work.</p>}
              {faces !== null && faces > 0 && <p className="muted">{faces === 1 ? 'One face found.' : `${faces} faces found.`}</p>}
              <button
                type="button"
                className="btn-primary"
                disabled={!faces}
                onClick={() => { history.seal(); setSkin(SKIN_PRESET); }}
              ><SparklesIcon aria-hidden="true" />Retouch skin</button>
              <Slider label="Smooth" min={0} max={1} step={0.01} value={skin.smooth} shown={`${Math.round(skin.smooth * 100)}`}
                onStart={history.seal} onChange={(v) => setSkin({ smooth: v }, 'skin:smooth')} />
              <Slider label="Brighten" min={0} max={1} step={0.01} value={skin.brighten} shown={`${Math.round(skin.brighten * 100)}`}
                onStart={history.seal} onChange={(v) => setSkin({ brighten: v }, 'skin:brighten')} />
              <Slider label="Even tone" min={0} max={1} step={0.01} value={skin.even} shown={`${Math.round(skin.even * 100)}`}
                onStart={history.seal} onChange={(v) => setSkin({ even: v }, 'skin:even')} />
              <p className="muted">Up to 50 keeps skin texture. Higher gives a polished, magazine look.</p>
            </>
          )}
          {tool.id === 'target' && (
            <div className="segment" role="radiogroup" aria-label="What dragging changes">
              {([['mix_hue', 'Hue'], ['mix_saturation', 'Saturation'], ['mix_luminance', 'Luminance']] as const).map(([key, label]) => (
                <button key={key} type="button" role="radio" aria-checked={channel === key} className={channel === key ? 'on' : ''} onClick={() => setChannel(key)}>{label}</button>
              ))}
            </div>
          )}
          {!['hand', 'skin', 'picker', 'target'].includes(tool.id) && (
            <>
              <Slider label="Size" min={2} max={400} step={1} value={setting.size} shown={`${Math.round(setting.size)} px`}
                onChange={(v) => setSettings((all) => ({ ...all, [tool.id]: { ...all[tool.id], size: v } }))} />
              {tool.id !== 'red_eye' && (
                <Slider label="Softness" min={0} max={1} step={0.01} value={setting.softness} shown={`${Math.round(setting.softness * 100)}%`}
                  onChange={(v) => setSettings((all) => ({ ...all, [tool.id]: { ...all[tool.id], softness: v } }))} />
              )}
              <Slider label="Strength" min={0.05} max={1} step={0.01} value={setting.strength} shown={`${Math.round(setting.strength * 100)}%`}
                onChange={(v) => setSettings((all) => ({ ...all, [tool.id]: { ...all[tool.id], strength: v } }))} />
              <p className="muted">[ and ] change the size.</p>
            </>
          )}
          {tool.id === 'clone' && (
            <p className={cloneSource ? 'muted' : 'warn'}>{cloneSource ? 'Copying from the blue mark. Alt-click to choose another place.' : 'Alt-click where to copy from.'}</p>
          )}
        </section>

        <EffectsPanel
          title="Colour"
          hint="Light and colour for the whole photo."
          value={work.adjust}
          showOriginal={holdOriginal}
          autoBusy={autoBusy}
          onGestureStart={history.seal}
          onChange={(c) => history.set((w) => ({ ...w, adjust: { ...NO_ADJUSTMENTS, ...w.adjust, ...c } }), `adjust:${Object.keys(c).join(',')}`)}
          onAuto={() => {
            setAutoBusy(true);
            suggestColour(photo.id)
              .then((a) => { history.seal(); history.set((w) => ({ ...w, adjust: a })); })
              .catch((e) => onNotice(String(e)))
              .finally(() => setAutoBusy(false));
          }}
          onShowOriginal={setHoldOriginal}
        />
      </aside>

      <footer className="rt-foot">
        <button type="button" className="btn" disabled={!history.canUndo} onClick={history.undo} title="Undo (Ctrl+Z)"><Undo2Icon aria-hidden="true" />Undo</button>
        <button type="button" className="btn" disabled={!history.canRedo} onClick={history.redo} title="Redo (Ctrl+Shift+Z)"><Redo2Icon aria-hidden="true" />Redo</button>
        <button type="button" className={`btn ${compare ? 'on' : ''}`} aria-pressed={compare} onClick={() => setCompare((c) => !c)} title="Before and after. Hold \ to see the original."><SquareSplitHorizontalIcon aria-hidden="true" />Before / after</button>
        <button type="button" className="btn" title="Copy this photo's colour" onClick={() => { copiedColour = { ...NO_ADJUSTMENTS, ...work.adjust }; onCopied(); onNotice('Colour copied. Paste it on another photo.'); }}><ClipboardCopyIcon aria-hidden="true" />Copy colour</button>
        <button type="button" className="btn" disabled={!copiedColour} title="Give this photo the copied colour" onClick={() => { if (!copiedColour) return; const colour = copiedColour; history.seal(); history.set((w) => ({ ...w, adjust: colour })); }}><ClipboardPasteIcon aria-hidden="true" />Paste</button>
        <span className="rt-foot-gap" />
        <button type="button" className="btn" onClick={() => setZoom(shown.zoom / 1.25)} aria-label="Zoom out"><ZoomOutIcon aria-hidden="true" /></button>
        <button type="button" className="btn" onClick={() => setView(null)}>Fit</button>
        <button type="button" className="btn" onClick={() => setZoom(1)}>100%</button>
        <button type="button" className="btn" onClick={() => setZoom(shown.zoom * 1.25)} aria-label="Zoom in"><ZoomInIcon aria-hidden="true" /></button>
        <button
          type="button"
          className="btn"
          disabled={!changed}
          onClick={() => { history.seal(); history.set(() => ({ edits: NO_RETOUCH, adjust: NO_ADJUSTMENTS })); }}
        ><RotateCcwIcon aria-hidden="true" />Reset photo</button>
      </footer>
    </div>
  );
}

function Slider({
  label, min, max, step, value, shown, onChange, onStart,
}: {
  onStart?: () => void;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  shown: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="fx-row">
      <span className="fx-name">{label}</span>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onPointerDown={onStart} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{shown}</output>
    </label>
  );
}
