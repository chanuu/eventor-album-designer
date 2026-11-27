import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { Grade } from './api';

export const NO_GRADE: Grade = { hue: 0, saturation: 0, luminance: 0 };

/**
 * A colour wheel for colour grading: drag the dot round for the colour and out for how
 * much of it. Arrow keys move it, Shift for bigger steps; a double-click clears it.
 */
export default function ColourWheel({
  label, value, onChange, onGestureStart,
}: {
  label: string;
  value: Grade;
  onChange: (change: Partial<Grade>) => void;
  onGestureStart: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const dx = e.clientX - (box.left + box.width / 2);
    const dy = e.clientY - (box.top + box.height / 2);
    const radius = box.width / 2;
    const saturation = Math.min(1, Math.hypot(dx, dy) / radius);
    // Red at the right, going round anticlockwise as on most colour wheels.
    const hue = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    onChange({ hue: Math.round(hue), saturation: Math.round(saturation * 100) / 100 });
  };

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 2;
    const moves: Record<string, Partial<Grade>> = {
      ArrowLeft: { hue: (value.hue + step) % 360 },
      ArrowRight: { hue: (value.hue - step + 360) % 360 },
      ArrowUp: { saturation: Math.min(1, value.saturation + step / 100) },
      ArrowDown: { saturation: Math.max(0, value.saturation - step / 100) },
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    onGestureStart();
    onChange(move);
  };

  const angle = (value.hue * Math.PI) / 180;
  const dot = {
    left: `${50 + Math.cos(angle) * value.saturation * 50}%`,
    top: `${50 - Math.sin(angle) * value.saturation * 50}%`,
  };

  return (
    <div className="wheel-block">
      <span className="wheel-label">{label}</span>
      <div
        ref={ref}
        className="wheel"
        role="slider"
        tabIndex={0}
        aria-label={`${label} colour`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value.saturation * 100)}
        aria-valuetext={value.saturation > 0 ? `Hue ${Math.round(value.hue)}°, ${Math.round(value.saturation * 100)}%` : 'None'}
        title="Drag to choose a colour. Double-click to clear."
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          onGestureStart();
          fromPointer(e);
        }}
        onPointerMove={(e) => { if (dragging.current) fromPointer(e); }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
        onDoubleClick={() => { onGestureStart(); onChange({ hue: 0, saturation: 0 }); }}
        onKeyDown={key}
      >
        <span className="wheel-dot" style={{ ...dot, background: value.saturation > 0 ? `hsl(${value.hue} 90% 55%)` : '#fff' }} />
      </div>
      <label className="fx-row wheel-lum">
        <span className="fx-name">Luminance</span>
        <input
          type="range"
          aria-label={`${label} luminance`}
          min={-1}
          max={1}
          step={0.01}
          value={value.luminance}
          onPointerDown={onGestureStart}
          onDoubleClick={() => { onGestureStart(); onChange({ luminance: 0 }); }}
          onChange={(e) => onChange({ luminance: Number(e.target.value) })}
        />
        <output>{Math.round(value.luminance * 100)}</output>
      </label>
    </div>
  );
}
