import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  EDIT_PREVIEW,
  GRID_PREVIEW,
  importFolder,
  listFonts,
  previewText,
  previewUrl,
  printOptions,
  relinkPhotos,
  saveAlbum,
  suggestColour,
  suggestLayouts,
  suggestRatings,
  analyzePhotos,
  type Adjustments,
  type Frame,
  type LayoutOption,
  type PhotoInfo,
  type PhotoRating,
  type Project,
  type Rating,
  type Spread,
  type SpreadDesign,
  type TextBlock,
} from './api';
import type { Album } from './App';
import AutoBuild from './AutoBuild';
import { effectiveDpi, visibleArea } from './crop';
import EffectsPanel, { NO_ADJUSTMENTS } from './EffectsPanel';
import ExportDialog from './ExportDialog';
import { useHistory } from './history';
import { ALBUM_EXTENSION, ALBUM_FILTERS, rememberAlbum, toProject } from './project';
import TextPanel from './TextPanel';

type Thresholds = { warn: number; tooLow: number };

const DRAG_PHOTOS = 'application/x-album-photos';
const DRAG_FRAME = 'application/x-album-frame';
const MAX_ZOOM = 3;

/** How long after the last change an already-saved album saves itself. */
const AUTOSAVE_DELAY_MS = 1500;

/** How long a slider must rest before the adjusted picture is fetched. */
const EFFECT_SETTLE_MS = 90;

/** How long typing must rest before the text is drawn again. */
const TEXT_SETTLE_MS = 120;

/** How close a dragged text block must come to a guide before it snaps to it. */
const SNAP_MM = 2;

const DEFAULT_FONT = 'Nirmala UI';
const MIN_TEXT_BOX_MM = 8;

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed';
type PhotoFilter = 'all' | 'unused' | 'used' | 'missing' | Rating;

/** Clicking a photo's dot steps through these, starting after its current rating. */
const NEXT_RATING: Record<Rating, Rating> = { green: 'yellow', yellow: 'red', red: 'green' };

function percent(part: number, whole: number): string {
  return `${(part / whole) * 100}%`;
}

/** A new layout keeps each photo's crop and effects, and the spread's paper. */
function carryOver(from: SpreadDesign, to: SpreadDesign): SpreadDesign {
  const before = new Map(from.frames.map((f) => [f.asset_id, f]));
  return {
    ...to,
    background: from.background,
    texts: from.texts,
    frames: to.frames.map((frame) => {
      const old = before.get(frame.asset_id);
      return old ? { ...frame, fit: old.fit, adjust: old.adjust } : frame;
    }),
  };
}

function mirrored(design: SpreadDesign): SpreadDesign {
  return {
    ...design,
    frames: design.frames.map((f) => ({
      ...f,
      rect_mm: { ...f.rect_mm, x: design.size_mm.w - f.rect_mm.x - f.rect_mm.w },
    })),
    texts: design.texts.map((t) => ({
      ...t,
      rect_mm: { ...t.rect_mm, x: design.size_mm.w - t.rect_mm.x - t.rect_mm.w },
    })),
  };
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
  const [frameId, setFrameIdRaw] = useState<string | null>(null);
  const setFrameId = useCallback((id: string | null) => {
    setFrameIdRaw(id);
    setTextIdRaw(null);
  }, []);
  const [textId, setTextIdRaw] = useState<string | null>(null);
  const [fonts, setFonts] = useState<string[]>([]);
  const [overflowing, setOverflowing] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<PhotoFilter>('all');
  const [sortReverse, setSortReverse] = useState(false);
  const [search, setSearch] = useState('');
  const [thumbSize, setThumbSize] = useState(120);
  const [guides, setGuides] = useState(true);
  const [showBrowser, setShowBrowser] = useState(true);
  const [showSide, setShowSide] = useState(true);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [exportProject, setExportProject] = useState<Project | null>(null);
  const [showBuild, setShowBuild] = useState(false);
  const [ratings, setRatings] = useState<Record<string, Rating>>(album.ratings);
  const [suggested, setSuggested] = useState<Map<string, PhotoRating>>(new Map());
  const [reading, setReading] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [thresholds, setThresholds] = useState<Thresholds>({ warn: 0, tooLow: 0 });
  const [paperColours, setPaperColours] = useState<string[]>([]);

  /** Selecting text and selecting a photo rule each other out. */
  const setTextId = useCallback((id: string | null) => {
    setTextIdRaw(id);
    if (id) setFrameIdRaw(null);
  }, []);

  useEffect(() => {
    listFonts().then(setFonts).catch(() => setFonts([]));
  }, []);

  useEffect(() => {
    printOptions()
      .then((o) => {
        setThresholds({ warn: o.dpi_warn, tooLow: o.dpi_too_low });
        setPaperColours(o.paper);
      })
      .catch((e) => setNotice(String(e)));
  }, []);

  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const current = spreads.find((s) => s.id === currentId) ?? null;
  const currentIndex = current ? spreads.indexOf(current) : -1;
  const frame = current?.design.frames.find((f) => f.id === frameId) ?? null;
  const textBlock = current?.design.texts.find((t) => t.id === textId) ?? null;

  const usedIds = useMemo(() => new Set(spreads.flatMap((s) => s.photoIds)), [spreads]);

  // Undo can remove the spread on screen, so fall back to one that still exists.
  useEffect(() => {
    if (!spreads.some((s) => s.id === currentId)) setCurrentId(spreads[0]?.id ?? null);
  }, [spreads, currentId]);

  const latest = useRef({ photos, spreads, ratings, path, dirty: false });
  latest.current.path = path;
  useEffect(() => {
    const was = latest.current;
    if (was.photos === photos && was.spreads === spreads && was.ratings === ratings) return;
    latest.current = { ...was, photos, spreads, ratings, dirty: true };
    setSaveStatus('unsaved');
  }, [photos, spreads, ratings]);

  // Reads the photos in the background, so ratings appear without being asked for.
  useEffect(() => {
    if (!photos.length) return;
    let current = true;
    const ids = photos.map((p) => p.id);
    setReading(true);
    analyzePhotos(ids)
      .then(() => suggestRatings(ids))
      .then((rated) => {
        if (current) setSuggested(new Map(rated.map((r) => [r.id, r])));
      })
      .catch((e) => { if (current) setNotice(`Could not read the photos: ${String(e)}`); })
      .finally(() => { if (current) setReading(false); });
    return () => { current = false; };
  }, [photos]);

  const ratingOf = useCallback(
    (id: string): Rating | undefined => ratings[id] ?? suggested.get(id)?.rating,
    [ratings, suggested],
  );

  // One save at a time, because they share a temporary file.
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  /** Writes the album. Resolves to false if it could not. */
  const writeTo = useCallback((target: string) => {
    const run = async () => {
      const snapshot = latest.current;
      setSaveStatus('saving');
      try {
        await saveAlbum(target, toProject(album, snapshot.photos, snapshot.spreads, snapshot.ratings));
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
    if (ok) {
      setPath(chosen);
      rememberAlbum(chosen, album.name);
    }
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

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = photos.filter((p) => {
      if (filter === 'used' && !usedIds.has(p.id)) return false;
      if (filter === 'unused' && usedIds.has(p.id)) return false;
      if (filter === 'missing' && !missing.has(p.id)) return false;
      if ((filter === 'red' || filter === 'yellow' || filter === 'green') && ratingOf(p.id) !== filter) return false;
      return p.file_name.toLowerCase().includes(term);
    });
    return sortReverse ? [...list].reverse() : list;
  }, [photos, filter, usedIds, missing, search, sortReverse, ratingOf]);

  /** Sets a suggested fix on the selected photo, or on each photo of the spread. */
  async function autoColour() {
    if (!current) return;
    const targets = current.design.frames.filter((f) => f.asset_id && (frameId === null || f.id === frameId));
    setAutoBusy(true);
    try {
      const found = await Promise.all(
        targets.map(async (f) => [f.id, await suggestColour(f.asset_id!)] as const),
      );
      const byFrame = new Map(found);
      history.seal();
      changeFrames((frames) => frames.map((f) => {
        const fix = byFrame.get(f.id);
        if (!fix) return f;
        return {
          ...f,
          adjust: {
            ...f.adjust,
            exposure: fix.exposure,
            contrast: fix.contrast,
            temperature: fix.temperature,
            tint: fix.tint,
          },
        };
      }));
    } catch (e) {
      setNotice(`Could not work out the colour: ${String(e)}`);
    } finally {
      setAutoBusy(false);
    }
  }

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
    if (target) {
      setSpreads((all) => all.map((s) => (
        s.id === target.id
          ? { ...s, photoIds, options, optionIndex: 0, design: carryOver(s.design, options[0].design) }
          : s
      )));
    } else {
      const id = crypto.randomUUID();
      setSpreads((all) => [...all, { id, photoIds, options, optionIndex: 0, design: options[0].design }]);
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
      all.map((s) => (
        s.id === spread.id
          ? { ...s, photoIds, options, optionIndex: 0, design: carryOver(s.design, options[0].design) }
          : s
      )),
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

  const goToSpread = useCallback((step: -1 | 1) => {
    setFrameId(null);
    setCurrentId((id) => {
      const at = spreads.findIndex((s) => s.id === id);
      return spreads[at + step]?.id ?? id;
    });
  }, [spreads]);

  /** Tries another layout. The photos stay the same, and only their places change. */
  const chooseLayout = useCallback((pick: (s: Spread) => number) => {
    setFrameId(null);
    setSpreads((all) =>
      all.map((s) => {
        if (s.id !== currentId || !s.options.length) return s;
        const optionIndex = pick(s);
        if (optionIndex === s.optionIndex) return s;
        return { ...s, optionIndex, design: carryOver(s.design, s.options[optionIndex].design) };
      }),
    );
  }, [currentId, setSpreads]);

  const cycleLayout = useCallback((step: -1 | 1) => {
    chooseLayout((s) => (s.optionIndex + step + s.options.length) % s.options.length);
  }, [chooseLayout]);

  const changeDesign = useCallback((change: (design: SpreadDesign) => SpreadDesign, mergeKey?: string) => {
    setSpreads(
      (all) => all.map((s) => (s.id === currentId ? { ...s, design: change(s.design) } : s)),
      mergeKey,
    );
  }, [currentId, setSpreads]);

  const changeFrames = useCallback((change: (frames: Frame[]) => Frame[], mergeKey?: string) => {
    changeDesign((d) => ({ ...d, frames: change(d.frames) }), mergeKey);
  }, [changeDesign]);

  const changeFit = useCallback((id: string, fit: Partial<Frame['fit']>) => {
    // One drag or slider movement is one undo step, not hundreds.
    changeFrames(
      (frames) => frames.map((f) => (f.id === id ? { ...f, fit: { ...f.fit, ...fit } } : f)),
      `fit:${id}`,
    );
  }, [changeFrames]);

  /** Effects go to the selected photo, or to the whole spread when none is selected. */
  const changeEffects = useCallback((change: Partial<Adjustments>) => {
    const target = frameId;
    changeFrames(
      (frames) => frames.map((f) => (
        target === null || f.id === target ? { ...f, adjust: { ...f.adjust, ...change } } : f
      )),
      `fx:${target ?? 'spread'}`,
    );
  }, [changeFrames, frameId]);

  function addText() {
    if (!current) return;
    const { w, h } = current.design.size_mm;
    const boxWidth = w * 0.3;
    const boxHeight = h * 0.22;
    const block: TextBlock = {
      id: crypto.randomUUID(),
      rect_mm: { x: w * 0.75 - boxWidth / 2, y: h / 2 - boxHeight / 2, w: boxWidth, h: boxHeight },
      text: 'Your text',
      font: fonts.includes(DEFAULT_FONT) ? DEFAULT_FONT : '',
      size_pt: 36,
      colour: '#000000',
      align: 'center',
      bold: false,
      italic: false,
      line_height: 1.3,
    };
    changeDesign((d) => ({ ...d, texts: [...d.texts, block] }));
    setTextId(block.id);
  }

  const changeText = useCallback((id: string, change: Partial<TextBlock>) => {
    changeDesign(
      (d) => ({ ...d, texts: d.texts.map((t) => (t.id === id ? { ...t, ...change } : t)) }),
      `text:${id}`,
    );
  }, [changeDesign]);

  const deleteText = useCallback((id: string) => {
    changeDesign((d) => ({ ...d, texts: d.texts.filter((t) => t.id !== id) }));
    setTextIdRaw(null);
  }, [changeDesign]);

  const noteOverflow = useCallback((id: string, overflowed: boolean) => {
    setOverflowing((before) => {
      if (before.has(id) === overflowed) return before;
      const next = new Set(before);
      if (overflowed) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  function swapFrames(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    changeFrames((frames) => {
      const source = frames.find((f) => f.id === sourceId);
      const target = frames.find((f) => f.id === targetId);
      if (!source || !target) return frames;
      const contents = (f: Frame) => ({ asset_id: f.asset_id, fit: f.fit, adjust: f.adjust });
      return frames.map((f) => {
        if (f.id === sourceId) return { ...f, ...contents(target) };
        if (f.id === targetId) return { ...f, ...contents(source) };
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
      if (textId && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        deleteText(textId);
        return;
      }
      if (e.key === '[') cycleLayout(-1);
      if (e.key === ']') cycleLayout(1);
      if (e.key === 'ArrowLeft') goToSpread(-1);
      if (e.key === 'ArrowRight') goToSpread(1);
      if (e.key === 'Escape') setFrameId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycleLayout, goToSpread, redo, undo, saveNow, textId, deleteText, setFrameId]);

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
  const effectsValue = frame?.adjust ?? current?.design.frames[0]?.adjust ?? NO_ADJUSTMENTS;
  const paperNow = current?.design.background.value;

  return (
    <div className="workspace">
      <header className="topbar">
        <span className="brand-mark small" aria-hidden="true">E</span>
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
        <button type="button" className="btn icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.canUndo} onClick={() => { setFrameId(null); undo(); }}>↶</button>
        <button type="button" className="btn icon-btn" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!history.canRedo} onClick={() => { setFrameId(null); redo(); }}>↷</button>
        <span className="topbar-gap" />
        <label className="toggle">
          <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} />
          Print guides
        </label>
        <button type="button" className={`btn pane-btn ${showBrowser ? 'active' : ''}`} aria-pressed={showBrowser} onClick={() => setShowBrowser(!showBrowser)}>Photos</button>
        <button type="button" className={`btn pane-btn ${showSide ? 'active' : ''}`} aria-pressed={showSide} onClick={() => setShowSide(!showSide)}>Panel</button>
        <button
          type="button"
          className="btn-primary"
          disabled={!spreads.length}
          onClick={() => setExportProject(toProject(album, photos, spreads, ratings))}
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

      {showBuild && (
        <AutoBuild
          // A photo marked red by hand has been rejected, so it is not offered at all.
          photos={photos.filter((p) => ratings[p.id] !== 'red')}
          used={usedIds}
          spec={spec}
          hasSpreads={spreads.length > 0}
          alwaysKeep={photos.filter((p) => ratings[p.id] === 'green').map((p) => p.id)}
          onClose={() => setShowBuild(false)}
          onBuild={(built) => {
            setSpreads(() => built);
            setCurrentId(built[0]?.id ?? null);
            setFrameId(null);
            setSelected(new Set());
            setShowBuild(false);
          }}
        />
      )}

      <div className={`stage ${showSide ? '' : 'no-side'}`}>
        <div className="canvas-column">
          {current && option && (
            <div className="spread-tools" role="toolbar" aria-label="Spread">
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
              <span className="tools-rule" />
              <button type="button" className="tool" onClick={addText}>Add text</button>
              <button
                type="button"
                className="tool"
                title="Swap the left and right sides"
                onClick={() => { setFrameId(null); changeDesign(mirrored); }}
              >
                Mirror
              </button>
              <button
                type="button"
                className="tool danger"
                onClick={() => deleteSpread(current.id)}
              >
                Delete
              </button>
            </div>
          )}

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
                showOriginal={showOriginal}
                textId={textId}
                onSelectText={setTextId}
                onChangeText={changeText}
                onOverflow={noteOverflow}
              />
            ) : (
              <div className="empty-stage">
                <span className="empty-book" aria-hidden="true"><i /><i /></span>
                <h2>{photos.length ? 'Build the album, or drag photos here' : 'Start by importing photos'}</h2>
                <p>
                  {photos.length
                    ? 'Auto Build lays out everything. Or select a few photos and drop them here.'
                    : 'Your originals stay where they are and are never changed.'}
                </p>
                <div className="empty-actions">
                  <button type="button" className={photos.length ? 'btn' : 'btn-primary'} disabled={importing} onClick={() => void chooseFolder()}>
                    {importing ? 'Reading photos…' : 'Import photos'}
                  </button>
                  {photos.length > 0 && (
                    <button type="button" className="btn-primary" onClick={() => setShowBuild(true)}>Auto Build</button>
                  )}
                </div>
              </div>
            )}
          </section>

          {current && (
            <p className="spread-caption">
              Spread {currentIndex + 1} of {spreads.length} · pages {currentIndex * 2 + 1}–{currentIndex * 2 + 2}
            </p>
          )}
        </div>

        {showSide && (
          <aside className="side">
            {!current && <p className="muted">Select a spread to change its layout and effects.</p>}

            {textBlock && (
              <TextPanel
                block={textBlock}
                fonts={fonts}
                overflowed={overflowing.has(textBlock.id)}
                onChange={(change) => changeText(textBlock.id, change)}
                onGestureStart={history.seal}
                onDelete={() => deleteText(textBlock.id)}
              />
            )}

            {frame && framePhoto && current && (
              <section>
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
                <div className="button-row">
                  <button type="button" className="btn" onClick={() => changeFit(frame.id, { scale: 1, cx: 0.5, cy: 0.5 })}>
                    Reset crop
                  </button>
                  <button type="button" className="btn" onClick={() => void removeFromSpread(current, framePhoto.id)}>
                    Remove from spread
                  </button>
                </div>
              </section>
            )}

            {current && (
              <EffectsPanel
                title={frame ? 'Effects for this photo' : 'Effects for this spread'}
                hint={frame ? 'Press Esc to adjust the whole spread.' : 'Every photo on the spread. Click a photo to change only that one.'}
                value={effectsValue}
                onChange={changeEffects}
                onGestureStart={history.seal}
                showOriginal={showOriginal}
                autoBusy={autoBusy}
                onAuto={() => void autoColour()}
                onShowOriginal={setShowOriginal}
              />
            )}

            {current && current.options.length > 0 && (
              <section>
                <h3>Layouts for {current.photoIds.length} photo{current.photoIds.length === 1 ? '' : 's'}</h3>
                <div className="layout-grid">
                  {current.options.map((o, i) => (
                    <LayoutThumb
                      key={o.template_id}
                      option={o}
                      on={i === current.optionIndex}
                      onClick={() => chooseLayout(() => i)}
                    />
                  ))}
                </div>
              </section>
            )}

            {current && paperColours.length > 0 && (
              <section>
                <h3>Paper for this spread</h3>
                <div className="swatches">
                  {paperColours.map((colour) => (
                    <button
                      key={colour}
                      type="button"
                      aria-label={`Paper colour ${colour}`}
                      aria-pressed={paperNow === colour}
                      className={`swatch ${paperNow === colour ? 'on' : ''}`}
                      style={{ background: colour }}
                      onClick={() => changeDesign((d) => ({ ...d, background: { type: 'color', value: colour } }))}
                    />
                  ))}
                </div>
              </section>
            )}
          </aside>
        )}
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
              {s.design.texts.map((t) => <ThumbText key={t.id} block={t} design={s.design} />)}
            </button>
            <div className="spread-actions">
              <span>{String(i + 1).padStart(2, '0')}</span>
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

      {showBrowser && (
        <section className="browser" aria-label="Photos">
          <div className="browser-bar">
            <button type="button" className="btn" disabled={importing} onClick={() => void chooseFolder()}>
              {importing ? 'Reading photos…' : 'Import photos'}
            </button>
            <button type="button" className="btn" disabled={!photos.length} onClick={() => setShowBuild(true)}>Auto Build</button>
            <strong className="muted">{usedIds.size} of {photos.length} used</strong>
            <select className="input" aria-label="Show photos" value={filter} onChange={(e) => setFilter(e.target.value as PhotoFilter)}>
              <option value="all">All photos</option>
              <option value="unused">Unused</option>
              <option value="used">Used</option>
              <option value="missing">Missing</option>
              <option value="green">Green: good</option>
              <option value="yellow">Yellow: worth a look</option>
              <option value="red">Red: probably reject</option>
            </select>
            {reading && <span className="muted rating-note">Reading photos…</span>}
            <select className="input" aria-label="Sort photos" value={sortReverse ? 'za' : 'az'} onChange={(e) => setSortReverse(e.target.value === 'za')}>
              <option value="az">Name, A to Z</option>
              <option value="za">Name, Z to A</option>
            </select>
            <input className="input search" aria-label="Search photos" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
            <input
              type="range"
              aria-label="Thumbnail size"
              className="thumb-size"
              min={80}
              max={220}
              value={thumbSize}
              onChange={(e) => setThumbSize(Number(e.target.value))}
            />
            {selectedIds.length > 0 && current && (
              <button type="button" className="btn" onClick={() => void addPhotos(selectedIds, current.id)}>
                Add {selectedIds.length} to this spread
              </button>
            )}
            <span className="muted hint">Ctrl+click to select several</span>
          </div>
          <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))` }}>
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
                <span className="photo-box">
                  <img src={previewUrl(photo.id, GRID_PREVIEW)} alt={photo.file_name} loading="lazy" decoding="async" draggable={false} />
                  {ratingOf(photo.id) && (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Rating for ${photo.file_name}: ${ratingOf(photo.id)}. Click to change.`}
                      className={`rating ${ratingOf(photo.id)} ${ratings[photo.id] ? 'set' : ''}`}
                      title={[...(suggested.get(photo.id)?.reasons ?? []), 'Click to change'].join('. ')}
                      onClick={(e) => {
                        e.stopPropagation();
                        const now = ratingOf(photo.id)!;
                        setRatings((all) => ({ ...all, [photo.id]: NEXT_RATING[now] }));
                      }}
                    />
                  )}
                  {missing.has(photo.id)
                    ? <span className="badge gone">Missing</span>
                    : usedIds.has(photo.id) && <span className="badge">Used</span>}
                </span>
                <span className="photo-name">{photo.file_name}</span>
              </button>
            ))}
            {!shown.length && (
              <p className="muted grid-empty">
                {photos.length ? 'No photos match.' : 'No photos yet.'}
              </p>
            )}
          </div>
        </section>
      )}
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

function FramedPhoto({
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
function useTextImage(block: TextBlock, onOverflow?: (overflowed: boolean) => void): string | null {
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

function ThumbText({ block, design }: { block: TextBlock; design: SpreadDesign }) {
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

function TextOnSpread({
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

function LayoutThumb({
  option, on, onClick,
}: {
  option: LayoutOption;
  on: boolean;
  onClick: () => void;
}) {
  const { design } = option;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={option.name}
      title={`${option.name} · ${Math.round(option.crop_loss * 100)}% cropped`}
      className={`layout-thumb ${on ? 'on' : ''}`}
      style={{ aspectRatio: String(design.size_mm.w / design.size_mm.h) }}
      onClick={onClick}
    >
      {design.frames.map((f) => <i key={f.id} style={frameStyle(f, design)} />)}
    </button>
  );
}

function SpreadCanvas({
  design, spec, photos, guides, thresholds, selectedId, onSelect, onFit, onSwap, onGestureStart,
  showOriginal, textId, onSelectText, onChangeText, onOverflow,
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
  showOriginal: boolean;
  textId: string | null;
  onSelectText: (id: string) => void;
  onChangeText: (id: string, change: Partial<TextBlock>) => void;
  onOverflow: (id: string, overflowed: boolean) => void;
}) {
  const { w, h } = design.size_mm;
  const [snap, setSnap] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [overflowed, setOverflowed] = useState<Set<string>>(new Set());
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
            {photo && <FramedPhoto photo={photo} frame={frame} width={EDIT_PREVIEW} original={showOriginal} />}
            {guides && soft && dpi !== null && (
              <span className={`dpi ${dpi < thresholds.tooLow ? 'too-low' : 'low'}`}>{Math.round(dpi)} DPI</span>
            )}
          </div>
        );
      })}
      {design.texts.map((block) => (
        <TextOnSpread
          key={block.id}
          block={block}
          design={design}
          spec={spec}
          selected={block.id === textId}
          overflowing={overflowed.has(block.id)}
          onSelect={onSelectText}
          onChange={onChangeText}
          onGestureStart={onGestureStart}
          onOverflow={(id, over) => {
            onOverflow(id, over);
            setOverflowed((before) => {
              if (before.has(id) === over) return before;
              const next = new Set(before);
              if (over) next.add(id);
              else next.delete(id);
              return next;
            });
          }}
          onSnap={setSnap}
        />
      ))}
      {snap.x !== null && <span className="snap-line x" style={{ left: percent(snap.x, w) }} />}
      {snap.y !== null && <span className="snap-line y" style={{ top: percent(snap.y, h) }} />}
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
