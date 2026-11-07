import { RotateCcwIcon, Wand2Icon } from 'lucide-react';
import { useState } from 'react';
import type { Adjustments } from './api';

type NumberKey = Exclude<keyof Adjustments, 'black_and_white'>;

type Control = { key: NumberKey; label: string; min: number; max: number; step: number; digits: number };

const WHOLE: Omit<Control, 'key' | 'label'> = { min: -1, max: 1, step: 0.01, digits: 0 };

const TONE: Control[] = [
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.01, digits: 2 },
  { key: 'contrast', label: 'Contrast', ...WHOLE },
  { key: 'highlights', label: 'Highlights', ...WHOLE },
  { key: 'shadows', label: 'Shadows', ...WHOLE },
];

const COLOUR: Control[] = [
  { key: 'temperature', label: 'Temperature', ...WHOLE },
  { key: 'tint', label: 'Tint', ...WHOLE },
  { key: 'saturation', label: 'Saturation', ...WHOLE },
];

export const NO_ADJUSTMENTS: Adjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  black_and_white: false,
};

/**
 * Tone and colour controls. The picture comes from Rust through the same function the
 * exporter uses, so there is no separate on-screen version that could print differently.
 */
export default function EffectsPanel({
  title, hint, value, showOriginal, autoBusy, onChange, onGestureStart, onAuto, onShowOriginal,
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
  const [open, setOpen] = useState<'tone' | 'colour' | null>(null);
  const changed = JSON.stringify(value) !== JSON.stringify(NO_ADJUSTMENTS);

  const row = (control: Control) => (
    <EffectSlider
      key={control.key}
      control={control}
      value={value[control.key]}
      onGestureStart={onGestureStart}
      onChange={(next) => onChange({ [control.key]: next })}
    />
  );

  return (
    <section className="effects" aria-label="Effects">
      <h3>{title}</h3>
      <p className="muted">{hint}</p>

      <button type="button" className="btn" disabled={autoBusy} onClick={onAuto}><Wand2Icon aria-hidden="true" />
        {autoBusy ? 'Working…' : 'Auto colour and levels'}
      </button>

      <Group name="Tone" open={open === 'tone'} onToggle={() => setOpen(open === 'tone' ? null : 'tone')}>
        {TONE.map(row)}
      </Group>
      <Group name="Colour" open={open === 'colour'} onToggle={() => setOpen(open === 'colour' ? null : 'colour')}>
        {COLOUR.map(row)}
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
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="fx-body">{children}</div>}
    </div>
  );
}

function EffectSlider({
  control, value, onChange, onGestureStart,
}: {
  control: Control;
  value: number;
  onChange: (value: number) => void;
  onGestureStart: () => void;
}) {
  const shown = control.digits
    ? `${value > 0 ? '+' : ''}${value.toFixed(control.digits)}`
    : `${value > 0 ? '+' : ''}${Math.round(value * 100)}`;
  return (
    <label className="fx-row" title="Double-click to reset">
      <span>{control.label}</span>
      <input
        type="range"
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
    </label>
  );
}
