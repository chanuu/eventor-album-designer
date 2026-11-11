import { BringToFrontIcon, CropIcon, MousePointer2Icon, SendToBackIcon, Trash2Icon } from 'lucide-react';
import { SparklesIcon } from 'lucide-react';
import {
  AlignCenterHorizontalIcon, AlignCenterVerticalIcon, AlignEndHorizontalIcon, AlignEndVerticalIcon,
  AlignStartHorizontalIcon, AlignStartVerticalIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Adjustments, Frame, PhotoInfo, ProjectSpec, SpreadDesign, TextBlock } from './api';
import {
  alignRect,
  boundsOf,
  HANDLES,
  intersects,
  mapRect,
  MAX_ITEM_SHARE_OF_SPREAD,
  MIN_ITEM_MM,
  resizedBox,
  snapTo,
  type AlignKind,
  type Handle,
  type Rect,
} from './designerGeometry';
import EffectsPanel, { NO_ADJUSTMENTS } from './EffectsPanel';
import { visibleArea } from './crop';
import { DRAG_PHOTOS, foldStyle, FrameBorder, FramedPhoto, frameStyle, percent, useTextImage } from './spreadParts';
import TextPanel from './TextPanel';
import { TEXT_TEMPLATES, type TextTemplate } from './textTemplates';

const ALIGN_ICONS = {
  left: AlignStartVerticalIcon,
  centre: AlignCenterVerticalIcon,
  right: AlignEndVerticalIcon,
  top: AlignStartHorizontalIcon,
  middle: AlignCenterHorizontalIcon,
  bottom: AlignEndHorizontalIcon,
};

const MM_PER_INCH = 25.4;
const SNAP_REACH_MM = 2;
const NUDGE_MM = 1;
const LARGE_NUDGE_MM = 10;
const MAX_ZOOM = 3;
const WHEEL_ZOOM_STEP = 0.0015;
const MAX_BORDER_MM = 15;
const MAX_RADIUS_MM = 60;
const BORDER_COLOURS = ['#FFFFFF', '#000000', '#3A3A3A', '#C9A24B', '#8C1D40', '#1F3A5F'];

type Tool = 'select' | 'photo';

type Snapshot = { frames: Map<string, Frame>; texts: Map<string, TextBlock> };

type Gesture =
  | { kind: 'move'; id: string; plain: boolean; startX: number; startY: number; box: Rect; snapshot: Snapshot; moved: boolean }
  | { kind: 'scale'; handle: Handle; startX: number; startY: number; box: Rect; snapshot: Snapshot }
  | { kind: 'marquee'; startX: number; startY: number; add: boolean; base: Set<string> }
  | { kind: 'pan'; id: string; startX: number; startY: number; cx: number; cy: number };

function inches(mm: number): string {
  return (mm / MM_PER_INCH).toFixed(3);
}

export default function Designer({
  design, spec, photos, thresholds, paperColours, fonts, showOriginal, autoBusy, onChange, onSeal, onAuto,
  onShowOriginal, onAddPhoto, onReplacePhoto, onAutoDesign,
}: {
  design: SpreadDesign;
  spec: ProjectSpec;
  photos: Map<string, PhotoInfo>;
  thresholds: { warn: number; tooLow: number };
  paperColours: string[];
  fonts: string[];
  showOriginal: boolean;
  autoBusy: boolean;
  onChange: (change: (d: SpreadDesign) => SpreadDesign, mergeKey?: string) => void;
  onSeal: () => void;
  onAuto: (frameIds: Set<string> | null) => void;
  onShowOriginal: (show: boolean) => void;
  onAddPhoto: (photoIds: string[], xMm: number, yMm: number) => void;
  onReplacePhoto: (frameId: string, photoId: string) => void;
  onAutoDesign: () => void;
}) {
  const { w, h } = design.size_mm;
  const canvas = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<Tool>('select');
  const [cropId, setCropId] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [overflowing, setOverflowing] = useState<Set<string>>(new Set());

  const frames = useMemo(() => design.frames.filter((f) => selected.has(f.id)), [design.frames, selected]);
  const texts = useMemo(() => design.texts.filter((t) => selected.has(t.id)), [design.texts, selected]);
  const box = boundsOf([...frames.map((f) => f.rect_mm), ...texts.map((t) => t.rect_mm)]);
  const count = frames.length + texts.length;

  const px = useCallback(() => {
    const rect = canvas.current?.getBoundingClientRect();
    return { mmPerPx: rect ? w / rect.width : 1, left: rect?.left ?? 0, top: rect?.top ?? 0 };
  }, [w]);

  const toMm = (e: { clientX: number; clientY: number }) => {
    const { mmPerPx, left, top } = px();
    return { x: (e.clientX - left) * mmPerPx, y: (e.clientY - top) * mmPerPx };
  };

  /** Moving things by hand means this is no longer one of the pack's layouts. */
  const edit = useCallback((change: (d: SpreadDesign) => SpreadDesign, key?: string) => {
    onChange((d) => ({ ...change(d), template_id: null }), key);
  }, [onChange]);

  const applyBox = useCallback((snapshot: Snapshot, from: Rect, to: Rect, key: string, scaleText: boolean) => {
    // Text keeps its size unless the whole selection is being scaled evenly.
    const textScale = scaleText ? Math.min(to.w / from.w, to.h / from.h) : 1;
    edit((d) => ({
      ...d,
      frames: d.frames.map((f) => {
        const was = snapshot.frames.get(f.id);
        return was ? { ...f, rect_mm: mapRect(was.rect_mm, from, to) } : f;
      }),
      texts: d.texts.map((t) => {
        const was = snapshot.texts.get(t.id);
        return was ? { ...t, rect_mm: mapRect(was.rect_mm, from, to), size_pt: was.size_pt * textScale } : t;
      }),
    }), key);
  }, [edit]);

  const snapshotOf = (ids: Set<string>): Snapshot => ({
    frames: new Map(design.frames.filter((f) => ids.has(f.id)).map((f) => [f.id, f])),
    texts: new Map(design.texts.filter((t) => ids.has(t.id)).map((t) => [t.id, t])),
  });

  function guideLines(ids: Set<string>) {
    const inset = spec.bleed_mm + spec.safe_mm;
    const xs = [inset, w / 4, w / 2, (w * 3) / 4, w - inset];
    const ys = [inset, h / 2, h - inset];
    // Other items are worth lining up with, as well as the page.
    for (const item of [...design.frames, ...design.texts]) {
      if (ids.has(item.id)) continue;
      const r = item.rect_mm;
      xs.push(r.x, r.x + r.w / 2, r.x + r.w);
      ys.push(r.y, r.y + r.h / 2, r.y + r.h);
    }
    return { xs, ys };
  }

  function pressItem(e: React.PointerEvent, id: string) {
    e.stopPropagation();
    if (tool === 'photo') {
      const frame = design.frames.find((f) => f.id === id);
      if (!frame?.asset_id) return;
      setCropId(id);
      setSelected(new Set([id]));
      onSeal();
      canvas.current?.setPointerCapture(e.pointerId);
      gesture.current = { kind: 'pan', id, startX: e.clientX, startY: e.clientY, cx: frame.fit.cx, cy: frame.fit.cy };
      return;
    }

    let next = selected;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
    } else if (!selected.has(id)) {
      next = new Set([id]);
    }
    setSelected(next);
    if (!next.has(id)) return;

    const snapshot = snapshotOf(next);
    const start = boundsOf([...snapshot.frames.values(), ...snapshot.texts.values()].map((i) => i.rect_mm));
    if (!start) return;
    onSeal();
    canvas.current?.setPointerCapture(e.pointerId);
    const plain = !(e.shiftKey || e.ctrlKey || e.metaKey);
    gesture.current = { kind: 'move', id, plain, startX: e.clientX, startY: e.clientY, box: start, snapshot, moved: false };
  }

  function pressHandle(e: React.PointerEvent, handle: Handle) {
    e.stopPropagation();
    if (!box) return;
    onSeal();
    canvas.current?.setPointerCapture(e.pointerId);
    gesture.current = { kind: 'scale', handle, startX: e.clientX, startY: e.clientY, box, snapshot: snapshotOf(selected) };
  }

  function pressCanvas(e: React.PointerEvent) {
    if (tool === 'photo') {
      setTool('select');
      setCropId(null);
    }
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!add) setSelected(new Set());
    canvas.current?.setPointerCapture(e.pointerId);
    const { x, y } = toMm(e);
    gesture.current = { kind: 'marquee', startX: x, startY: y, add, base: add ? selected : new Set() };
  }

  function movePointer(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g) return;
    const { mmPerPx } = px();

    if (g.kind === 'marquee') {
      const { x, y } = toMm(e);
      const rect = {
        x: Math.min(x, g.startX),
        y: Math.min(y, g.startY),
        w: Math.abs(x - g.startX),
        h: Math.abs(y - g.startY),
      };
      setMarquee(rect);
      const hit = [...design.frames, ...design.texts].filter((i) => intersects(i.rect_mm, rect)).map((i) => i.id);
      setSelected(new Set([...g.base, ...hit]));
      return;
    }

    const dx = (e.clientX - g.startX) * mmPerPx;
    const dy = (e.clientY - g.startY) * mmPerPx;

    if (g.kind === 'pan') {
      const frame = design.frames.find((f) => f.id === g.id);
      const photo = frame?.asset_id ? photos.get(frame.asset_id) : undefined;
      if (!frame || !photo) return;
      const area = visibleArea(photo.width / photo.height, frame.rect_mm.w / frame.rect_mm.h, frame.fit);
      // Dragging right reveals more of the photo's left, hence the minus.
      const cx = g.cx - (dx / frame.rect_mm.w) * area.sw;
      const cy = g.cy - (dy / frame.rect_mm.h) * area.sh;
      onChange((d) => ({
        ...d,
        frames: d.frames.map((f) => (f.id === g.id ? {
          ...f,
          fit: {
            ...f.fit,
            cx: Math.min(1 - area.sw / 2, Math.max(area.sw / 2, cx)),
            cy: Math.min(1 - area.sh / 2, Math.max(area.sh / 2, cy)),
          },
        } : f)),
      }), `pan:${g.id}`);
      return;
    }

    if (g.kind === 'move') {
      if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 2) return;
      g.moved = true;
      let x = g.box.x + dx;
      let y = g.box.y + dy;
      // Alt turns snapping off, for placing something deliberately just off a guide.
      const lines = guideLines(selected);
      const snapX = e.altKey ? null : snapTo([x, x + g.box.w / 2, x + g.box.w], lines.xs, SNAP_REACH_MM);
      const snapY = e.altKey ? null : snapTo([y, y + g.box.h / 2, y + g.box.h], lines.ys, SNAP_REACH_MM);
      if (snapX) x += snapX.shift;
      if (snapY) y += snapY.shift;
      setGuides({ x: snapX?.line ?? null, y: snapY?.line ?? null });
      applyBox(g.snapshot, g.box, { ...g.box, x, y }, 'designer-move', false);
      return;
    }

    // Corners keep a group's proportions. For one item, Shift does, so it can also be reshaped.
    const many = g.snapshot.frames.size + g.snapshot.texts.size > 1;
    const corner = g.handle.dx !== 0 && g.handle.dy !== 0;
    const keepShape = corner && (many !== e.shiftKey);
    const to = resizedBox(g.box, g.handle, dx, dy, keepShape);
    const limited = {
      ...to,
      w: Math.min(to.w, w * MAX_ITEM_SHARE_OF_SPREAD),
      h: Math.min(to.h, h * MAX_ITEM_SHARE_OF_SPREAD),
    };
    applyBox(g.snapshot, g.box, limited, 'designer-scale', keepShape);
  }

  function release() {
    // A click on one item of a group picks it out; only a drag moves the whole group.
    const g = gesture.current;
    if (g?.kind === 'move' && g.plain && !g.moved) setSelected(new Set([g.id]));
    gesture.current = null;
    setGuides({ x: null, y: null });
    setMarquee(null);
  }

  /** Scrolling over a photo in crop mode zooms it inside its frame. */
  function wheel(e: React.WheelEvent, frame: Frame) {
    if (tool !== 'photo') return;
    const scale = Math.min(MAX_ZOOM, Math.max(1, frame.fit.scale - e.deltaY * WHEEL_ZOOM_STEP));
    onChange((d) => ({
      ...d,
      frames: d.frames.map((f) => (f.id === frame.id ? { ...f, fit: { ...f.fit, scale } } : f)),
    }), `pan:${frame.id}`);
  }

  const deleteSelected = useCallback(() => {
    onSeal();
    edit((d) => ({
      ...d,
      frames: d.frames.filter((f) => !selected.has(f.id)),
      texts: d.texts.filter((t) => !selected.has(t.id)),
    }));
    setSelected(new Set());
  }, [edit, onSeal, selected]);

  const nudge = useCallback((dx: number, dy: number) => {
    edit((d) => ({
      ...d,
      frames: d.frames.map((f) => (selected.has(f.id) ? { ...f, rect_mm: { ...f.rect_mm, x: f.rect_mm.x + dx, y: f.rect_mm.y + dy } } : f)),
      texts: d.texts.map((t) => (selected.has(t.id) ? { ...t, rect_mm: { ...t.rect_mm, x: t.rect_mm.x + dx, y: t.rect_mm.y + dy } } : t)),
    }), 'designer-nudge');
  }, [edit, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set([...design.frames, ...design.texts].map((i) => i.id)));
        return;
      }
      if (e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape') {
        setTool('select');
        setCropId(null);
        setSelected(new Set());
        return;
      }
      if (!selected.size) return;
      const step = e.shiftKey ? LARGE_NUDGE_MM : NUDGE_MM;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === 'ArrowLeft') nudge(-step, 0);
      else if (e.key === 'ArrowRight') nudge(step, 0);
      else if (e.key === 'ArrowUp') nudge(0, -step);
      else if (e.key === 'ArrowDown') nudge(0, step);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [design.frames, design.texts, selected, deleteSelected, nudge]);

  // Undo can remove something that is selected.
  useEffect(() => {
    setSelected((before) => {
      const all = new Set([...design.frames, ...design.texts].map((i) => i.id));
      const next = new Set([...before].filter((id) => all.has(id)));
      return next.size === before.size ? before : next;
    });
  }, [design.frames, design.texts]);

  function typedBox(change: Partial<Rect>) {
    if (!box) return;
    const to = { ...box, ...change };
    if (!(to.w >= MIN_ITEM_MM) || !(to.h >= MIN_ITEM_MM) || ![to.x, to.y, to.w, to.h].every(Number.isFinite)) return;
    onSeal();
    applyBox(snapshotOf(selected), box, to, 'designer-typed', false);
    onSeal();
  }

  function align(kind: AlignKind) {
    if (!box) return;
    // One item lines up with its own page, because there is nothing else to line up with.
    const page = (box.x + box.w / 2) < w / 2
      ? { x: spec.bleed_mm, y: spec.bleed_mm, w: w / 2 - spec.bleed_mm, h: h - spec.bleed_mm * 2 }
      : { x: w / 2, y: spec.bleed_mm, w: w / 2 - spec.bleed_mm, h: h - spec.bleed_mm * 2 };
    const within = count === 1 ? page : box;
    onSeal();
    edit((d) => ({
      ...d,
      frames: d.frames.map((f) => (selected.has(f.id) ? { ...f, rect_mm: alignRect(f.rect_mm, kind, within) } : f)),
      texts: d.texts.map((t) => (selected.has(t.id) ? { ...t, rect_mm: alignRect(t.rect_mm, kind, within) } : t)),
    }));
  }

  function restack(toFront: boolean) {
    const zs = design.frames.map((f) => f.z);
    const z = toFront ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1;
    onSeal();
    edit((d) => ({ ...d, frames: d.frames.map((f) => (selected.has(f.id) ? { ...f, z } : f)) }));
  }

  function addTemplate(template: TextTemplate) {
    const width = w * template.width;
    const height = h * template.height;
    const left = (w * 3) / 4 - width / 2;
    const top = h / 2 - height / 2;
    const made: TextBlock[] = template.blocks.map((b) => ({
      id: crypto.randomUUID(),
      rect_mm: { x: left + b.x * width, y: top + b.y * height, w: b.w * width, h: b.h * height },
      text: b.text,
      font: fonts.includes(b.font) ? b.font : '',
      size_pt: b.size_pt,
      colour: '#000000',
      align: b.align,
      bold: b.bold,
      italic: b.italic,
      line_height: b.line_height,
      opacity: 1,
    }));
    onSeal();
    edit((d) => ({ ...d, texts: [...d.texts, ...made] }));
    setTool('select');
    setSelected(new Set(made.map((t) => t.id)));
  }

  function changeFrames(change: (f: Frame) => Frame, key: string) {
    onChange((d) => ({ ...d, frames: d.frames.map((f) => (selected.has(f.id) ? change(f) : f)) }), key);
  }

  function changeTexts(change: Partial<TextBlock>, key: string) {
    onChange((d) => ({ ...d, texts: d.texts.map((t) => (selected.has(t.id) ? { ...t, ...change } : t)) }), key);
  }

  function changeEffects(change: Partial<Adjustments>) {
    // With nothing selected, effects go to every photo on the spread.
    const everything = frames.length === 0;
    onChange((d) => ({
      ...d,
      frames: d.frames.map((f) => (
        everything || selected.has(f.id) ? { ...f, adjust: { ...f.adjust, ...change } } : f
      )),
    }), 'designer-fx');
  }

  function drop(e: React.DragEvent, frameId: string | null) {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData(DRAG_PHOTOS);
    if (!raw) return;
    const ids = JSON.parse(raw) as string[];
    if (frameId && ids[0]) onReplacePhoto(frameId, ids[0]);
    else {
      const { x, y } = toMm(e);
      onAddPhoto(ids, x, y);
    }
  }

  const single = frames.length === 1 && texts.length === 0 ? frames[0] : null;
  const singleText = texts.length === 1 && frames.length === 0 ? texts[0] : null;
  const firstFrame = frames[0];
  const opacity = firstFrame?.style.opacity ?? texts[0]?.opacity ?? 1;
  const inset = spec.bleed_mm + spec.safe_mm;
  const noteOverflow = useCallback((id: string, over: boolean) => {
    setOverflowing((before) => {
      if (before.has(id) === over) return before;
      const next = new Set(before);
      if (over) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  return (
    <div className="designer">
      <div className="designer-rail" role="toolbar" aria-label="Tools">
        <button type="button" aria-pressed={tool === 'select'} className={tool === 'select' ? 'on' : ''} onClick={() => { setTool('select'); setCropId(null); }}><MousePointer2Icon aria-hidden="true" />Select</button>
        <button type="button" aria-pressed={tool === 'photo'} className={tool === 'photo' ? 'on' : ''} title="Drag a photo inside its frame, and scroll to zoom it" onClick={() => setTool('photo')}><CropIcon aria-hidden="true" />Crop</button>
      </div>

      <div className="designer-main">
        <div className="designer-bar">
          <span className="muted designer-count">
            {count ? `${count} selected` : 'Click an item, or drag a box around several'}
          </span>
          {box && (
            <div className="xywh">
              <Measure label="X" mm={box.x - spec.bleed_mm} onCommit={(v) => typedBox({ x: v + spec.bleed_mm })} />
              <Measure label="Y" mm={box.y - spec.bleed_mm} onCommit={(v) => typedBox({ y: v + spec.bleed_mm })} />
              <Measure label="W" mm={box.w} onCommit={(v) => typedBox({ w: v })} />
              <Measure label="H" mm={box.h} onCommit={(v) => typedBox({ h: v })} />
            </div>
          )}
          <span className="topbar-gap" />
          <button type="button" className="btn-primary" title="Try a different layout for these photos" onClick={onAutoDesign}>
            <SparklesIcon aria-hidden="true" />Auto design
          </button>
        </div>

        {/* The selection box can start outside the spread, since photos may cover all of it. */}
        <div
          className="designer-area"
          onPointerDown={pressCanvas}
          onPointerMove={movePointer}
          onPointerUp={release}
          onPointerCancel={release}
        >
          <div
            ref={canvas}
            className={`spread designer-canvas ${tool === 'photo' ? 'crop-tool' : ''}`}
            style={{ width: `min(100cqw, calc(100cqh * ${w / h}))`, aspectRatio: String(w / h), background: design.background.value }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => drop(e, null)}
          >
            {design.frames.map((frame) => {
              const photo = frame.asset_id ? photos.get(frame.asset_id) : undefined;
              return (
                <div
                  key={frame.id}
                  role="button"
                  tabIndex={0}
                  aria-label={photo ? `Frame with ${photo.file_name}` : 'Empty frame'}
                  aria-pressed={selected.has(frame.id)}
                  className={`frame d-item ${cropId === frame.id ? 'cropping' : ''}`}
                  style={frameStyle(frame, design)}
                  onPointerDown={(e) => pressItem(e, frame.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setTool('photo');
                    setCropId(frame.id);
                    setSelected(new Set([frame.id]));
                  }}
                  onWheel={(e) => wheel(e, frame)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => drop(e, frame.id)}
                >
                  {photo && <FramedPhoto photo={photo} frame={frame} width={2048} original={showOriginal} />}
                  <FrameBorder frame={frame} design={design} />
                </div>
              );
            })}

            {design.texts.map((block) => (
              <DesignerText
                key={block.id}
                block={block}
                design={design}
                onPress={(e) => pressItem(e, block.id)}
                onOverflow={(over) => noteOverflow(block.id, over)}
                overflowing={overflowing.has(block.id)}
              />
            ))}

            <span className="guide trim" style={{ left: percent(spec.bleed_mm, w), right: percent(spec.bleed_mm, w), top: percent(spec.bleed_mm, h), bottom: percent(spec.bleed_mm, h) }} />
            <span className="guide safe" style={{ left: percent(inset, w), right: percent(inset, w), top: percent(inset, h), bottom: percent(inset, h) }} />
            <span className="fold" style={foldStyle(spec.binding, w)} />

            {[...frames, ...texts].map((item) => (
              <span
                key={item.id}
                className="d-outline"
                style={{ left: percent(item.rect_mm.x, w), top: percent(item.rect_mm.y, h), width: percent(item.rect_mm.w, w), height: percent(item.rect_mm.h, h) }}
              />
            ))}

            {box && tool === 'select' && (
              <div
                className="d-box"
                style={{ left: percent(box.x, w), top: percent(box.y, h), width: percent(box.w, w), height: percent(box.h, h) }}
              >
                {HANDLES.map((handle) => (
                  <span
                    key={handle.key}
                    className={`d-handle ${handle.key}`}
                    aria-label={`Resize ${handle.key}`}
                    onPointerDown={(e) => pressHandle(e, handle)}
                  />
                ))}
              </div>
            )}

            {marquee && (
              <span
                className="d-marquee"
                style={{ left: percent(marquee.x, w), top: percent(marquee.y, h), width: percent(marquee.w, w), height: percent(marquee.h, h) }}
              />
            )}
            {guides.x !== null && <span className="snap-line x" style={{ left: percent(guides.x, w) }} />}
            {guides.y !== null && <span className="snap-line y" style={{ top: percent(guides.y, h) }} />}
          </div>
        </div>
      </div>

      <aside className="side designer-side">
        {count === 0 ? (
          <>
            <section aria-label="Text templates">
              <h3>Text templates</h3>
              <p className="muted">Click one to add it, then change the words, font and colour.</p>
              <div className="text-templates">
                {TEXT_TEMPLATES.map((template) => (
                  <button key={template.key} type="button" className="text-template" onClick={() => addTemplate(template)}>
                    <strong>{template.name}</strong>
                    <span style={{ fontFamily: template.blocks[0].font }}>{template.blocks[0].text}</span>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h3>Paper for this spread</h3>
              <div className="swatches">
                {paperColours.map((colour) => (
                  <button
                    key={colour}
                    type="button"
                    aria-label={`Paper colour ${colour}`}
                    aria-pressed={design.background.value === colour}
                    className={`swatch ${design.background.value === colour ? 'on' : ''}`}
                    style={{ background: colour }}
                    onClick={() => {
                      onSeal();
                      onChange((d) => ({ ...d, background: { type: 'color', value: colour } }));
                    }}
                  />
                ))}
              </div>
            </section>
          </>
        ) : (
          <>
            <section aria-label="Design">
              <h3>Design</h3>
              <Slider
                label="Opacity"
                value={Math.round(opacity * 100)}
                min={0}
                max={100}
                unit="%"
                onStart={onSeal}
                onChange={(percentage) => {
                  const value = percentage / 100;
                  onChange((d) => ({
                    ...d,
                    frames: d.frames.map((f) => (selected.has(f.id) ? { ...f, style: { ...f.style, opacity: value } } : f)),
                    texts: d.texts.map((t) => (selected.has(t.id) ? { ...t, opacity: value } : t)),
                  }), 'designer-opacity');
                }}
              />
              {firstFrame && (
                <>
                  <Slider
                    label="Border"
                    value={firstFrame.style.border_mm}
                    min={0}
                    max={MAX_BORDER_MM}
                    step={0.1}
                    unit="mm"
                    onStart={onSeal}
                    onChange={(border_mm) => changeFrames((f) => ({ ...f, style: { ...f.style, border_mm } }), 'designer-border')}
                  />
                  <div className="swatches small">
                    {BORDER_COLOURS.map((colour) => (
                      <button
                        key={colour}
                        type="button"
                        aria-label={`Border colour ${colour}`}
                        aria-pressed={firstFrame.style.border_colour === colour}
                        className={`swatch ${firstFrame.style.border_colour === colour ? 'on' : ''}`}
                        style={{ background: colour }}
                        onClick={() => {
                          onSeal();
                          changeFrames((f) => ({ ...f, style: { ...f.style, border_colour: colour } }), 'designer-border-colour');
                        }}
                      />
                    ))}
                    <input
                      type="color"
                      className="colour-pick"
                      aria-label="Choose any border colour"
                      value={firstFrame.style.border_colour}
                      onPointerDown={onSeal}
                      onChange={(e) => changeFrames((f) => ({ ...f, style: { ...f.style, border_colour: e.target.value } }), 'designer-border-colour')}
                    />
                  </div>
                  <Slider
                    label="Corners"
                    value={firstFrame.corner_radius_mm}
                    min={0}
                    max={MAX_RADIUS_MM}
                    step={0.5}
                    unit="mm"
                    onStart={onSeal}
                    onChange={(corner_radius_mm) => changeFrames((f) => ({ ...f, corner_radius_mm }), 'designer-radius')}
                  />
                </>
              )}
              {texts.length > 1 && (
                <div className="swatches small">
                  {['#000000', '#FFFFFF', '#C9A24B', '#8C1D40'].map((colour) => (
                    <button
                      key={colour}
                      type="button"
                      aria-label={`Colour of selected text ${colour}`}
                      className="swatch"
                      style={{ background: colour }}
                      onClick={() => {
                        onSeal();
                        changeTexts({ colour }, 'designer-text-colour');
                      }}
                    />
                  ))}
                </div>
              )}
            </section>

            <section aria-label="Arrange">
              <h3>Arrange</h3>
              <div className="arrange">
                {(['left', 'centre', 'right', 'top', 'middle', 'bottom'] as const).map((kind) => (
                  <button key={kind} type="button" className="btn" onClick={() => align(kind)}>
                    {(() => { const Icon = ALIGN_ICONS[kind]; return <Icon aria-hidden="true" />; })()}{kind[0].toUpperCase() + kind.slice(1)}
                  </button>
                ))}
              </div>
              {frames.length > 0 && (
                <div className="arrange two">
                  <button type="button" className="btn" onClick={() => restack(true)}><BringToFrontIcon aria-hidden="true" />To front</button>
                  <button type="button" className="btn" onClick={() => restack(false)}><SendToBackIcon aria-hidden="true" />To back</button>
                </div>
              )}
              <button type="button" className="btn" onClick={deleteSelected}><Trash2Icon aria-hidden="true" />Delete</button>
            </section>

            {singleText && (
              <TextPanel
                block={singleText}
                fonts={fonts}
                overflowed={overflowing.has(singleText.id)}
                onChange={(change) => changeTexts(change, `text:${singleText.id}`)}
                onGestureStart={onSeal}
                onDelete={deleteSelected}
              />
            )}

            {single?.asset_id && (
              <section>
                <h3>Photo</h3>
                <label className="fx-row">
                  <span>Zoom</span>
                  <input
                    type="range"
                    aria-label="Photo zoom"
                    min={1}
                    max={MAX_ZOOM}
                    step={0.01}
                    value={single.fit.scale}
                    onPointerDown={onSeal}
                    onChange={(e) => changeFrames((f) => ({ ...f, fit: { ...f.fit, scale: Number(e.target.value) } }), 'designer-zoom')}
                  />
                  <output>{single.fit.scale.toFixed(2)}</output>
                </label>
                {(() => {
                  const photo = photos.get(single.asset_id!);
                  if (!photo) return null;
                  const area = visibleArea(photo.width / photo.height, single.rect_mm.w / single.rect_mm.h, single.fit);
                  const dpi = Math.round((photo.width * area.sw) / (single.rect_mm.w / MM_PER_INCH));
                  return (
                    <p className={dpi < thresholds.tooLow ? 'error' : dpi < thresholds.warn ? 'warn' : 'muted'}>
                      Prints at {dpi} DPI
                    </p>
                  );
                })()}
              </section>
            )}
          </>
        )}

        {(frames.length > 0 || count === 0) && design.frames.length > 0 && (
          <EffectsPanel
            title={frames.length ? `Effects for ${frames.length === 1 ? 'this photo' : `${frames.length} photos`}` : 'Effects for this spread'}
            hint={frames.length ? 'Only the selected photos change.' : 'Every photo on the spread. Select some to change only those.'}
            value={firstFrame?.adjust ?? design.frames[0]?.adjust ?? NO_ADJUSTMENTS}
            onChange={changeEffects}
            onGestureStart={onSeal}
            showOriginal={showOriginal}
            autoBusy={autoBusy}
            onAuto={() => onAuto(frames.length ? selected : null)}
            onShowOriginal={onShowOriginal}
          />
        )}
      </aside>
    </div>
  );
}

function DesignerText({
  block, design, onPress, onOverflow, overflowing,
}: {
  block: TextBlock;
  design: SpreadDesign;
  onPress: (e: React.PointerEvent) => void;
  onOverflow: (overflowed: boolean) => void;
  overflowing: boolean;
}) {
  const url = useTextImage(block, onOverflow);
  const r = block.rect_mm;
  const { w, h } = design.size_mm;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Text: ${block.text.slice(0, 40)}`}
      className={`text-block d-item ${overflowing ? 'overflowing' : ''}`}
      style={{ left: percent(r.x, w), top: percent(r.y, h), width: percent(r.w, w), height: percent(r.h, h), opacity: block.opacity }}
      onPointerDown={onPress}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {url && <img src={url} alt="" draggable={false} />}
    </div>
  );
}

/** A number in inches, committed when the field is left or Enter is pressed. */
function Measure({ label, mm, onCommit }: { label: string; mm: number; onCommit: (mm: number) => void }) {
  const [text, setText] = useState(inches(mm));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(inches(mm));
  }, [mm, focused]);

  const commit = () => {
    const value = Number(text);
    if (Number.isFinite(value) && inches(mm) !== text) onCommit(value * MM_PER_INCH);
  };
  return (
    <label className="measure">
      <span>{label}</span>
      <input
        aria-label={`${label} in inches`}
        inputMode="decimal"
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <span className="muted">in</span>
    </label>
  );
}

function Slider({
  label, value, min, max, step = 1, unit, onStart, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onStart: () => void;
  onChange: (value: number) => void;
}) {
  return (
    <label className="fx-row">
      <span>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onStart}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{step < 1 ? value.toFixed(1) : Math.round(value)}{unit}</output>
    </label>
  );
}
