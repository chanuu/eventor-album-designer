import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  EDIT_PREVIEW,
  GRID_PREVIEW,
  importFolder,
  previewUrl,
  printOptions,
  relinkPhotos,
  saveAlbum,
  suggestLayouts,
  type Frame,
  type PhotoInfo,
  type Project,
  type Spread,
  type SpreadDesign,
} from './api';
import type { Album } from './App';
import { effectiveDpi, visibleArea } from './crop';
import ExportDialog from './ExportDialog';
import { useHistory } from './history';
import { ALBUM_EXTENSION, ALBUM_FILTERS, toProject } from './project';

type Thresholds = { warn: number; tooLow: number };

const DRAG_PHOTOS = 'application/x-album-photos';
const DRAG_FRAME = 'application/x-album-frame';
const MAX_ZOOM = 3;

/** How long after the last change an already-saved album saves itself. */
const AUTOSAVE_DELAY_MS = 1500;

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed';

function percent(part: number, whole: number): string {
  return `${(part / whole) * 100}%`;
}

export default function Workspace({ album }: { album: Album }) {
  const { spec } = album;
  const [photos, setPhotos] = useState<PhotoInfo[]>(album.photos);
  const history = useHistory<Spread[]>(album.spreads);
  const spreads = history.present;
  const setSpreads = history.set;
  const [missing, setMissing] = useState<Set<string>>(new Set(album.missing));
  const [path, setPath] = useState<string | null>(album.path);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(album.path ? 'saved' : 'unsaved');
  const [currentId, setCurrentId] = useState<string | null>(album.spreads[0]?.id ?? null);
  const [frameId, setFrameId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'unused' | 'used'>('all');
  const [search, setSearch] = useState('');
  const [guides, setGuides] = useState(true);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [exportProject, setExportProject] = useState<Project | null>(null);
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

  // Undo can remove the spread on screen, so fall back to one that still exists.
  useEffect(() => {
    if (!spreads.some((s) => s.id === currentId)) setCurrentId(spreads[0]?.id ?? null);
  }, [spreads, currentId]);

  const latest = useRef({ photos, spreads, path, dirty: false });
  latest.current.path = path;
  useEffect(() => {
    if (latest.current.photos === photos && latest.current.spreads === spreads) return;
    latest.current = { ...latest.current, photos, spreads, dirty: true };
    setSaveStatus('unsaved');
  }, [photos, spreads]);

  // One save at a time, because they share a temporary file.
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  /** Writes the album. Resolves to false if it could not. */
  const writeTo = useCallback((target: string) => {
    const run = async () => {
      const snapshot = latest.current;
      setSaveStatus('saving');
      try {
        await saveAlbum(target, toProject(album, snapshot.photos, snapshot.spreads));
        if (latest.current === snapshot) {
          latest.current.dirty = false;
          setSaveStatus('saved');
        } else {
          setSaveStatus('unsaved');
        }
        return true;
      } catch (e) {
        setSaveStatus('failed');
        setNotice(String(e));
        return false;
      }
    };
    const result = saving.current.then(run);
    saving.current = result;
    return result;
  }, [album]);

  const saveAs = useCallback(async () => {
    const chosen = await save({
      title: 'Save album',
      defaultPath: `${album.name}.${ALBUM_EXTENSION}`,
      filters: ALBUM_FILTERS,
    });
    if (!chosen) return false;
    const ok = await writeTo(chosen);
    if (ok) setPath(chosen);
    return ok;
  }, [album.name, writeTo]);

  const saveNow = useCallback(
    () => (latest.current.path ? writeTo(latest.current.path) : saveAs()),
    [saveAs, writeTo],
  );

  // A saved album keeps itself saved. A new one waits until it has a place to go.
  useEffect(() => {
    if (!path || saveStatus !== 'unsaved') return;
    const timer = setTimeout(() => void writeTo(path), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [path, saveStatus, photos, spreads, writeTo]);

  // Closing must never quietly lose work.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const stop = appWindow.onCloseRequested(async (event) => {
      const { dirty, path: savedAt } = latest.current;
      if (!dirty) return;
      if (savedAt && (await writeTo(savedAt))) return;
      event.preventDefault();
      try {
        const discard = await ask('This album has unsaved changes. Close without saving?', {
          title: 'Unsaved changes',
          kind: 'warning',
        });
        if (discard) await appWindow.destroy();
      } catch (e) {
        setNotice(`Could not close: ${String(e)}. Save the album, then close again.`);
      }
    });
    return () => {
      void stop.then((unlisten) => unlisten());
    };
  }, [writeTo]);

  const shown = photos.filter((p) => {
    if (filter === 'used' && !usedIds.has(p.id)) return false;
    if (filter === 'unused' && usedIds.has(p.id)) return false;
    return p.file_name.toLowerCase().includes(search.trim().toLowerCase());
  });

  async function findMissing() {
    const folder = await open({ directory: true, title: 'Choose the folder with the moved photos' });
    if (typeof folder !== 'string') return;
    try {
      const found = await relinkPhotos(folder, [...missing]);
      const byPhoto = new Map(found.map((p) => [p.id, p]));
      setPhotos((all) => all.map((p) => byPhoto.get(p.id) ?? p));
      const left = new Set([...missing].filter((id) => !byPhoto.has(id)));
      setMissing(left);
      setNotice(
        `Found ${found.length} photo${found.length === 1 ? '' : 's'}.`
          + (left.size ? ` ${left.size} still missing.` : ''),
      );
    } catch (e) {
      setNotice(`Could not read that folder: ${String(e)}`);
    }
  }

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
  }, [currentId, setSpreads]);

  const changeFrames = useCallback((change: (frames: Frame[]) => Frame[], mergeKey?: string) => {
    setSpreads(
      (all) =>
        all.map((s) =>
          s.id === currentId ? { ...s, design: { ...s.design, frames: change(s.design.frames) } } : s,
        ),
      mergeKey,
    );
  }, [currentId, setSpreads]);

  const changeFit = useCallback((id: string, fit: Partial<Frame['fit']>) => {
    // One drag or slider movement is one undo step, not hundreds.
    changeFrames(
      (frames) => frames.map((f) => (f.id === id ? { ...f, fit: { ...f.fit, ...fit } } : f)),
      `fit:${id}`,
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

  const { undo, redo } = history;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = e.ctrlKey || e.metaKey;
      if (command && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
        return;
      }
      const typing = e.target instanceof Element && e.target.closest('input, select, textarea');
      if (typing) return;
      if (command && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setFrameId(null);
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (command && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        setFrameId(null);
        redo();
        return;
      }
      if (e.key === '[') cycleLayout(-1);
      if (e.key === ']') cycleLayout(1);
      if (e.key === 'Escape') setFrameId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycleLayout, redo, undo, saveNow]);

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
        <span className={`save-status ${saveStatus === 'failed' ? 'failed' : ''}`} role="status">
          {{
            saved: 'Saved',
            unsaved: path ? 'Saving soon…' : 'Not saved yet',
            saving: 'Saving…',
            failed: 'Could not save',
          }[saveStatus]}
        </span>
        <button type="button" className="btn" onClick={() => void saveNow()}>Save</button>
        <button
          type="button"
          className="btn icon-btn"
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
          disabled={!history.canUndo}
          onClick={() => { setFrameId(null); undo(); }}
        >
          ↶
        </button>
        <button
          type="button"
          className="btn icon-btn"
          aria-label="Redo"
          title="Redo (Ctrl+Y)"
          disabled={!history.canRedo}
          onClick={() => { setFrameId(null); redo(); }}
        >
          ↷
        </button>
        <label className="toggle">
          <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} />
          Print guides
        </label>
        <button type="button" className="btn-primary" disabled={importing} onClick={() => void chooseFolder()}>
          {importing ? 'Reading photos…' : 'Import photos'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!spreads.length}
          onClick={() => setExportProject(toProject(album, photos, spreads))}
        >
          Export
        </button>
      </header>

      {missing.size > 0 && (
        <p className="notice missing" role="alert">
          {missing.size} original photo{missing.size === 1 ? '' : 's'} could not be found. You can
          keep designing, but they are needed before export.
          <button type="button" onClick={() => void findMissing()}>Find them…</button>
        </p>
      )}

      {notice && (
        <p className="notice" role="status">
          {notice}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice('')}>×</button>
        </p>
      )}

      {exportProject && (
        <ExportDialog project={exportProject} onClose={() => setExportProject(null)} />
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
              onGestureStart={history.seal}
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
                  onPointerDown={history.seal}
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
              {missing.has(photo.id)
                ? <span className="badge gone">Missing</span>
                : usedIds.has(photo.id) && <span className="badge">Used</span>}
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
  design, spec, photos, guides, thresholds, selectedId, onSelect, onFit, onSwap, onGestureStart,
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
  onGestureStart: () => void;
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
              onGestureStart();
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
