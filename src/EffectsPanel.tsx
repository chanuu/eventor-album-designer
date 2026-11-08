import { ChevronDownIcon, ChevronRightIcon, RotateCcwIcon, Wand2Icon } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { Adjustments } from './api';

type MixKey = 'mix_hue' | 'mix_saturation' | 'mix_luminance';
type NumberKey = Exclude<keyof Adjustments, 'black_and_white' | MixKey>;

type Control = { key: NumberKey; label: string; min: number; max: number; step: number; scale: number; unit?: string };

const WHOLE = { min: -1, max: 1, step: 0.01, scale: 100 };

const TONE: Control[] = [
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.01, scale: 1 },
  { key: 'contrast', label: 'Contrast', ...WHOLE },
  { key: 'highlights', label: 'Highlights', ...WHOLE },
  { key: 'shadows', label: 'Shadows', ...WHOLE },
  { key: 'whites', label: 'Whites', ...WHOLE },
  { key: 'blacks', label: 'Blacks', ...WHOLE },
];

const COLOUR: Control[] = [
  { key: 'temperature', label: 'Temperature', ...WHOLE },
  { key: 'tint', label: 'Tint', ...WHOLE },
  { key: 'vibrance', label: 'Vibrance', ...WHOLE },
  { key: 'saturation', label: 'Saturation', ...WHOLE },
];

const HUE_SATURATION: Control[] = [
  { key: 'hue', label: 'Hue', ...WHOLE, scale: 180, unit: '°' },
  { key: 'saturation', label: 'Saturation', ...WHOLE },
  { key: 'lightness', label: 'Lightness', ...WHOLE },
];

/** The colour mixer's eight colours, in the order Rust keeps them, with their hue in degrees. */
const MIX_COLOURS = [
  { name: 'Red', hue: 0 },
  { name: 'Orange', hue: 30 },
  { name: 'Yellow', hue: 60 },
  { name: 'Green', hue: 120 },
  { name: 'Aqua', hue: 180 },
  { name: 'Blue', hue: 240 },
  { name: 'Purple', hue: 270 },
  { name: 'Magenta', hue: 300 },
];

const MIX_TABS: { key: MixKey; label: string }[] = [
  { key: 'mix_hue', label: 'Hue' },
  { key: 'mix_saturation', label: 'Saturation' },
  { key: 'mix_luminance', label: 'Luminance' },
];

const NONE = [0, 0, 0, 0, 0, 0, 0, 0];

export const NO_ADJUSTMENTS: Adjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  black_and_white: false,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  hue: 0,
  lightness: 0,
  mix_hue: NONE,
  mix_saturation: NONE,
  mix_luminance: NONE,
};

/** What each slider of the mixer does, shown along its track. */
function mixTrack(tab: MixKey, hue: number): string {
  if (tab === 'mix_hue') return `linear-gradient(90deg, hsl(${hue - 30} 80% 50%), hsl(${hue} 80% 50%), hsl(${hue + 30} 80% 50%))`;
  if (tab === 'mix_saturation') return `linear-gradient(90deg, hsl(${hue} 0% 50%), hsl(${hue} 90% 50%))`;
  return `linear-gradient(90deg, hsl(${hue} 80% 18%), hsl(${hue} 80% 50%), hsl(${hue} 80% 82%))`;
}

type Section = 'tone' | 'colour' | 'mixer' | 'hue';

/**
 * Tone and colour controls. The picture comes from Rust through the same function the
 * exporter uses, so there is no separate on-screen version that could print differently.
 */
export default function EffectsPanel({
  title, hint, value: given, showOriginal, autoBusy, onChange, onGestureStart, onAuto, onShowOriginal,
}: {
  title: string;
  hint: string;
  value: Adjustments;
  showOriginal: boolean;
  autoBusy: boolean;
  onChange: (change: Partial<Adjustments>) => void;
  onGestureStart: () => void;
  onAuto: () => void;
  onShowOriginal: (show: boolean) => void;
}) {
  const [open, setOpen] = useState<Section | null>(null);
  const [tab, setTab] = useState<MixKey>('mix_hue');
  // An album saved before these controls existed simply has none of them set.
  const value: Adjustments = { ...NO_ADJUSTMENTS, ...given };
  const changed = JSON.stringify(value) !== JSON.stringify(NO_ADJUSTMENTS);
  const toggle = (section: Section) => setOpen(open === section ? null : section);

  const row = (control: Control) => (
    <EffectSlider
      key={control.key}
      label={control.label}
      control={control}
      value={value[control.key]}
      onGestureStart={onGestureStart}
      onChange={(next) => onChange({ [control.key]: next })}
    />
  );

  const setMix = (index: number, next: number) => {
    const values = [...value[tab]];
    values[index] = next;
    onChange({ [tab]: values });
  };

  return (
    <section className="effects" aria-label="Effects">
      <h3>{title}</h3>
      <p className="muted">{hint}</p>

      <button type="button" className="btn" disabled={autoBusy} onClick={onAuto}><Wand2Icon aria-hidden="true" />
        {autoBusy ? 'Working…' : 'Auto colour and levels'}
      </button>

      <Group name="Tone adjustments" open={open === 'tone'} onToggle={() => toggle('tone')}>
        {TONE.map(row)}
      </Group>
      <Group name="Colour" open={open === 'colour'} onToggle={() => toggle('colour')}>
        {COLOUR.map(row)}
      </Group>
      <Group name="Colour mixer" open={open === 'mixer'} onToggle={() => toggle('mixer')}>
        <div className="segment mix-tabs" role="tablist" aria-label="What the mixer changes">
          {MIX_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={tab === t.key ? 'on' : ''}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        {MIX_COLOURS.map((colour, index) => (
          <EffectSlider
            key={colour.name}
            label={colour.name}
            dot={`hsl(${colour.hue} 80% 55%)`}
            track={mixTrack(tab, colour.hue)}
            control={{ key: 'hue', label: colour.name, ...WHOLE }}
            value={value[tab][index] ?? 0}
            onGestureStart={onGestureStart}
            onChange={(next) => setMix(index, next)}
            onReset={() => {
              onGestureStart();
              setMix(index, 0);
            }}
          />
        ))}
      </Group>
      <Group name="Hue / Saturation" open={open === 'hue'} onToggle={() => toggle('hue')}>
        {HUE_SATURATION.map(row)}
      </Group>

      <label className="toggle bw">
        <input
          type="checkbox"
          checked={value.black_and_white}
          onChange={(e) => {
            onGestureStart();
            onChange({ black_and_white: e.target.checked });
          }}
        />
        Black and white
      </label>

      <label className="toggle">
        <input
          type="checkbox"
          checked={showOriginal}
          onChange={(e) => onShowOriginal(e.target.checked)}
        />
        Show the original, without effects
      </label>

      <button
        type="button"
        className="btn"
        disabled={!changed}
        onClick={() => {
          onGestureStart();
          onChange(NO_ADJUSTMENTS);
        }}
      ><RotateCcwIcon aria-hidden="true" />
        Reset effects
      </button>
    </section>
  );
}

function Group({
  name, open, onToggle, children,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fx-group">
      <button type="button" className="fx-head" aria-expanded={open} onClick={onToggle}>
        {name}
        {open ? <ChevronDownIcon aria-hidden="true" /> : <ChevronRightIcon aria-hidden="true" />}
      </button>
      {open && <div className="fx-body">{children}</div>}
    </div>
  );
}

function EffectSlider({
  label, control, value, dot, track, onChange, onGestureStart, onReset,
}: {
  label: string;
  control: Control;
  value: number;
  dot?: string;
  track?: string;
  onChange: (value: number) => void;
  onGestureStart: () => void;
  onReset?: () => void;
}) {
  const shown = control.scale === 1 ? value.toFixed(2) : `${Math.round(value * control.scale)}${control.unit ?? ''}`;
  return (
    <label className={`fx-row ${onReset ? 'mix-row' : ''}`} style={track ? ({ '--track': track } as CSSProperties) : undefined}>
      <span className="fx-name">
        {dot && <i className="fx-dot" style={{ background: dot }} aria-hidden="true" />}
        {label}
      </span>
      <input
        type="range"
        aria-label={label}
        min={control.min}
        max={control.max}
        step={control.step}
        value={value}
        onPointerDown={onGestureStart}
        onDoubleClick={() => {
          onGestureStart();
          onChange(0);
        }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>{shown}</output>
      {onReset && (
        <button
          type="button"
          className="fx-reset"
          aria-label={`Reset ${label}`}
          disabled={value === 0}
          onClick={(e) => {
            e.preventDefault();
            onReset();
          }}
        >
          <RotateCcwIcon aria-hidden="true" />
        </button>
      )}
    </label>
  );
}
