import { FolderOpenIcon, Home as HomeIcon } from 'lucide-react';
import { useState } from 'react';

import { makeSpec, type CardDetails } from './api';
import type { Album } from './App';
import CardDetailsForm from './CardDetailsForm';
import { CARD_SIZES, NO_DETAILS, rememberedStudio, rememberStudio, type Orientation } from './cards';

const BLEED_MM = 3;
const DPI = 300;

/** Starts a set of thank you cards: who they are for, and the card being printed. */
export default function NewCards({
  onCreate, onBack,
}: {
  onCreate: (album: Album) => void;
  onBack: () => void;
}) {
  const [details, setDetails] = useState<CardDetails>(() => ({ ...NO_DETAILS, studio: rememberedStudio() }));
  const [size, setSize] = useState<[number, number]>([6, 8]);
  const [orientation, setOrientation] = useState<Orientation>('portrait');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [short, long] = size;
  const [widthIn, heightIn] = orientation === 'portrait' ? [short, long] : [long, short];
  const named = details.first_name.trim() && details.second_name.trim();

  async function create() {
    setError('');
    setBusy(true);
    try {
      // A card is one sheet, so it has no margin or gap of its own: each design carries them.
      const spec = await makeSpec({
        open_width_in: widthIn,
        height_in: heightIn,
        binding: 'layflat',
        margin_in: 0,
        gap_in: 0,
        bleed_mm: BLEED_MM,
        target_dpi: DPI,
        paper: '#FFFFFF',
      });
      rememberStudio(details.studio.trim());
      onCreate({
        kind: 'cards',
        details,
        name: `${details.first_name.trim()} & ${details.second_name.trim()} thank you cards`,
        spec,
        sizeLabel: `${widthIn}×${heightIn} in`,
        path: null,
        photos: [],
        spreads: [],
        missing: [],
        ratings: {},
        publish: null,
        importOnOpen: true,
      });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

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
        <button type="button" className="btn wide-left" onClick={onBack}><HomeIcon aria-hidden="true" />Home</button>
      </aside>

      <section className="welcome-main">
        <header className="welcome-head">
          <div>
            <h1>New thank you cards</h1>
            <p>Who the cards are for, and the card you are printing. You can change the details later.</p>
          </div>
        </header>

        <div className="welcome-body">
          <fieldset className="plain">
            <legend>The couple</legend>
            <CardDetailsForm value={details} onChange={setDetails} />
          </fieldset>

          <fieldset className="plain">
            <legend>Card size</legend>
            <div className="size-cards four">
              {CARD_SIZES.map(([s, l]) => {
                const on = s === short && l === long;
                const [w, h] = orientation === 'portrait' ? [s, l] : [l, s];
                return (
                  <button key={`${s}x${l}`} type="button" aria-pressed={on} className={`size-card ${on ? 'on' : ''}`} onClick={() => setSize([s, l])}>
                    <span className="card-shape" style={{ aspectRatio: String(w / h) }} aria-hidden="true" />
                    <strong>{s}×{l} in</strong>
                    <span>{(s * 2.54).toFixed(1)} × {(l * 2.54).toFixed(1)} cm</span>
                  </button>
                );
              })}
            </div>
            <div className="segment" role="group" aria-label="Which way up">
              {(['portrait', 'landscape'] as const).map((way) => (
                <button key={way} type="button" aria-pressed={orientation === way} className={orientation === way ? 'on' : ''} onClick={() => setOrientation(way)}>
                  {way === 'portrait' ? 'Portrait (tall)' : 'Landscape (wide)'}
                </button>
              ))}
            </div>
            <p className="muted">Printed at {DPI} DPI with {BLEED_MM} mm bleed on every edge.</p>
          </fieldset>
        </div>

        <footer className="welcome-foot">
          {error && <p className="error">{error}</p>}
          {!named && <p className="muted">Enter both names to continue.</p>}
          <button type="button" className="btn-primary" disabled={!named || busy} onClick={() => void create()}>
            <FolderOpenIcon aria-hidden="true" />Choose the photo folder
          </button>
        </footer>
      </section>
    </main>
  );
}
