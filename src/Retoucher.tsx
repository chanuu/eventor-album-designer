import { ask } from '@tauri-apps/plugin-dialog';
import {
  BandageIcon, BrushIcon, CircleIcon, HandIcon, MoonIcon, Redo2Icon, RotateCcwIcon, SaveIcon,
  SmileIcon, SquareSplitHorizontalIcon, StampIcon, SunIcon, Undo2Icon, WandSparklesIcon, XIcon,
  ZoomInIcon, ZoomOutIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  GRID_PREVIEW, NO_RETOUCH, previewUrl, retouchPreview, suggestColour,
  type Adjustments, type PhotoInfo, type RetouchEdits, type RetouchTool, type Stroke,
} from './api';
import EffectsPanel, { NO_ADJUSTMENTS } from './EffectsPanel';
import { useHistory } from './history';

/** One photo in the retoucher, with its edits and colour as they stand. */
export type RetouchItem = { photo: PhotoInfo; edits: RetouchEdits; adjust: Adjustments };

type Work = { edits: RetouchEdits; adjust: Adjustments };

type ToolInfo = {
  id: RetouchTool | 'hand';
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
  { id: 'heal', name: 'Spot healing', key: 'j', icon: <BandageIcon aria-hidden="true" />, help: 'Paint over a pimple, mark or stray hair. It is replaced with matching skin from around it.', size: 14, softness: 0.4, strength: 1 },
  { id: 'clone', name: 'Clone stamp', key: 's', icon: <StampIcon aria-hidden="true" />, help: 'Alt-click where to copy from, then paint. Use it where healing guesses wrong, such as a sign behind a head.', size: 24, softness: 0.5, strength: 1 },
  { id: 'smooth', name: 'Smooth skin', key: 'b', icon: <BrushIcon aria-hidden="true" />, help: 'Paint smoothing just where you want it. Fine grain is kept so skin still looks like skin.', size: 60, softness: 0.7, strength: 0.6 },
  { id: 'brighten', name: 'Brighten', key: 'o', icon: <SunIcon aria-hidden="true" />, help: 'Lift under-eye circles or a face in shadow. Alt-click the tool, or press O again, for Darken.', size: 50, softness: 0.8, strength: 0.4 },
  { id: 'darken', name: 'Darken', key: 'o', icon: <MoonIcon aria-hidden="true" />, help: 'Calm a shiny forehead or a bright patch.', size: 50, softness: 0.8, strength: 0.4 },
  { id: 'whiten', name: 'Whiten teeth and eyes', key: 'w', icon: <SmileIcon aria-hidden="true" />, help: 'Paint over teeth or the whites of the eyes to take the yellow out.', size: 18, softness: 0.5, strength: 0.7 },
  { id: 'red_eye', name: 'Red eye', key: 'r', icon: <CircleIcon aria-hidden="true" />, help: 'Click the middle of a red eye. Only the red is changed.', size: 16, softness: 0.3, strength: 1 },
  { id: 'hand', name: 'Move around', key: 'h', icon: <HandIcon aria-hidden="true" />, help: 'Drag to move around the photo. Hold Space with any tool to do the same.', size: 0, softness: 0, strength: 0 },
];

const MIN_ZOOM_OF_FIT = 0.5;
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

function PhotoEditor({
  photo, initial, onChange, onNotice,
}: {
  photo: PhotoInfo;
  initial: Work;
  onChange: (work: Work) => void;
  onNotice: (message: string) => void;
}) {
  const history = useHistory<Work>(initial);
  const work = history.present;
  const [toolId, setToolId] = useState<ToolInfo['id']>('heal');
  const [settings, setSettings] = useState<Record<string, { size: number; softness: number; strength: number }>>(
    () => Object.fromEntries(TOOLS.map((t) => [t.id, { size: t.size, softness: t.softness, strength: t.strength }])),
  );
  const [url, setUrl] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [stage, setStage] = useState<{ w: number; h: number }>({ w: 800, h: 600 });
  const [view, setView] = useState<{ zoom: number; x: number; y: number } | null>(null);
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [holdOriginal, setHoldOriginal] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [cloneSource, setCloneSource] = useState<[number, number] | null>(null);
  const [cloneOffset, setCloneOffset] = useState<[number, number] | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);

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

  // The picture, drawn by Rust with every edit so far. Older answers are ignored.
  useEffect(() => {
    const ticket = request.current + 1;
    request.current = ticket;
    setBusy(true);
    retouchPreview(photo.id, work.edits, work.adjust)
      .then((blob) => {
        if (request.current !== ticket) return;
        const next = URL.createObjectURL(blob);
        setUrl((before) => { if (before) URL.revokeObjectURL(before); return next; });
      })
      .catch((e) => { if (request.current === ticket) onNotice(`Could not draw the photo: ${String(e)}`); })
      .finally(() => { if (request.current === ticket) setBusy(false); });
  }, [photo.id, work, onNotice]);

  // The untouched photo, for comparing.
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    retouchPreview(photo.id, NO_RETOUCH, NO_ADJUSTMENTS)
      .then((blob) => { if (live) { made = URL.createObjectURL(blob); setOriginalUrl(made); } })
      .catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [photo.id]);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

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

  // A new stroke's trail is cleared once the picture with it has arrived.
  const clearOverlay = useCallback(() => {
    const c = overlayRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }, []);

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
    paintTrail(p);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    setCursor(stagePoint(e));
    if (panning.current) {
      const from = panning.current;
      setView({ zoom: shown.zoom, x: from.vx + (e.clientX - from.x), y: from.vy + (e.clientY - from.y) });
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
    paintTrail(p);
  }

  function onPointerUp() {
    panning.current = null;
    const d = drawing.current;
    drawing.current = null;
    if (!d) return;
    const stroke: Stroke = {
      tool: d.tool,
      points: d.points,
      radius: setting.size / longEdge,
      softness: setting.softness,
      strength: setting.strength,
    };
    if (d.tool === 'clone' && cloneSource) {
      // The first stroke after choosing a copy point sets the offset; later strokes keep
      // it, so the copy moves along with the brush.
      const offset = cloneOffset ?? [cloneSource[0] - d.points[0][0], cloneSource[1] - d.points[0][1]] as [number, number];
      if (!cloneOffset) setCloneOffset(offset);
      stroke.source = offset;
    }
    history.set((w) => ({ ...w, edits: { strokes: [...w.edits.strokes, stroke] } }));
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (!natural) return;
    setZoom(shown.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), stagePoint(e));
  }

  // Keys: tools, brush size, undo, and holding \ to see the original.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
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
    () => work.edits.strokes.length > 0 || JSON.stringify({ ...NO_ADJUSTMENTS, ...work.adjust }) !== JSON.stringify(NO_ADJUSTMENTS),
    [work],
  );

  const panMode = tool.id === 'hand' || spaceHeld;
  const showOriginalOnly = holdOriginal && !!originalUrl;
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
        className={`rt-stage ${panMode ? 'pan' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setCursor(null)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      >
        {!url && <div className="loader"><span className="loader-ring" aria-hidden="true" />Opening the photo…</div>}
        {url && (
          <div
            ref={photoRef}
            className="rt-photo"
            style={{
              width: (natural?.w ?? 0) * shown.zoom,
              height: (natural?.h ?? 0) * shown.zoom,
              transform: `translate(calc(-50% + ${shown.x}px), calc(-50% + ${shown.y}px))`,
            }}
          >
            <img
              src={showOriginalOnly ? originalUrl! : url}
              alt={photo.file_name}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (!natural) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
                if (!showOriginalOnly) clearOverlay();
              }}
            />
            {compare && originalUrl && !showOriginalOnly && (
              <>
                <img className="rt-original" src={originalUrl} alt="" draggable={false} style={{ clipPath: `inset(0 ${100 - split * 100}% 0 0)` }} />
                <span className="rt-split" style={{ left: `${split * 100}%` }} aria-hidden="true" />
              </>
            )}
            <canvas ref={overlayRef} className="rt-overlay" width={natural?.w ?? 1} height={natural?.h ?? 1} />
            {tool.id === 'clone' && cloneSource && (
              <span className="rt-source" style={{ left: `${cloneSource[0] * 100}%`, top: `${cloneSource[1] * 100}%` }} aria-hidden="true" />
            )}
          </div>
        )}
        {cursor && !panMode && url && (
          <span
            className="rt-cursor"
            style={{ width: cursorSize, height: cursorSize, transform: `translate(calc(${cursor.x}px - 50%), calc(${cursor.y}px - 50%))` }}
            aria-hidden="true"
          />
        )}
        {busy && url && <span className="rt-busy"><span className="loader-ring" aria-hidden="true" />Working…</span>}
        {showOriginalOnly && <span className="rt-badge">Original</span>}
      </div>

      <aside className="rt-side" aria-label="Tool settings and colour">
        <section className="rt-section">
          <h3>{tool.name}</h3>
          <p className="muted">{tool.help}</p>
          {tool.id !== 'hand' && (
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
        {compare && (
          <input type="range" aria-label="Where the before and after meet" min={0} max={1} step={0.005} value={split} onChange={(e) => setSplit(Number(e.target.value))} className="rt-split-range" />
        )}
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
  label, min, max, step, value, shown, onChange,
}: {
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
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{shown}</output>
    </label>
  );
}
