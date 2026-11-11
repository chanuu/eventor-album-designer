import { ImageOffIcon, ImagesIcon, LightbulbIcon, SparklesIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  analyzePhotos,
  GRID_PREVIEW,
  planForAlbum,
  previewUrl,
  suggestLayouts,
  type AlbumPlan,
  type LayoutOption,
  type PhotoInfo,
  type ProjectSpec,
  type Spread,
} from './api';

type Style = { tag: string; name: string; hint: string; art: string[] };

/** `art` is a tiny drawing of the style: each entry is left, top, width, height in %. */
const STYLES: Style[] = [
  { tag: 'clean', name: 'Clean', hint: 'Even photos with tidy spacing', art: ['2,6,46,88', '52,6,46,41', '52,53,46,41'] },
  { tag: 'hero', name: 'Hero', hint: 'One full page beside smaller photos', art: ['0,0,50,100', '54,8,42,40', '54,52,42,40'] },
  { tag: 'panorama', name: 'Panorama', hint: 'One big photo across the fold', art: ['0,0,100,62', '4,68,44,26', '52,68,44,26'] },
  { tag: 'grid', name: 'Grid', hint: 'Columns and rows, more photos', art: ['2,6,22,88', '26,6,22,88', '52,6,22,88', '76,6,22,88'] },
];

/** Prefers the chosen style, and avoids using the same layout twice in a row. */
function chooseLayout(options: LayoutOption[], tag: string, previous: string | null) {
  const inStyle = options.filter((o) => o.tags.includes(tag));
  const pool = inStyle.length ? inStyle : options;
  const pick = pool.find((o) => o.template_id !== previous) ?? pool[0];
  return options.indexOf(pick);
}

/** Capture times are the camera's own clock, so they are shown without any time zone. */
function clockTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

function partLabel(start: number | null, end: number | null): string {
  if (start === null || end === null) return 'No capture time';
  return start === end ? clockTime(start) : `${clockTime(start)} to ${clockTime(end)}`;
}

function shiftLabel(seconds: number): string {
  const minutes = Math.round(Math.abs(seconds) / 60);
  const hours = Math.floor(minutes / 60);
  const amount = hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
  return `${seconds > 0 ? 'moved forward' : 'moved back'} ${amount}`;
}

export default function AutoBuild({
  photos, used, spec, hasSpreads, alwaysKeep, onBuild, onClose,
}: {
  photos: PhotoInfo[];
  used: Set<string>;
  spec: ProjectSpec;
  hasSpreads: boolean;
  /** Photos the photographer has marked as good, which are never left out. */
  alwaysKeep: string[];
  onBuild: (spreads: Spread[]) => void;
  onClose: () => void;
}) {
  const unused = useMemo(() => photos.filter((p) => !used.has(p.id)), [photos, used]);
  const [source, setSource] = useState<'all' | 'unused'>('all');
  const chosen = source === 'all' ? photos : unused;
  const chosenIds = useMemo(() => chosen.map((p) => p.id), [chosen]);
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);

  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [analysed, setAnalysed] = useState(false);
  const [unreadable, setUnreadable] = useState(0);

  const [tag, setTag] = useState('clean');
  const [wanted, setWanted] = useState<number | null>(null);
  const [splitByTime, setSplitByTime] = useState(true);
  const [syncClocks, setSyncClocks] = useState(true);
  const [keepMono, setKeepMono] = useState(true);
  const [story, setStory] = useState(true);
  const [useEvery, setUseEvery] = useState(false);
  const [leaveBlurry, setLeaveBlurry] = useState(true);
  const [leaveSimilar, setLeaveSimilar] = useState(true);
  const [keep, setKeep] = useState<string[]>([]);

  const [plan, setPlan] = useState<AlbumPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Reads the photos when the dialog opens. Results are kept, so a second time is quick.
  useEffect(() => {
    let current = true;
    setAnalysed(false);
    setProgress([0, chosenIds.length]);
    const stop = listen<[number, number]>('analysis-progress', (event) => {
      if (current) setProgress(event.payload);
    });
    analyzePhotos(chosenIds)
      .then((summary) => {
        if (!current) return;
        setUnreadable(summary.unreadable.length);
        setAnalysed(true);
      })
      .catch((e) => { if (current) setError(String(e)); });
    return () => {
      current = false;
      void stop.then((unlisten) => unlisten());
    };
  }, [chosenIds]);

  useEffect(() => {
    if (!analysed) return;
    let current = true;
    planForAlbum(chosenIds, {
      spreads: wanted,
      split_by_time: splitByTime,
      sync_clocks: syncClocks,
      keep_mono_together: keepMono,
      leave_out_blurry: !useEvery && leaveBlurry,
      leave_out_similar: !useEvery && leaveSimilar,
      keep: [...keep, ...alwaysKeep],
      tell_story: story,
    })
      .then((next) => { if (current) setPlan(next); })
      .catch((e) => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [analysed, chosenIds, wanted, splitByTime, syncClocks, keepMono, useEvery, leaveBlurry, leaveSimilar, keep, alwaysKeep, story]);

  async function build() {
    if (!plan) return;
    setBusy(true);
    setError('');
    try {
      const groups = plan.spreads.map((ids) => ids.flatMap((id) => byId.get(id) ?? []));
      const allOptions = await Promise.all(groups.map((group) => suggestLayouts(group, spec)));
      let previous: string | null = null;
      let singles = 0;
      const spreads: Spread[] = groups.map((group, i) => {
        const options = allOptions[i];
        // A feature photo takes turns: filling the spread, then sitting in open space.
        const style = group.length === 1 ? (singles++ % 2 === 0 ? 'hero' : 'airy') : tag;
        const optionIndex = chooseLayout(options, style, previous);
        const design = options[optionIndex].design;
        previous = design.template_id;
        return {
          id: crypto.randomUUID(),
          photoIds: group.map((p) => p.id),
          options,
          optionIndex,
          design,
        };
      });
      onBuild(spreads);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const placed = plan ? plan.spreads.reduce((sum, s) => sum + s.length, 0) : 0;
  const count = plan?.spreads.length ?? 0;

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Auto Build">
      <div className="modal modal-build">
        <h2>Auto Build</h2>
        <p className="muted">
          Reads when each photo was taken, how sharp it is and which shots repeat, then designs the
          album. Everything stays on this computer. It does not look at faces or closed eyes yet.
        </p>

        <div className="build-progress" role="status">
          {analysed ? (
            <span className="done">
              ✓ {chosen.length} photo{chosen.length === 1 ? '' : 's'} read
              {unreadable > 0 && `, ${unreadable} could not be read and will be placed anyway`}
            </span>
          ) : (
            <>
              <span>Reading photos… {progress?.[0] ?? 0} of {progress?.[1] ?? chosen.length}</span>
              <progress value={progress?.[0] ?? 0} max={progress?.[1] || 1} />
            </>
          )}
        </div>

        <div className="build-columns">
          <div className="build-column">
            <fieldset>
              <legend>Style</legend>
              <div className="style-cards">
                {STYLES.map((style) => (
                  <button
                    key={style.tag}
                    type="button"
                    aria-pressed={tag === style.tag}
                    className={`style-card ${tag === style.tag ? 'on' : ''}`}
                    onClick={() => setTag(style.tag)}
                  >
                    <span className="style-art" aria-hidden="true">
                      {style.art.map((box) => {
                        const [left, top, width, height] = box.split(',');
                        return <i key={box} style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }} />;
                      })}
                    </span>
                    <strong>{style.name}</strong>
                    <span>{style.hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend>Photos</legend>
              <div className="segment">
                <button type="button" aria-pressed={source === 'all'} className={source === 'all' ? 'on' : ''} onClick={() => setSource('all')}><ImagesIcon aria-hidden="true" />
                  All ({photos.length})
                </button>
                <button type="button" aria-pressed={source === 'unused'} className={source === 'unused' ? 'on' : ''} disabled={!unused.length} onClick={() => setSource('unused')}><ImageOffIcon aria-hidden="true" />
                  Unused ({unused.length})
                </button>
              </div>
            </fieldset>

            <fieldset>
              <legend className="legend-row">
                <span>Spreads</span>
                <button type="button" className="link" onClick={() => setWanted(null)}><LightbulbIcon aria-hidden="true" />Suggest</button>
              </legend>
              <div className="spread-count">
                <input
                  type="range"
                  aria-label="Number of spreads"
                  className="wide-range"
                  min={plan?.min_spreads ?? 1}
                  max={plan?.max_spreads ?? 1}
                  value={count}
                  disabled={!plan || plan.min_spreads === plan.max_spreads}
                  onChange={(e) => setWanted(Number(e.target.value))}
                />
                <strong>{count}</strong>
              </div>
            </fieldset>

            <fieldset className="smart-choices">
              <legend>Smart choices</legend>
              <label className="toggle" title="Opens and closes on a single photo, and gives each long part of the day a feature spread">
                <input type="checkbox" checked={story} onChange={(e) => setStory(e.target.checked)} />
                Tell a story with single-photo feature spreads
              </label>
              <label className="toggle">
                <input type="checkbox" checked={useEvery} onChange={(e) => setUseEvery(e.target.checked)} />
                Use every photo
              </label>
              <label className="toggle">
                <input type="checkbox" checked={!useEvery && leaveBlurry} disabled={useEvery} onChange={(e) => setLeaveBlurry(e.target.checked)} />
                Leave out blurry photos
              </label>
              <label className="toggle">
                <input type="checkbox" checked={!useEvery && leaveSimilar} disabled={useEvery} onChange={(e) => setLeaveSimilar(e.target.checked)} />
                Keep only the best of similar shots
              </label>
              <label className="toggle">
                <input type="checkbox" checked={splitByTime} onChange={(e) => setSplitByTime(e.target.checked)} />
                Start a new spread at each part of the day
              </label>
              <label className="toggle">
                <input type="checkbox" checked={keepMono} onChange={(e) => setKeepMono(e.target.checked)} />
                Keep black and white photos together
              </label>
              <label className="toggle">
                <input type="checkbox" checked={syncClocks} onChange={(e) => setSyncClocks(e.target.checked)} />
                Correct camera clocks that disagree
              </label>
            </fieldset>
          </div>

          <div className="build-column">
            <dl className="build-stats">
              <div><dt>Spreads</dt><dd>{count}</dd></div>
              <div><dt>Photos</dt><dd>{placed}</dd></div>
              <div><dt>Parts</dt><dd>{plan?.parts.length ?? 0}</dd></div>
              <div><dt>Left out</dt><dd>{plan?.left_out.length ?? 0}</dd></div>
            </dl>

            {plan && plan.parts.length > 0 && (
              <section>
                <h3 className="eyebrow">Parts of the day</h3>
                <ul className="parts">
                  {plan.parts.map((part, i) => (
                    <li key={i}>
                      <span>{partLabel(part.start, part.end)}</span>
                      <span>{part.photos} photos, {part.spreads} spread{part.spreads === 1 ? '' : 's'}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {plan && plan.photos_without_time > 0 && (
              <p className="muted">
                {plan.photos_without_time} photo{plan.photos_without_time === 1 ? ' has' : 's have'} no
                capture time, so {plan.photos_without_time === 1 ? 'it stays' : 'they stay'} beside
                {plan.photos_without_time === 1 ? ' its' : ' their'} neighbours by file name.
              </p>
            )}

            {plan?.clock_fixes.map((fix) => (
              <p key={fix.camera} className="clock-fix">
                {fix.camera}: clock {shiftLabel(fix.shift_seconds)} to match the main camera.
                Turn off the option above if this looks wrong.
              </p>
            ))}

            {plan && plan.left_out.length > 0 && (
              <section>
                <h3 className="eyebrow">Left out. Click one to put it back</h3>
                <div className="left-out">
                  {plan.left_out.map((item) => {
                    const photo = byId.get(item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="left-out-item"
                        title={`Put ${photo?.file_name ?? 'this photo'} back`}
                        onClick={() => setKeep((all) => [...all, item.id])}
                      >
                        <img src={previewUrl(item.id, GRID_PREVIEW)} alt={photo?.file_name ?? ''} loading="lazy" />
                        <span className="why">{item.reason === 'blurry' ? 'Looks blurry' : 'Similar shot'}</span>
                        <span className="restore">Put back</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {keep.length > 0 && (
              <button type="button" className="link" onClick={() => setKeep([])}><XIcon aria-hidden="true" />
                Clear {keep.length} photo{keep.length === 1 ? '' : 's'} put back by hand
              </button>
            )}
          </div>
        </div>

        {hasSpreads && (
          <p className="warn">This replaces your current spreads. You can bring them back with Undo.</p>
        )}
        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}><XIcon aria-hidden="true" />Cancel</button>
          <button type="button" className="btn-primary" disabled={busy || !plan || !count} onClick={() => void build()}><SparklesIcon aria-hidden="true" />
            {busy ? 'Building…' : 'Build album'}
          </button>
        </div>
      </div>
    </div>
  );
}
