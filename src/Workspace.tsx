import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  EDIT_PREVIEW,
  GRID_PREVIEW,
  importFolder,
  listFonts,
  previewUrl,
  printOptions,
  relinkPhotos,
  saveAlbum,
  suggestColour,
  suggestLayouts,
  varyLayout,
  suggestRatings,
  analyzePhotos,
  type Adjustments,
  type Frame,
  type FrameStyle,
  type LayoutOption,
  type Project,
  type PublishLink,
  type PhotoInfo,
  type PhotoRating,
  type Rating,
  type Spread,
  type SpreadDesign,
  type TextBlock,
} from './api';
import type { Album } from './App';
import AutoBuild from './AutoBuild';
import { effectiveDpi, visibleArea, cropShare } from './crop';
import EffectsPanel, { NO_ADJUSTMENTS } from './EffectsPanel';
import CommentsDialog from './CommentsDialog';
import Designer from './Designer';
import { currentStaff, listComments } from './eventor';
import ExportDialog from './ExportDialog';
import PublishDialog from './PublishDialog';
import { useHistory } from './history';
import { ALBUM_EXTENSION, ALBUM_FILTERS, rememberAlbum, toProject } from './project';
import { DRAG_PHOTOS, FrameBorder, FramedPhoto, frameStyle, percent, TextOnSpread, ThumbText } from './spreadParts';
import { useSpreadRail } from './spreadRail';
import TextPanel from './TextPanel';

type Thresholds = { warn: number; tooLow: number };

const DRAG_FRAME = 'application/x-album-frame';
const MAX_ZOOM = 3;

/** How long after the last change an already-saved album saves itself. */
const AUTOSAVE_DELAY_MS = 1500;

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed';
type PhotoFilter = 'all' | 'unused' | 'used' | 'missing' | Rating;

/** Clicking a photo's dot steps through these, starting after its current rating. */
const NEXT_RATING: Record<Rating, Rating> = { green: 'yellow', yellow: 'red', red: 'green' };

/** A new layout keeps each photo's crop and effects, and the spread's paper. */
function carryOver(from: SpreadDesign, to: SpreadDesign): SpreadDesign {
  const before = new Map(from.frames.map((f) => [f.asset_id, f]));
  return {
    ...to,
    background: from.background,
    texts: from.texts,
    frames: to.frames.map((frame) => {
      const old = before.get(frame.asset_id);
      return old ? { ...frame, fit: old.fit, adjust: old.adjust, style: old.style, corner_radius_mm: old.corner_radius_mm } : frame;
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
  const [designerOpen, setDesignerOpen] = useState(false);
  const [publishLink, setPublishLink] = useState<PublishLink | null>(album.publish);
  const [publishProject, setPublishProject] = useState<Project | null>(null);
  const [showComments, setShowComments] = useState(false);
  const [openComments, setOpenComments] = useState(0);
  const autoDesignTicket = useRef(0);
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

  const latest = useRef({ photos, spreads, ratings, publishLink, path, dirty: false });
  latest.current.path = path;
  useEffect(() => {
    const was = latest.current;
    if (was.photos === photos && was.spreads === spreads && was.ratings === ratings && was.publishLink === publishLink) return;
    latest.current = { ...was, photos, spreads, ratings, publishLink, dirty: true };
    setSaveStatus('unsaved');
  }, [photos, spreads, ratings, publishLink]);

  // Shows how many comments are waiting, once this album is linked to a job.
  useEffect(() => {
    if (!publishLink?.album_id) return undefined;
    let current = true;
    currentStaff()
      .then((staff) => (staff ? listComments(publishLink.album_id, staff) : null))
      .then((found) => {
        if (current && found) setOpenComments(found.filter((c) => !c.resolved_at).length);
      })
      // Only a courtesy: the Comments window explains any problem when it is opened.
      .catch(() => {});
    return () => { current = false; };
  }, [publishLink]);

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
        await saveAlbum(target, toProject(album, snapshot.photos, snapshot.spreads, snapshot.ratings, snapshot.publishLink));
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
  async function autoColour(chosen?: Set<string> | null) {
    if (!current) return;
    const targets = current.design.frames.filter((f) => f.asset_id && (
      chosen !== undefined
        ? chosen === null || chosen.has(f.id)
        : frameId === null || f.id === frameId
    ));
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

  // A new album asks for its photos straight away. Cancelling just leaves it empty.
  const askedForFolder = useRef(false);
  useEffect(() => {
    if (!album.importOnOpen || askedForFolder.current) return;
    askedForFolder.current = true;
    void chooseFolder();
    // Once, when the album opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const pickSpread = useCallback((id: string) => {
    setCurrentId(id);
    setFrameId(null);
  }, [setFrameId]);

  const openSpreadInDesigner = useCallback((id: string) => {
    pickSpread(id);
    setDesignerOpen(true);
  }, [pickSpread]);

  const rail = useSpreadRail(currentId, currentIndex, pickSpread, goToSpread);
  const timeline = useRef<HTMLElement>(null);

  // The strip below follows the row of spreads, so the current one is never out of sight.
  useEffect(() => {
    const strip = timeline.current;
    const thumb = strip?.querySelector<HTMLElement>('.spread-thumb.on');
    if (!strip || !thumb) return;
    const box = strip.getBoundingClientRect();
    const at = thumb.getBoundingClientRect();
    if (at.left < box.left || at.right > box.right) {
      strip.scrollBy({ left: at.left - box.left - (box.width - at.width) / 2, behavior: 'smooth' });
    }
  }, [currentId, currentIndex, designerOpen]);

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

  /** For the designer, where photos can leave or join the spread. */
  const changeFromDesigner = useCallback((change: (design: SpreadDesign) => SpreadDesign, mergeKey?: string) => {
    setSpreads(
      (all) => all.map((s) => {
        if (s.id !== currentId) return s;
        const design = change(s.design);
        const photoIds = design.frames.flatMap((f) => (f.asset_id ? [f.asset_id] : []));
        return { ...s, design, photoIds };
      }),
      mergeKey,
    );
  }, [currentId, setSpreads]);

  /** New frames for photos dropped on an empty part of the designer's canvas. */
  function dropPhotosOnDesigner(ids: string[], xMm: number, yMm: number) {
    if (!current) return;
    const { h } = current.design.size_mm;
    const height = h * 0.4;
    const style: FrameStyle = { opacity: 1, border_mm: 0, border_colour: '#FFFFFF' };
    const noEffects = { ...NO_ADJUSTMENTS };
    let x = xMm;
    const made: Frame[] = ids.flatMap((id) => {
      const photo = byId.get(id);
      if (!photo) return [];
      const width = height * (photo.width / photo.height);
      const frame: Frame = {
        id: crypto.randomUUID(),
        rect_mm: { x: x - width / 2, y: yMm - height / 2, w: width, h: height },
        corner_radius_mm: 0,
        asset_id: id,
        fit: { scale: 1, cx: 0.5, cy: 0.5, rot_deg: 0 },
        adjust: noEffects,
        style,
        z: 0,
      };
      x += width + 4;
      return [frame];
    });
    history.seal();
    changeFromDesigner((d) => ({ ...d, template_id: null, frames: [...d.frames, ...made] }));
  }

  function replacePhotoInDesigner(frameId: string, photoId: string) {
    history.seal();
    changeFromDesigner((d) => ({
      ...d,
      frames: d.frames.map((f) => (f.id === frameId ? { ...f, asset_id: photoId, fit: { scale: 1, cx: 0.5, cy: 0.5, rot_deg: 0 } } : f)),
    }));
  }

  /** Lays out a hand-edited spread from its layouts again, keeping its photos. */
  async function relayout(spread: Spread) {
    const options = await layoutFor(spread.photoIds);
    if (!options) return;
    setSpreads((all) => all.map((s) => (
      s.id === spread.id ? { ...s, options, optionIndex: 0, design: carryOver(s.design, options[0].design) } : s
    )));
  }

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

  /** Each click makes another arrangement in the selected style, without end. */
  async function autoDesign() {
    if (!current) return;
    const style = current.options[current.optionIndex];
    if (!style) return;
    const spreadId = current.id;
    const ticket = ++autoDesignTicket.current;
    const list = current.photoIds.flatMap((id) => byId.get(id) ?? []);
    const [seed] = crypto.getRandomValues(new Uint32Array(1));
    try {
      const made = await varyLayout(style.template_id, list, spec, current.design.frames.map((f) => f.rect_mm), seed);
      // Only the latest click counts, when they come quicker than the answers.
      if (ticket !== autoDesignTicket.current) return;
      if (!made) {
        setNotice(`“${style.name}” has only one arrangement. Choose another style with ‹ › to design more.`);
        return;
      }
      setNotice('');
      setFrameId(null);
      history.seal();
      setSpreads((all) => all.map((s) => (s.id === spreadId ? { ...s, design: carryOver(s.design, made.design) } : s)));
      history.seal();
    } catch (e) {
      setNotice(`Could not design a new layout: ${String(e)}`);
    }
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
      // The designer has its own keys for the rest.
      if (designerOpen) return;
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
  }, [cycleLayout, goToSpread, redo, undo, saveNow, textId, deleteText, setFrameId, designerOpen]);

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
        {designerOpen ? (
          <button type="button" className="btn" onClick={() => setDesignerOpen(false)}>‹ Back to album</button>
        ) : (
          <span className="brand-mark small" aria-hidden="true">E</span>
        )}
        <div className="title">
          <strong>{album.name}</strong>
          <span>
            {album.sizeLabel} · {spec.binding === 'layflat' ? 'Lay-flat' : 'Magazine'} ·{' '}
            {designerOpen && current
              ? `designing spread ${currentIndex + 1} of ${spreads.length}`
              : `${spreads.length} spread${spreads.length === 1 ? '' : 's'}`}
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
        {!designerOpen && (
          <button type="button" className={`btn pane-btn ${showSide ? 'active' : ''}`} aria-pressed={showSide} onClick={() => setShowSide(!showSide)}>Panel</button>
        )}
        {publishLink?.album_id && (
          <button type="button" className="btn" onClick={() => setShowComments(true)}>
            Comments{openComments > 0 && <span className="count-badge">{openComments}</span>}
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={!spreads.length}
          title="Publish as the client's digital album in Eventor"
          onClick={() => setPublishProject(toProject(album, photos, spreads, ratings, publishLink))}
        >
          Publish
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!spreads.length}
          onClick={() => setExportProject(toProject(album, photos, spreads, ratings, publishLink))}
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

      {publishProject && (
        <PublishDialog
          project={publishProject}
          link={publishLink}
          onPublished={setPublishLink}
          onClose={() => setPublishProject(null)}
        />
      )}

      {showComments && publishLink && (
        <CommentsDialog
          link={publishLink}
          spreadIds={spreads.map((s) => s.id)}
          onOpenCount={setOpenComments}
          onGoToSpread={(id) => {
            setShowComments(false);
            setDesignerOpen(false);
            pickSpread(id);
          }}
          onClose={() => setShowComments(false)}
        />
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

      {designerOpen && current ? (
        <Designer
          key={current.id}
          design={current.design}
          spec={spec}
          photos={byId}
          thresholds={thresholds}
          paperColours={paperColours}
          fonts={fonts}
          showOriginal={showOriginal}
          autoBusy={autoBusy}
          onChange={changeFromDesigner}
          onSeal={history.seal}
          onAuto={(chosen) => void autoColour(chosen)}
          onShowOriginal={setShowOriginal}
          onAddPhoto={dropPhotosOnDesigner}
          onReplacePhoto={replacePhotoInDesigner}
        />
      ) : (
      <>
      <div className={`stage ${showSide ? '' : 'no-side'}`}>
        <div className="canvas-column">
          {current && (!option || option.design.frames.length !== current.design.frames.length) && (
            <div className="spread-tools" role="toolbar" aria-label="Spread">
              <span className="muted">Custom layout</span>
              <button type="button" className="tool" onClick={() => void relayout(current)}>Choose a layout</button>
              <button type="button" className="tool" onClick={() => setDesignerOpen(true)}>Designer</button>
              <button type="button" className="tool danger" onClick={() => deleteSpread(current.id)}>Delete</button>
            </div>
          )}
          {current && option && option.design.frames.length === current.design.frames.length && (
            <div className="spread-tools" role="toolbar" aria-label="Spread">
              <div className="cycler">
                <button type="button" aria-label="Previous layout" title="Previous layout ( [ )" onClick={() => cycleLayout(-1)}>‹</button>
                <div>
                  <strong>{current.design.template_id ? option.name : 'Custom layout'}</strong>
                  <span>
                    {current.optionIndex + 1} of {current.options.length} · {Math.round(cropShare(current.design, byId) * 100)}% cropped
                  </span>
                </div>
                <button type="button" aria-label="Next layout" title="Next layout ( ] )" onClick={() => cycleLayout(1)}>›</button>
              </div>
              <span className="tools-rule" />
              <button type="button" className="tool" onClick={() => { setFrameId(null); setDesignerOpen(true); }}>Designer</button>
              <button
                type="button"
                className="tool accent"
                title="Design a new arrangement in this style. Click again for another."
                onClick={() => void autoDesign()}
              >
                Auto design
              </button>
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

          <div className="rail-wrap">
          <section
            ref={rail.setRail}
            className={`canvas-area ${current ? 'rail' : ''} ${rail.sliding ? 'sliding' : ''}`}
            aria-label="All spreads"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const ids = droppedPhotos(e);
              if (!ids.length) return;
              // Photos go to the spread they were dropped on, even if it is not the current one.
              const on = (e.target as Element).closest<HTMLElement>('[data-spread-id]')?.dataset.spreadId;
              void addPhotos(ids, on ?? currentId);
            }}
            {...rail.handlers}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget || (e.target as Element).classList.contains('spread-slot')) setFrameId(null);
              rail.handlers.onPointerDown(e);
            }}
          >
            {current ? (
              <>
                <span aria-hidden="true" className="rail-end" style={{ width: `calc((100cqw - ${spreadWidth(spreads[0].design)}) / 2)` }} />
                {spreads.map((s, i) => (
                  <div key={s.id} className="spread-slot" data-spread-id={s.id}>
                    {s.id === currentId ? (
                      <SpreadCanvas
                        design={s.design}
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
                        onOpenDesigner={() => { setFrameId(null); setDesignerOpen(true); }}
                        textId={textId}
                        onSelectText={setTextId}
                        onChangeText={changeText}
                        onOverflow={noteOverflow}
                      />
                    ) : (
                      <SpreadPeek
                        id={s.id}
                        index={i}
                        design={s.design}
                        photos={byId}
                        previewWidth={peekDetail(Math.abs(i - currentIndex))}
                        onPick={pickSpread}
                        onOpen={openSpreadInDesigner}
                      />
                    )}
                  </div>
                ))}
                <span aria-hidden="true" className="rail-end" style={{ width: `calc((100cqw - ${spreadWidth(spreads[spreads.length - 1].design)}) / 2)` }} />
              </>
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
          {current && currentIndex > 0 && (
            <button type="button" className="rail-nav prev" aria-label="Previous spread" onClick={() => goToSpread(-1)}>‹</button>
          )}
          {current && currentIndex < spreads.length - 1 && (
            <button type="button" className="rail-nav next" aria-label="Next spread" onClick={() => goToSpread(1)}>›</button>
          )}
          </div>

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

      <section ref={timeline} className="timeline" aria-label="Spreads">
        {spreads.map((s, i) => (
          <div key={s.id} className="spread-item">
            <button
              type="button"
              aria-label={`Spread ${i + 1}`}
              aria-current={s.id === currentId}
              className={`spread-thumb ${s.id === currentId ? 'on' : ''}`}
              style={{ aspectRatio: String(s.design.size_mm.w / s.design.size_mm.h), background: s.design.background.value }}
              onClick={() => { setCurrentId(s.id); setFrameId(null); }}
              onDoubleClick={() => { setCurrentId(s.id); setFrameId(null); setDesignerOpen(true); }}
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
                    <FrameBorder frame={f} design={s.design} />
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

      </>
      )}

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

/** The book's true shape, at the largest size that fits the sliding area. */
function spreadWidth(design: SpreadDesign): string {
  const { w, h } = design.size_mm;
  return `min(100cqw, calc(100cqh * ${w / h}))`;
}

/** Spreads further from the current one load less, so a long album stays quick. */
function peekDetail(distance: number): number | null {
  if (distance <= 1) return EDIT_PREVIEW;
  return distance <= 3 ? GRID_PREVIEW : null;
}

/** A spread beside the current one. It can only be looked at, until it is clicked. */
const SpreadPeek = memo(function SpreadPeek({
  id, index, design, photos, previewWidth, onPick, onOpen,
}: {
  id: string;
  index: number;
  design: SpreadDesign;
  photos: Map<string, PhotoInfo>;
  previewWidth: number | null;
  onPick: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const { w, h } = design.size_mm;
  return (
    <button
      type="button"
      className="spread-peek"
      aria-label={`Go to spread ${index + 1}`}
      style={{ width: spreadWidth(design), aspectRatio: String(w / h), background: design.background.value }}
      onClick={() => onPick(id)}
      onDoubleClick={() => onOpen(id)}
    >
      {previewWidth !== null && design.frames.map((frame) => {
        const photo = frame.asset_id ? photos.get(frame.asset_id) : undefined;
        return (
          <span key={frame.id} className="frame" style={frameStyle(frame, design)}>
            {photo && <FramedPhoto photo={photo} frame={frame} width={previewWidth} />}
            <FrameBorder frame={frame} design={design} />
          </span>
        );
      })}
      {previewWidth !== null && design.texts.map((t) => <ThumbText key={t.id} block={t} design={design} />)}
    </button>
  );
});

function SpreadCanvas({
  design, spec, photos, guides, thresholds, selectedId, onSelect, onFit, onSwap, onGestureStart,
  showOriginal, onOpenDesigner, textId, onSelectText, onChangeText, onOverflow,
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
  onOpenDesigner: () => void;
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
        width: spreadWidth(design),
        aspectRatio: String(w / h),
        background: design.background.value,
      }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}
      onDoubleClick={onOpenDesigner}
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
            <FrameBorder frame={frame} design={design} />
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
