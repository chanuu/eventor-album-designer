import type { TextBlock } from './api';

const MIN_SIZE_PT = 6;
const MAX_SIZE_PT = 200;
const COLOURS = ['#000000', '#3A3A3A', '#FFFFFF', '#C9A24B', '#8C1D40', '#1F3A5F'];

/** Editing controls for the selected text block. */
export default function TextPanel({
  block, fonts, overflowed, onChange, onGestureStart, onDelete,
}: {
  block: TextBlock;
  fonts: string[];
  overflowed: boolean;
  onChange: (change: Partial<TextBlock>) => void;
  onGestureStart: () => void;
  onDelete: () => void;
}) {
  // A font from a saved album may not be on this computer, but it should still show.
  const choices = block.font && !fonts.includes(block.font) ? [block.font, ...fonts] : fonts;

  return (
    <section className="text-panel" aria-label="Text">
      <h3>Text</h3>
      <textarea
        className="input text-box"
        aria-label="Text content"
        rows={4}
        value={block.text}
        onFocus={onGestureStart}
        onChange={(e) => onChange({ text: e.target.value })}
      />
      {overflowed && (
        <p className="warn">This text does not fit in its box. Make the box bigger or the text smaller.</p>
      )}

      <label className="field">
        Font
        <select
          className="input"
          value={block.font}
          onChange={(e) => {
            onGestureStart();
            onChange({ font: e.target.value });
          }}
        >
          <option value="">Default</option>
          {choices.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>

      <label className="fx-row">
        <span>Size</span>
        <input
          type="range"
          aria-label="Text size"
          min={MIN_SIZE_PT}
          max={MAX_SIZE_PT}
          step={1}
          value={block.size_pt}
          onPointerDown={onGestureStart}
          onChange={(e) => onChange({ size_pt: Number(e.target.value) })}
        />
        <output>{Math.round(block.size_pt)} pt</output>
      </label>

      <label className="fx-row">
        <span>Line spacing</span>
        <input
          type="range"
          aria-label="Line spacing"
          min={0.8}
          max={2.5}
          step={0.05}
          value={block.line_height}
          onPointerDown={onGestureStart}
          onChange={(e) => onChange({ line_height: Number(e.target.value) })}
        />
        <output>{block.line_height.toFixed(2)}</output>
      </label>

      <div className="text-row">
        <div className="segment">
          {(['left', 'center', 'right'] as const).map((align) => (
            <button
              key={align}
              type="button"
              aria-pressed={block.align === align}
              className={block.align === align ? 'on' : ''}
              onClick={() => {
                onGestureStart();
                onChange({ align });
              }}
            >
              {{ left: 'Left', center: 'Centre', right: 'Right' }[align]}
            </button>
          ))}
        </div>
        <div className="segment">
          <button
            type="button"
            aria-pressed={block.bold}
            className={block.bold ? 'on' : ''}
            onClick={() => {
              onGestureStart();
              onChange({ bold: !block.bold });
            }}
          >
            <b>B</b>
          </button>
          <button
            type="button"
            aria-pressed={block.italic}
            className={block.italic ? 'on' : ''}
            onClick={() => {
              onGestureStart();
              onChange({ italic: !block.italic });
            }}
          >
            <i>I</i>
          </button>
        </div>
      </div>

      <div className="swatches">
        {COLOURS.map((colour) => (
          <button
            key={colour}
            type="button"
            aria-label={`Text colour ${colour}`}
            aria-pressed={block.colour.toUpperCase() === colour}
            className={`swatch ${block.colour.toUpperCase() === colour ? 'on' : ''}`}
            style={{ background: colour }}
            onClick={() => {
              onGestureStart();
              onChange({ colour });
            }}
          />
        ))}
        <input
          type="color"
          className="colour-pick"
          aria-label="Choose any text colour"
          value={block.colour}
          onPointerDown={onGestureStart}
          onChange={(e) => onChange({ colour: e.target.value })}
        />
      </div>

      <button type="button" className="btn" onClick={onDelete}>Delete text</button>
    </section>
  );
}
