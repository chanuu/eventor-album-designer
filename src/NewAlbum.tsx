import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { makeSpec, printOptions, type Binding, type PrintOptions } from './api';
import type { Album } from './App';
import { ALBUM_FILTERS, loadAlbum } from './project';

const CM_PER_INCH = 2.54;

export default function NewAlbum({ onCreate }: { onCreate: (album: Album) => void }) {
  const [options, setOptions] = useState<PrintOptions | null>(null);
  const [name, setName] = useState('');
  const [binding, setBinding] = useState<Binding>('layflat');
  const [size, setSize] = useState<[number, number]>([12, 30]);
  const [custom, setCustom] = useState({ on: false, height: '', width: '', unit: 'in' as 'in' | 'cm' });
  const [marginIn, setMarginIn] = useState(0.35);
  const [gapIn, setGapIn] = useState(0.1);
  const [bleedMm, setBleedMm] = useState(3);
  const [dpi, setDpi] = useState(300);
  const [paper, setPaper] = useState('#FFFFFF');
  const [error, setError] = useState('');

  useEffect(() => {
    printOptions().then(setOptions).catch((e) => setError(String(e)));
  }, []);

  const toInches = (value: string) =>
    Number(value) / (custom.unit === 'cm' ? CM_PER_INCH : 1);
  const [heightIn, openWidthIn] = custom.on
    ? [toInches(custom.height), toInches(custom.width)]
    : size;
  const shapeKnown = heightIn > 0 && openWidthIn > 0;

  async function create() {
    setError('');
    try {
      const spec = await makeSpec({
        open_width_in: openWidthIn,
        height_in: heightIn,
        binding,
        margin_in: marginIn,
        gap_in: gapIn,
        bleed_mm: bleedMm,
        target_dpi: dpi,
        paper,
      });
      const sizeLabel = custom.on
        ? `${custom.height}×${custom.width} ${custom.unit}`
        : `${heightIn}×${openWidthIn} in`;
      onCreate({
        name: name.trim() || 'Untitled album',
        spec,
        sizeLabel,
        path: null,
        photos: [],
        spreads: [],
        missing: [],
      });
    } catch (e) {
      setError(String(e));
    }
  }

  async function openExisting() {
    setError('');
    try {
      const path = await open({ title: 'Open an album', filters: ALBUM_FILTERS });
      if (typeof path === 'string') onCreate(await loadAlbum(path));
    } catch (e) {
      setError(String(e));
    }
  }

  if (!options) {
    return <p className="center-note">{error || 'Loading…'}</p>;
  }

  return (
    <main className="new-album">
      <header className="new-album-head">
        <div>
          <h1>New album</h1>
          <p>Set up the book. Photos come next.</p>
        </div>
        <button type="button" className="btn" onClick={() => void openExisting()}>
          Open album…
        </button>
      </header>

      <div className="new-album-body">
        <div className="form">
          <label className="field">
            Album name
            <input
              className="input"
              value={name}
              placeholder="Couple names"
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>

          <fieldset>
            <legend>Binding</legend>
            <div className="choice-row">
              <Choice
                on={binding === 'layflat'}
                title="Lay-flat"
                hint="Thick pages that open flat"
                onClick={() => setBinding('layflat')}
              />
              <Choice
                on={binding === 'magazine'}
                title="Magazine"
                hint="Thin pages, more spreads"
                onClick={() => setBinding('magazine')}
              />
            </div>
          </fieldset>

          <fieldset>
            <legend>Size (height × open width, inches)</legend>
            <div className="chips">
              {options.sizes_in.map(([h, w]) => (
                <button
                  key={`${h}x${w}`}
                  type="button"
                  className={`chip ${!custom.on && size[0] === h && size[1] === w ? 'on' : ''}`}
                  onClick={() => {
                    setCustom({ ...custom, on: false });
                    setSize([h, w]);
                  }}
                >
                  {h}×{w}
                </button>
              ))}
            </div>
            <div className="custom-size">
              <span>Custom</span>
              <input
                className="input"
                aria-label="Custom height"
                placeholder="Height"
                inputMode="decimal"
                value={custom.height}
                onChange={(e) => setCustom({ ...custom, on: true, height: e.target.value })}
              />
              <span>×</span>
              <input
                className="input"
                aria-label="Custom open width"
                placeholder="Open width"
                inputMode="decimal"
                value={custom.width}
                onChange={(e) => setCustom({ ...custom, on: true, width: e.target.value })}
              />
              <select
                className="input"
                aria-label="Custom size unit"
                value={custom.unit}
                onChange={(e) => setCustom({ ...custom, unit: e.target.value as 'in' | 'cm' })}
              >
                <option value="in">in</option>
                <option value="cm">cm</option>
              </select>
            </div>
          </fieldset>

          <div className="two-col">
            <Options
              label="Margin"
              value={marginIn}
              items={options.margins_in}
              unit="in"
              onChange={setMarginIn}
            />
            <Options
              label="Gap between photos"
              value={gapIn}
              items={options.gaps_in}
              unit="in"
              onChange={setGapIn}
            />
            <Options
              label="Bleed"
              value={bleedMm}
              items={options.bleed_mm.map((b) => [`${b} mm`, b])}
              onChange={setBleedMm}
            />
            <Options
              label="Print DPI"
              value={dpi}
              items={options.dpi.map((d) => [String(d), d])}
              onChange={setDpi}
            />
          </div>

          <fieldset>
            <legend>Paper</legend>
            <div className="swatches">
              {options.paper.map((colour) => (
                <button
                  key={colour}
                  type="button"
                  aria-label={`Paper colour ${colour}`}
                  aria-pressed={paper === colour}
                  className={`swatch ${paper === colour ? 'on' : ''}`}
                  style={{ background: colour }}
                  onClick={() => setPaper(colour)}
                />
              ))}
            </div>
          </fieldset>
        </div>

        <aside className="preview-pane">
          <p className="pane-label">The open book</p>
          {shapeKnown ? (
            <BookPreview
              openWidthIn={openWidthIn}
              heightIn={heightIn}
              marginIn={marginIn}
              paper={paper}
            />
          ) : (
            <p className="muted">Enter a height and width.</p>
          )}
          {shapeKnown && (
            <p className="muted">
              Each page is {round(openWidthIn / 2)} × {round(heightIn)} in.
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <button
            type="button"
            className="btn-primary wide"
            disabled={!shapeKnown}
            onClick={() => void create()}
          >
            Create album
          </button>
        </aside>
      </div>
    </main>
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function Choice({
  on, title, hint, onClick,
}: {
  on: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={on} className={`choice ${on ? 'on' : ''}`} onClick={onClick}>
      <strong>{title}</strong>
      <span>{hint}</span>
    </button>
  );
}

function Options({
  label, value, items, unit, onChange,
}: {
  label: string;
  value: number;
  items: [string, number][];
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <div className="segment">
        {items.map(([name, amount]) => (
          <button
            key={name}
            type="button"
            title={unit ? `${amount} ${unit}` : undefined}
            aria-pressed={value === amount}
            className={value === amount ? 'on' : ''}
            onClick={() => onChange(amount)}
          >
            {name}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function BookPreview({
  openWidthIn, heightIn, marginIn, paper,
}: {
  openWidthIn: number;
  heightIn: number;
  marginIn: number;
  paper: string;
}) {
  const inset = {
    x: (marginIn / openWidthIn) * 100,
    y: (marginIn / heightIn) * 100,
  };
  return (
    <div className="book" style={{ aspectRatio: String(openWidthIn / heightIn), background: paper }}>
      <span
        className="book-safe"
        style={{ left: `${inset.x}%`, right: `${inset.x}%`, top: `${inset.y}%`, bottom: `${inset.y}%` }}
      />
      <span className="fold" />
    </div>
  );
}
