import { CheckIcon, MusicIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { musicDetails, MUSIC_EXTENSIONS, type Cover, type Music, type ProjectSpec } from './api';
import { COLOURS, defaultCover, DESIGNS, FOILS, MATERIALS } from './cover';
import FlipBook from './FlipBook';

const NAME_LENGTH = 40;
const LINE_LENGTH = 60;

/** Designs the digital album's cover, and chooses the music that plays with it. */
export default function CoverDesigner({
  albumName, spec, cover, music, onSave, onClose,
}: {
  albumName: string;
  spec: ProjectSpec;
  cover: Cover | null;
  music: Music | null;
  onSave: (cover: Cover | null, music: Music | null) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Cover>(cover ?? defaultCover(albumName));
  const [track, setTrack] = useState<Music | null>(music);
  const [side, setSide] = useState(0);
  const [error, setError] = useState('');
  const set = (change: Partial<Cover>) => {
    setDraft((was) => ({ ...was, ...change }));
    setSide(0);
  };

  async function chooseMusic() {
    setError('');
    const picked = await open({ multiple: false, filters: [{ name: 'Music', extensions: MUSIC_EXTENSIONS }] });
    if (typeof picked !== 'string') return;
    try {
      const file = await musicDetails(picked);
      setTrack({ path: picked, name: file.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const foilOf = (tones: readonly string[]) => (tones.length
    ? `linear-gradient(135deg, ${tones.join(', ')})`
    : 'linear-gradient(135deg, #5d5d62, #8b8b90 45%, #4b4b50)');

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Cover and music">
      <div className="modal modal-cover">
        <div className="cover-view">
          <FlipBook spec={spec} spreads={[]} photos={[]} cover={draft} title={albumName} at={side} onAt={setSide} />
          <p className="muted">Click the book to turn it over.</p>
        </div>

        <div className="cover-controls">
          <h2>Cover and music</h2>
          <p className="muted">The cover opens the client's digital album. It is not part of the printed pages.</p>

          <section>
            <h3>Material</h3>
            <div className="chip-row">
              {MATERIALS.map((m) => (
                <button key={m.id} type="button" className={`chip ${draft.material === m.id ? 'on' : ''}`} aria-pressed={draft.material === m.id} title={m.note} onClick={() => set({ material: m.id })}>
                  {m.name}
                </button>
              ))}
            </div>
            <div className="swatch-row" role="group" aria-label="Colour">
              {COLOURS.map((c) => (
                <button key={c.id} type="button" className={`swatch ${draft.colour === c.id ? 'on' : ''}`} aria-pressed={draft.colour === c.id} aria-label={c.name} title={c.name} style={{ background: c.hex }} onClick={() => set({ colour: c.id })} />
              ))}
            </div>
          </section>

          <section>
            <h3>Foil</h3>
            <div className="chip-row">
              {FOILS.map((f) => (
                <button key={f.id} type="button" className={`chip ${draft.foil === f.id ? 'on' : ''}`} aria-pressed={draft.foil === f.id} onClick={() => set({ foil: f.id })}>
                  <i className="foil-dot" style={{ background: foilOf(f.tones) }} />{f.name}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3>Lettering</h3>
            <div className="chip-row">
              {DESIGNS.map((d) => (
                <button key={d.id} type="button" className={`chip ${draft.design === d.id ? 'on' : ''}`} aria-pressed={draft.design === d.id} title={d.note} onClick={() => set({ design: d.id })}>
                  {d.name}
                </button>
              ))}
            </div>
            <div className="cover-fields">
              <label className="field">First name
                <input className="input" value={draft.first_name} maxLength={NAME_LENGTH} placeholder="Evelyn" onChange={(e) => set({ first_name: e.target.value })} />
              </label>
              <label className="field">Second name
                <input className="input" value={draft.second_name} maxLength={NAME_LENGTH} placeholder="Samuel" onChange={(e) => set({ second_name: e.target.value })} />
              </label>
              <label className="field">Date
                <input className="input" value={draft.date} maxLength={NAME_LENGTH} placeholder="20 . 08 . 2026" onChange={(e) => set({ date: e.target.value })} />
              </label>
              <label className="field">Venue
                <input className="input" value={draft.venue} maxLength={LINE_LENGTH} placeholder="Galle Face Hotel" onChange={(e) => set({ venue: e.target.value })} />
              </label>
            </div>
          </section>

          <section>
            <h3>Music</h3>
            {track ? (
              <p className="music-line">
                <MusicIcon aria-hidden="true" />
                <span title={track.path}>{track.name}</span>
                <button type="button" className="btn" onClick={() => void chooseMusic()}>Change…</button>
                <button type="button" className="btn icon-btn" aria-label="Remove music" onClick={() => setTrack(null)}><XIcon aria-hidden="true" /></button>
              </p>
            ) : (
              <p className="music-line">
                <button type="button" className="btn" onClick={() => void chooseMusic()}><MusicIcon aria-hidden="true" />Choose a track…</button>
                <span className="muted">MP3, M4A, AAC, OGG or WAV, up to 10 MB. It plays while the client turns the pages.</span>
              </p>
            )}
            {error && <p className="error" role="alert">{error}</p>}
          </section>

          <div className="modal-actions">
            {cover && (
              <button type="button" className="btn cover-remove" onClick={() => onSave(null, track)}><Trash2Icon aria-hidden="true" />Remove cover</button>
            )}
            <button type="button" className="btn" onClick={onClose}><XIcon aria-hidden="true" />Cancel</button>
            <button type="button" className="btn-primary" onClick={() => onSave(draft, track)}><CheckIcon aria-hidden="true" />Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
