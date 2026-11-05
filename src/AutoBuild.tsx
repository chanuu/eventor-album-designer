import { useMemo, useState } from 'react';
import { suggestLayouts, type LayoutOption, type PhotoInfo, type ProjectSpec, type Spread } from './api';

/** Layouts exist for up to this many photos on a spread. */
const MAX_PER_SPREAD = 6;
const USUAL_PER_SPREAD = 4;

type Style = { tag: string; name: string; hint: string; art: string[] };

/** `art` is a tiny drawing of the style: each entry is left, top, width, height in %. */
const STYLES: Style[] = [
  { tag: 'clean', name: 'Clean', hint: 'Even photos with tidy spacing', art: ['2,6,46,88', '52,6,46,41', '52,53,46,41'] },
  { tag: 'hero', name: 'Hero', hint: 'One full page beside smaller photos', art: ['0,0,50,100', '54,8,42,40', '54,52,42,40'] },
  { tag: 'panorama', name: 'Panorama', hint: 'One big photo across the fold', art: ['0,0,100,62', '4,68,44,26', '52,68,44,26'] },
  { tag: 'grid', name: 'Grid', hint: 'Columns and rows, more photos', art: ['2,6,22,88', '26,6,22,88', '52,6,22,88', '76,6,22,88'] },
];

/** Puts photos into spreads in order, as evenly as possible. */
export function divideEvenly<T>(items: T[], groups: number): T[][] {
  const result: T[][] = [];
  let start = 0;
  for (let i = 0; i < groups; i++) {
    const size = Math.round((items.length - start) / (groups - i));
    result.push(items.slice(start, start + size));
    start += size;
  }
  return result.filter((group) => group.length);
}

/** Prefers the chosen style, and avoids using the same layout twice in a row. */
function chooseLayout(options: LayoutOption[], tag: string, previous: string | null) {
  const inStyle = options.filter((o) => o.tags.includes(tag));
  const pool = inStyle.length ? inStyle : options;
  const pick = pool.find((o) => o.template_id !== previous) ?? pool[0];
  return options.indexOf(pick);
}

export default function AutoBuild({
  photos, used, spec, hasSpreads, onBuild, onClose,
}: {
  photos: PhotoInfo[];
  used: Set<string>;
  spec: ProjectSpec;
  hasSpreads: boolean;
  onBuild: (spreads: Spread[]) => void;
  onClose: () => void;
}) {
  const unused = useMemo(() => photos.filter((p) => !used.has(p.id)), [photos, used]);
  const [source, setSource] = useState<'all' | 'unused'>('all');
  const chosen = source === 'all' ? photos : unused;
  const fewest = Math.max(1, Math.ceil(chosen.length / MAX_PER_SPREAD));
  const most = Math.max(1, chosen.length);
  const [wanted, setWanted] = useState<number | null>(null);
  const suggested = Math.min(most, Math.max(fewest, Math.round(chosen.length / USUAL_PER_SPREAD)));
  const count = Math.min(most, Math.max(fewest, wanted ?? suggested));
  const [tag, setTag] = useState('clean');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function build() {
    setBusy(true);
    setError('');
    try {
      const groups = divideEvenly(chosen, count);
      const allOptions = await Promise.all(groups.map((group) => suggestLayouts(group, spec)));
      let previous: string | null = null;
      const spreads: Spread[] = groups.map((group, i) => {
        const options = allOptions[i];
        const optionIndex = chooseLayout(options, tag, previous);
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

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Auto Build">
      <div className="modal modal-wide">
        <h2>Auto Build</h2>
        <p className="muted">
          Lays out the album in file name order, choosing the layouts that crop your photos least.
          It does not judge the photos yet, so blurry shots and near-duplicates are not left out.
        </p>

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
            <button type="button" aria-pressed={source === 'all'} className={source === 'all' ? 'on' : ''} onClick={() => setSource('all')}>
              All ({photos.length})
            </button>
            <button type="button" aria-pressed={source === 'unused'} className={source === 'unused' ? 'on' : ''} disabled={!unused.length} onClick={() => setSource('unused')}>
              Unused ({unused.length})
            </button>
          </div>
        </fieldset>

        <fieldset>
          <legend className="legend-row">
            <span>Spreads</span>
            <button type="button" className="link" onClick={() => setWanted(null)}>Suggest</button>
          </legend>
          <div className="spread-count">
            <input
              type="range"
              aria-label="Number of spreads"
              className="wide-range"
              min={fewest}
              max={most}
              value={count}
              disabled={fewest === most}
              onChange={(e) => setWanted(Number(e.target.value))}
            />
            <strong>{count}</strong>
          </div>
        </fieldset>

        <dl className="build-stats">
          <div><dt>Spreads</dt><dd>{count}</dd></div>
          <div><dt>Pages</dt><dd>{count * 2}</dd></div>
          <div><dt>Photos</dt><dd>{chosen.length}</dd></div>
          <div><dt>Per spread</dt><dd>{chosen.length ? (chosen.length / count).toFixed(1) : '0'}</dd></div>
        </dl>

        {hasSpreads && (
          <p className="warn">This replaces your current spreads. You can bring them back with Undo.</p>
        )}
        {error && <p className="error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={busy || !chosen.length} onClick={() => void build()}>
            {busy ? 'Building…' : 'Build album'}
          </button>
        </div>
      </div>
    </div>
  );
}
