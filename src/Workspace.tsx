import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  EDIT_PREVIEW,
  GRID_PREVIEW,
  importFolder,
  previewUrl,
  printOptions,
  suggestLayouts,
  type Frame,
  type LayoutOption,
  type PhotoInfo,
  type SpreadDesign,
} from './api';
import type { Album } from './App';
import { effectiveDpi, visibleArea } from './crop';

type Spread = {
  id: string;
  photoIds: string[];
  options: LayoutOption[];
  optionIndex: number;
  design: SpreadDesign;
};

type Thresholds = { warn: number; tooLow: number };

const DRAG_PHOTOS = 'application/x-album-photos';
const DRAG_FRAME = 'application/x-album-frame';
const MAX_ZOOM = 3;

function percent(part: number, whole: number): string {
  return `${(part / whole) * 100}%`;
}

export default function Workspace({ album }: { album: Album }) {
  const { spec } = album;
  const [photos, setPhotos] = useState<PhotoInfo[]>([]);
  const [spreads, setSpreads] = useState<Spread[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [frameId, setFrameId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'unused' | 'used'>('all');
  const [search, setSearch] = useState('');
  const [guides, setGuides] = useState(true);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [thresholds, setThresholds] = useState<Thresholds>({ warn: 0, tooLow: 0 });

  useEffect(() => {
    printOptions()
      .then((o) => setThresholds({ warn: o.dpi_warn, tooLow: o.dpi_too_low }))
      .catch((e) => setNotice(String(e)));
  }, []);

  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const current = spreads.find((s) => s.id === currentId) ?? null;
  const frame = current?.design.frames.find((f) => f.id === frameId) ?? null;

  const usedIds = useMemo(() => new Set(spreads.flatMap((s) => s.photoIds)), [spreads]);

  const shown = photos.filter((p) => {
    if (filter === 'used' && !usedIds.has(p.id)) return false;
    if (filter === 'unused' && usedIds.has(p.id)) return false;
    return p.file_name.toLowerCase().includes(search.trim().toLowerCase());
  });

  async function chooseFolder() {
    const folder = await open({ directory: true, title: 'Choose a folder of photos' });
    if (typeof folder !== 'string') return;
    setImporting(true);
    setNotice('');
    try {
      const scan = await importFolder(folder);
      setPhotos((before) => {
        const known = new Set(before.map((p) => p.id));
        return [...before, ...scan.photos.filter((p) => !known.has(p.id))];
      });
      const parts = [`Found ${scan.photos.length} photo${scan.photos.length === 1 ? '' : 's'}.`];
      if (scan.skipped.length) {
        const names = scan.skipped.slice(0, 3).map((s) => s.file_name).join(', ');
        parts.push(`Could not read ${scan.skipped.length}: ${names}${scan.skipped.length > 3 ? '…' : ''}`);
      }
      setNotice(parts.join(' '));
    } catch (e) {
      setNotice(`Could not read that folder: ${String(e)}`);
    } finally {
      setImporting(false);
    }
  }

  /** The best layouts for a set of photos, or null with a message if none fits. */
  const layoutFor = useCallback(
    async (photoIds: string[]) => {
      const list = photoIds.flatMap((id) => byId.get(id) ?? []);
      const options = await suggestLayouts(list, spec);
      if (!options.length) {
        setNotice(`There is no layout for ${list.length} photos on one spread yet. Try fewer.`);
        return null;
      }
      return options;
    },
    [byId, spec],
  );

  /** Adds photos to a spread, or starts a new one, and picks the layout automatically. */
  async function addPhotos(ids: string[], spreadId: string | null) {
    const target = spreads.find((s) => s.id === spreadId) ?? null;
    const photoIds = [...new Set([...(target?.photoIds ?? []), ...ids])];
    if (!photoIds.length) return;
    const options = await layoutFor(photoIds);
    if (!options) return;

    setNotice('');
    setFrameId(null);
    setSelected(new Set());
    const update = { photoIds, options, optionIndex: 0, design: options[0].design };
    if (target) {
      setSpreads((all) => all.map((s) => (s.id === target.id ? { ...s, ...update } : s)));
    } else {
      const id = crypto.randomUUID();
      setSpreads((all) => [...all, { id, ...update }]);
      setCurrentId(id);
    }
  }

  async function removeFromSpread(spread: Spread, photoId: string) {
    const photoIds = spread.photoIds.filter((id) => id !== photoId);
    setFrameId(null);
    if (!photoIds.length) {
      deleteSpread(spread.id);
      return;
    }
    const options = await layoutFor(photoIds);
    if (!options) return;
    setSpreads((all) =>
      all.map((s) =>
        s.id === spread.id ? { ...s, photoIds, options, optionIndex: 0, design: options[0].design } : s,
      ),
    );
  }

  function deleteSpread(id: string) {
    const at = spreads.findIndex((s) => s.id === id);
    const neighbour = spreads[at + 1] ?? spreads[at - 1] ?? null;
    setSpreads((all) => all.filter((s) => s.id !== id));
    setCurrentId(neighbour?.id ?? null);
    setFrameId(null);
  }

  function moveSpread(id: string, by: -1 | 1) {
    setSpreads((all) => {
      const at = all.findIndex((s) => s.id === id);
      const to = at + by;
      if (at < 0 || to < 0 || to >= all.length) return all;
      const next = [...all];
      [next[at], next[to]] = [next[to], next[at]];
      return next;
    });
  }

  /** Tries the next layout. The photos stay the same, and only their places change. */
  const cycleLayout = useCallback((step: -1 | 1) => {
    setFrameId(null);
    setSpreads((all) =>
      all.map((s) => {
        if (s.id !== currentId || s.options.length < 2) return s;
        const optionIndex = (s.optionIndex + step + s.options.length) % s.options.length;
        return { ...s, optionIndex, design: s.options[optionIndex].design };
      }),
    );
  }, [currentId]);

  const changeFrames = useCallback((change: (frames: Frame[]) => Frame[]) => {
    setSpreads((all) =>
      all.map((s) =>
        s.id === currentId ? { ...s, design: { ...s.design, frames: change(s.design.frames) } } : s,
      ),
    );
  }, [currentId]);

  const changeFit = useCallback((id: string, fit: Partial<Frame['fit']>) => {
    changeFrames((frames) =>
      frames.map((f) => (f.id === id ? { ...f, fit: { ...f.fit, ...fit } } : f)),
    );
  }, [changeFrames]);

  function swapFrames(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    changeFrames((frames) => {
      const source = frames.find((f) => f.id === sourceId);
      const target = frames.find((f) => f.id === targetId);
      if (!source || !target) return frames;
      return frames.map((f) => {
        if (f.id === sourceId) return { ...f, asset_id: target.asset_id, fit: target.fit };
        if (f.id === targetId) return { ...f, asset_id: source.asset_id, fit: source.fit };
        return f;
      });
    });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof Element && e.target.closest('input, select, textarea');
      if (typing) return;
      if (e.key === '[') cycleLayout(-1);
      if (e.key === ']') cycleLayout(1);
      if (e.key === 'Escape') setFrameId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycleLayout]);

  function clickPhoto(e: React.MouseEvent, id: string) {
    setSelected((before) => {
      const next = new Set(e.ctrlKey || e.metaKey ? before : []);
      if (before.has(id) && (e.ctrlKey || e.metaKey)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedIds = photos.filter((p) => selected.has(p.id)).map((p) => p.id);

  function droppedPhotos(e: React.DragEvent): string[] {
    const raw = e.dataTransfer.getData(DRAG_PHOTOS);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  const option = current?.options[current.optionIndex];
  const framePhoto = frame?.asset_id ? byId.get(frame.asset_id) : undefined;
  const frameDpi = frame && framePhoto ? Math.round(effectiveDpi(framePhoto, frame)) : null;

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="title">
          <strong>{album.name}</strong>
          <span>
            {album.sizeLabel} · {spec.binding === 'layflat' ? 'Lay-flat' : 'Magazine'} ·{' '}
            {spreads.length} spread{spreads.length === 1 ? '' : 's'}
          </span>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} />
          Print guides
        </label>
        <button type="button" className="btn-primary" disabled={importing} onClick={() => void chooseFolder()}>
          {importing ? 'Reading photos…' : 'Import photos'}
        </button>
      </header>

      {notice && (
        <p className="notice" role="status">
          {notice}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice('')}>×</button>
        </p>
      )}

      <div className="stage">
        <section
          className="canvas-area"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const ids = droppedPhotos(e);
            if (ids.length) void addPhotos(ids, currentId);
          }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setFrameId(null);
          }}
        >
          {current ? (
            <SpreadCanvas
              design={current.design}
              spec={album.spec}
              photos={byId}
              guides={guides}
              thresholds={thresholds}
              selectedId={frameId}
              onSelect={setFrameId}
              onFit={changeFit}
              onSwap={swapFrames}
            />
          ) : (
            <div className="empty-stage">
              <h2>{photos.length ? 'Drag photos here' : 'Start by importing photos'}</h2>
              <p>
                {photos.length
                  ? 'Select a few below and drop them here. The layout is picked for you.'
                  : 'Your originals stay where they are and are never changed.'}
              </p>
            </div>
          )}
        </section>

        <aside className="side">
          {current && option ? (
            <>
              <h3>Layout</h3>
              <div className="cycler">
                <button type="button" aria-label="Previous layout" title="Previous layout ( [ )" onClick={() => cycleLayout(-1)}>‹</button>
                <div>
                  <strong>{option.name}</strong>
                  <span>
                    {current.optionIndex + 1} of {current.options.length} · {Math.round(option.crop_loss * 100)}% cropped
                  </span>
                </div>
                <button type="button" aria-label="Next layout" title="Next layout ( ] )" onClick={() => cycleLayout(1)}>›</button>
              </div>
              <p className="muted">Press [ and ] to try other layouts.</p>
            </>
          ) : (
            <p className="muted">Select a spread to change its layout.</p>
          )}

          {frame && framePhoto && current && (
            <>
              <h3>Selected photo</h3>
              <p className="file-name" title={framePhoto.path}>{framePhoto.file_name}</p>
              {frameDpi !== null && (
                <p className={frameDpi < thresholds.tooLow ? 'error' : frameDpi < thresholds.warn ? 'warn' : 'muted'}>
                  Prints at {frameDpi} DPI
                </p>
              )}
              <label className="field">
                Zoom
                <input
                  type="range"
                  min={1}
                  max={MAX_ZOOM}
                  step={0.01}
                  value={frame.fit.scale}
                  onChange={(e) => changeFit(frame.id, { scale: Number(e.target.value) })}
                />
              </label>
              <p className="muted">Drag the photo to reposition it. Drag another photo to swap them.</p>
              <button type="button" className="btn" onClick={() => changeFit(frame.id, { scale: 1, cx: 0.5, cy: 0.5 })}>
                Reset crop
              </button>
              <button type="button" className="btn" onClick={() => void removeFromSpread(current, framePhoto.id)}>
                Remove from spread
              </button>
            </>
          )}
        </aside>
      </div>

      <section className="timeline" aria-label="Spreads">
        {spreads.map((s, i) => (
          <div key={s.id} className="spread-item">
            <button
              type="button"
              aria-label={`Spread ${i + 1}`}
              aria-current={s.id === currentId}
              className={`spread-thumb ${s.id === currentId ? 'on' : ''}`}
              style={{ aspectRatio: String(s.design.size_mm.w / s.design.size_mm.h), background: s.design.background.value }}
              onClick={() => { setCurrentId(s.id); setFrameId(null); }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const ids = droppedPhotos(e);
                if (ids.length) void addPhotos(ids, s.id);
              }}
            >
              {s.design.frames.map((f) => {
                const photo = f.asset_id ? byId.get(f.asset_id) : undefined;
                return (
                  <span key={f.id} className="frame" style={frameStyle(f, s.design)}>
                    {photo && <FramedPhoto photo={photo} frame={f} width={GRID_PREVIEW} />}
                  </span>
                );
              })}
            </button>
            <div className="spread-actions">
              <span>{i + 1}</span>
              <button type="button" aria-label={`Move spread ${i + 1} earlier`} disabled={i === 0} onClick={() => moveSpread(s.id, -1)}>←</button>
              <button type="button" aria-label={`Move spread ${i + 1} later`} disabled={i === spreads.length - 1} onClick={() => moveSpread(s.id, 1)}>→</button>
              <button type="button" aria-label={`Delete spread ${i + 1}`} onClick={() => deleteSpread(s.id)}>×</button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="add-spread"
          disabled={!selectedIds.length}
          title={selectedIds.length ? 'Make a new spread from the selected photos' : 'Select photos first'}
          onClick={() => void addPhotos(selectedIds, null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const ids = droppedPhotos(e);
            if (ids.length) void addPhotos(ids, null);
          }}
        >
          + New spread
        </button>
      </section>

      <section className="browser" aria-label="Photos">
        <div className="browser-bar">
          <strong>
            Photos <span className="muted">{usedIds.size} of {photos.length} used</span>
          </strong>
          <div className="segment">
            {(['all', 'unused', 'used'] as const).map((key) => (
              <button key={key} type="button" aria-pressed={filter === key} className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>
                {key === 'all' ? 'All' : key === 'unused' ? 'Unused' : 'Used'}
              </button>
            ))}
          </div>
          <input className="input search" aria-label="Search photos" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          {selectedIds.length > 0 && current && (
            <button type="button" className="btn" onClick={() => void addPhotos(selectedIds, current.id)}>
              Add {selectedIds.length} to this spread
            </button>
          )}
          <span className="muted hint">Ctrl+click to select several</span>
        </div>
        <div className="grid">
          {shown.map((photo) => (
            <button
              key={photo.id}
              type="button"
              draggable
              title={photo.file_name}
              aria-pressed={selected.has(photo.id)}
              className={`photo ${selected.has(photo.id) ? 'on' : ''} ${usedIds.has(photo.id) ? 'used' : ''}`}
              onClick={(e) => clickPhoto(e, photo.id)}
              onDragStart={(e) => {
                const ids = selected.has(photo.id) ? selectedIds : [photo.id];
                e.dataTransfer.setData(DRAG_PHOTOS, JSON.stringify(ids));
                e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <img src={previewUrl(photo.id, GRID_PREVIEW)} alt={photo.file_name} loading="lazy" decoding="async" draggable={false} />
              {usedIds.has(photo.id) && <span className="badge">Used</span>}
            </button>
          ))}
          {!shown.length && (
            <p className="muted grid-empty">
              {photos.length ? 'No photos match.' : 'No photos yet.'}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function frameStyle(frame: Frame, design: SpreadDesign): React.CSSProperties {
  const { rect_mm: r } = frame;
  return {
    left: percent(r.x, design.size_mm.w),
    top: percent(r.y, design.size_mm.h),
    width: percent(r.w, design.size_mm.w),
    height: percent(r.h, design.size_mm.h),
    zIndex: frame.z,
  };
}

function FramedPhoto({ photo, frame, width }: { photo: PhotoInfo; frame: Frame; width: number }) {
  const area = visibleArea(photo.width / photo.height, frame.rect_mm.w / frame.rect_mm.h, frame.fit);
  return (
    <img
      src={previewUrl(photo.id, width)}
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

function SpreadCanvas({
  design, spec, photos, guides, thresholds, selectedId, onSelect, onFit, onSwap,
}: {
  design: SpreadDesign;
  spec: Album['spec'];
  photos: Map<string, PhotoInfo>;
  guides: boolean;
  thresholds: Thresholds;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onFit: (id: string, fit: Partial<Frame['fit']>) => void;
  onSwap: (sourceId: string, targetId: string) => void;
}) {
  const { w, h } = design.size_mm;
  const pan = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const safe = spec.bleed_mm + spec.safe_mm;

  return (
    <div
      className="spread"
      // Fits the area whichever way it is tighter, and always keeps the book's true shape.
      style={{
        width: `min(100cqw, calc(100cqh * ${w / h}))`,
        aspectRatio: String(w / h),
        background: design.background.value,
      }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
    >
      {design.frames.map((frame) => {
        const photo = frame.asset_id ? photos.get(frame.asset_id) : undefined;
        const selected = frame.id === selectedId;
        const dpi = photo ? effectiveDpi(photo, frame) : null;
        const soft = dpi !== null && dpi < thresholds.warn;
        const aspect = frame.rect_mm.w / frame.rect_mm.h;
        return (
          <div
            key={frame.id}
            role="button"
            tabIndex={0}
            aria-label={photo ? `Frame with ${photo.file_name}` : 'Empty frame'}
            aria-pressed={selected}
            // A selected frame pans its photo, so only an unselected one drags to swap.
            draggable={!selected}
            className={`frame ${selected ? 'selected panning' : ''}`}
            style={{ ...frameStyle(frame, design), touchAction: selected ? 'none' : undefined }}
            onClick={() => onSelect(frame.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(frame.id); } }}
            onDragStart={(e) => e.dataTransfer.setData(DRAG_FRAME, frame.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const source = e.dataTransfer.getData(DRAG_FRAME);
              if (source) {
                e.preventDefault();
                e.stopPropagation();
                onSwap(source, frame.id);
              }
            }}
            onPointerDown={(e) => {
              if (!selected || !photo) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              pan.current = { x: e.clientX, y: e.clientY, cx: frame.fit.cx, cy: frame.fit.cy };
            }}
            onPointerMove={(e) => {
              if (!pan.current || !selected || !photo) return;
              const box = e.currentTarget.getBoundingClientRect();
              const area = visibleArea(photo.width / photo.height, aspect, frame.fit);
              // Dragging right reveals more of the photo's left, hence the minus.
              const cx = pan.current.cx - ((e.clientX - pan.current.x) / box.width) * area.sw;
              const cy = pan.current.cy - ((e.clientY - pan.current.y) / box.height) * area.sh;
              onFit(frame.id, {
                cx: Math.min(1 - area.sw / 2, Math.max(area.sw / 2, cx)),
                cy: Math.min(1 - area.sh / 2, Math.max(area.sh / 2, cy)),
              });
            }}
            onPointerUp={() => { pan.current = null; }}
            onPointerCancel={() => { pan.current = null; }}
          >
            {photo && <FramedPhoto photo={photo} frame={frame} width={EDIT_PREVIEW} />}
            {guides && soft && dpi !== null && (
              <span className={`dpi ${dpi < thresholds.tooLow ? 'too-low' : 'low'}`}>{Math.round(dpi)} DPI</span>
            )}
          </div>
        );
      })}
      {guides && (
        <>
          <span className="guide trim" style={{ left: percent(spec.bleed_mm, w), right: percent(spec.bleed_mm, w), top: percent(spec.bleed_mm, h), bottom: percent(spec.bleed_mm, h) }} />
          <span className="guide safe" style={{ left: percent(safe, w), right: percent(safe, w), top: percent(safe, h), bottom: percent(safe, h) }} />
        </>
      )}
      <span className="fold" />
    </div>
  );
}
