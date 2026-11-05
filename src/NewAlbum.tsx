import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { makeSpec, printOptions, type Binding, type PrintOptions } from './api';
import type { Album } from './App';
import { ALBUM_FILTERS, loadAlbum, recentAlbums, type RecentAlbum } from './project';

const CM_PER_INCH = 2.54;

/** The sizes most studios order, shown large. Everything else is one click further. */
const FEATURED_SIZES: [number, number][] = [[12, 30], [12, 24], [16, 24]];

type Unit = 'in' | 'cm';

export default function NewAlbum({ onCreate }: { onCreate: (album: Album) => void }) {
  const [options, setOptions] = useState<PrintOptions | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [binding, setBinding] = useState<Binding>('layflat');
  const [size, setSize] = useState<[number, number]>([12, 30]);
  const [custom, setCustom] = useState({ on: false, height: '', width: '', unit: 'in' as Unit });
  const [marginIn, setMarginIn] = useState(0.35);
  const [gapIn, setGapIn] = useState(0.1);
  const [bleedMm, setBleedMm] = useState(3);
  const [dpi, setDpi] = useState(300);
  const [paper, setPaper] = useState('#FFFFFF');
  const [error, setError] = useState('');
  const [recent] = useState<RecentAlbum[]>(recentAlbums);

  useEffect(() => {
    printOptions().then(setOptions).catch((e) => setError(String(e)));
  }, []);

  const toInches = (value: string) => Number(value) / (custom.unit === 'cm' ? CM_PER_INCH : 1);
  const [heightIn, openWidthIn] = custom.on
    ? [toInches(custom.height), toInches(custom.width)]
    : size;
  const shapeKnown = heightIn > 0 && openWidthIn > 0;

  async function openPath(path: string) {
    setError('');
    try {
      onCreate(await loadAlbum(path));
    } catch (e) {
      setError(String(e));
    }
  }

  async function chooseFile() {
    const path = await open({ title: 'Open an album', filters: ALBUM_FILTERS });
    if (typeof path === 'string') await openPath(path);
  }

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
        ratings: {},
      });
    } catch (e) {
      setError(String(e));
    }
  }

  if (!options) {
    return <p className="center-note">{error || 'Loading…'}</p>;
  }

  const moreSizes = options.sizes_in.filter(
    ([h, w]) => !FEATURED_SIZES.some(([fh, fw]) => fh === h && fw === w),
  );
  const pickSize = (next: [number, number]) => {
    setCustom({ ...custom, on: false });
    setSize(next);
  };
  const isSize = (h: number, w: number) => !custom.on && size[0] === h && size[1] === w;

  return (
    <main className="welcome">
      <aside className="welcome-rail">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">E</span>
          <div>
            <strong>Eventor</strong>
            <span>Album Designer</span>
          </div>
        </div>
        <button type="button" className="btn wide-left" onClick={() => void chooseFile()}>
          Open album…
        </button>
        <h2 className="eyebrow">Recent</h2>
        {recent.length ? (
          <ul className="recent">
            {recent.map((item) => (
              <li key={item.path}>
                <button type="button" title={item.path} onClick={() => void openPath(item.path)}>
                  {item.name}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Albums you save or open appear here.</p>
        )}
      </aside>

      <section className="welcome-main">
        <header className="welcome-head">
          <div>
            <h1>New album</h1>
            <p>{step === 1 ? 'Who it is for, and the book you are making.' : 'How the pages look and print.'}</p>
          </div>
          <ol className="steps" aria-label="Progress">
            <li className={step === 1 ? 'on' : 'done'}><span>{step === 1 ? '1' : '✓'}</span>The book</li>
            <li className={step === 2 ? 'on' : ''}><span>2</span>Pages and print</li>
          </ol>
        </header>

        <div className="welcome-body">
          {step === 1 ? (
            <>
              <label className="field">
                Album name
                <input
                  className="input large"
                  value={name}
                  placeholder="Couple names"
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </label>

              <fieldset>
                <legend>Binding</legend>
                <div className="choice-row">
                  <BindingCard
                    on={binding === 'layflat'}
                    title="Lay-flat"
                    hint="Thick pages that open flat, so photos can cross the fold"
                    thick
                    onClick={() => setBinding('layflat')}
                  />
                  <BindingCard
                    on={binding === 'magazine'}
                    title="Magazine"
                    hint="Thin pages and more spreads, with a soft fold"
                    onClick={() => setBinding('magazine')}
                  />
                </div>
              </fieldset>

              <fieldset>
                <legend>Size, as height × open width in inches</legend>
                <div className="size-cards">
                  {FEATURED_SIZES.map(([h, w]) => (
                    <button
                      key={`${h}x${w}`}
                      type="button"
                      aria-pressed={isSize(h, w)}
                      className={`size-card ${isSize(h, w) ? 'on' : ''}`}
                      onClick={() => pickSize([h, w])}
                    >
                      <span className="size-shape" style={{ aspectRatio: String(w / h) }} aria-hidden="true" />
                      <strong>{h}×{w}</strong>
                      <span>each page {w / 2} × {h} in</span>
                    </button>
                  ))}
                </div>
                <div className="chips">
                  {moreSizes.map(([h, w]) => (
                    <button
                      key={`${h}x${w}`}
                      type="button"
                      aria-pressed={isSize(h, w)}
                      className={`chip ${isSize(h, w) ? 'on' : ''}`}
                      onClick={() => pickSize([h, w])}
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
                    onChange={(e) => setCustom({ ...custom, unit: e.target.value as Unit })}
                  >
                    <option value="in">in</option>
                    <option value="cm">cm</option>
                  </select>
                </div>
              </fieldset>
            </>
          ) : (
            <div className="appearance">
              <div className="appearance-preview">
                <SamplePages
                  openWidthIn={openWidthIn}
                  heightIn={heightIn}
                  marginIn={marginIn}
                  gapIn={gapIn}
                  paper={paper}
                />
                <p className="muted">A sample of your margin, gap and paper.</p>
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

              <div className="appearance-controls">
                <SliderWithPresets label="Margin" value={marginIn} max={1} presets={options.margins_in} onChange={setMarginIn} />
                <SliderWithPresets label="Gap between photos" value={gapIn} max={0.5} presets={options.gaps_in} onChange={setGapIn} />
                <Options label="Bleed" value={bleedMm} items={options.bleed_mm.map((b) => [b ? `${b} mm` : 'None', b])} onChange={setBleedMm} />
                <Options label="Print DPI" value={dpi} items={options.dpi.map((d) => [String(d), d])} onChange={setDpi} />
                <p className="muted">
                  Margin and gap apply to the whole album. Check bleed and DPI against what your lab asks for.
                </p>
              </div>
            </div>
          )}
        </div>

        <footer className="welcome-foot">
          {error && <p className="error">{error}</p>}
          {step === 2 && (
            <button type="button" className="btn" onClick={() => setStep(1)}>Back</button>
          )}
          {step === 1 ? (
            <button type="button" className="btn-primary" disabled={!shapeKnown} onClick={() => setStep(2)}>
              Next
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={() => void create()}>
              Create album
            </button>
          )}
        </footer>
      </section>
    </main>
  );
}

function BindingCard({
  on, title, hint, thick, onClick,
}: {
  on: boolean;
  title: string;
  hint: string;
  thick?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={on} className={`choice ${on ? 'on' : ''}`} onClick={onClick}>
      <span className={`binding-art ${thick ? 'thick' : ''}`} aria-hidden="true"><i /><i /></span>
      <span className="choice-text">
        <strong>{title}</strong>
        <span>{hint}</span>
      </span>
    </button>
  );
}

function Options({
  label, value, items, onChange,
}: {
  label: string;
  value: number;
  items: [string, number][];
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

function SliderWithPresets({
  label, value, max, presets, onChange,
}: {
  label: string;
  value: number;
  max: number;
  presets: [string, number][];
  onChange: (value: number) => void;
}) {
  return (
    <fieldset>
      <legend className="legend-row">
        <span>{label}</span>
        <span className="muted">{value.toFixed(2)} in</span>
      </legend>
      <input
        type="range"
        aria-label={label}
        className="wide-range"
        min={0}
        max={max}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="segment">
        {presets.map(([name, amount]) => (
          <button
            key={name}
            type="button"
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

/** One full page beside a stack of two, drawn with the chosen spacing. */
function SamplePages({
  openWidthIn, heightIn, marginIn, gapIn, paper,
}: {
  openWidthIn: number;
  heightIn: number;
  marginIn: number;
  gapIn: number;
  paper: string;
}) {
  const x = (inches: number) => `${(inches / openWidthIn) * 100}%`;
  const y = (inches: number) => `${(inches / heightIn) * 100}%`;
  const half = openWidthIn / 2;
  const box = (left: number, top: number, right: number, bottom: number) => ({
    left: x(left),
    top: y(top),
    width: x(right - left),
    height: y(bottom - top),
  });
  return (
    <div className="sample" style={{ aspectRatio: String(openWidthIn / heightIn), background: paper }}>
      <i style={box(marginIn, marginIn, half - gapIn / 2, heightIn - marginIn)} />
      <i style={box(half + gapIn / 2, marginIn, openWidthIn - marginIn, heightIn / 2 - gapIn / 2)} />
      <i style={box(half + gapIn / 2, heightIn / 2 + gapIn / 2, openWidthIn - marginIn, heightIn - marginIn)} />
      <span className="fold" />
    </div>
  );
}
