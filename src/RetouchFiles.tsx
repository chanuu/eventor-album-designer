import { open } from '@tauri-apps/plugin-dialog';
import { ArrowLeftIcon, FolderOpenIcon, ImagesIcon, WandSparklesIcon } from 'lucide-react';
import { useState } from 'react';
import { NO_RETOUCH, openToRetouch, saveRetouchedPhoto } from './api';
import { NO_ADJUSTMENTS } from './EffectsPanel';
import { LoaderScreen } from './Loader';
import Retoucher, { type RetouchItem } from './Retoucher';

const PHOTO_FILTERS = [{ name: 'Photos', extensions: ['jpg', 'jpeg', 'jpe', 'png', 'webp'] }];

/**
 * Magic Retouch from the home screen: any photos, no album needed. Each retouched photo
 * is saved as a copy in a Retouched folder beside it; the original is never changed.
 */
export default function RetouchFiles({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<RetouchItem[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  async function openPaths(paths: string[]) {
    if (!paths.length) return;
    setError('');
    setOpening(true);
    try {
      const { photos, skipped } = await openToRetouch(paths);
      if (!photos.length) {
        setError(skipped.length ? `None of those could be opened: ${skipped.join(', ')}` : 'There are no photos there.');
        return;
      }
      setItems(photos.map(({ photo, saved }) => ({
        photo,
        edits: saved?.edits ?? NO_RETOUCH,
        adjust: { ...NO_ADJUSTMENTS, ...(saved?.adjust ?? {}) },
      })));
      if (skipped.length) setError(`Skipped ${skipped.length} that could not be opened.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setOpening(false);
    }
  }

  async function choosePhotos() {
    const chosen = await open({ title: 'Choose photos to retouch', multiple: true, filters: PHOTO_FILTERS });
    if (Array.isArray(chosen)) await openPaths(chosen);
    else if (typeof chosen === 'string') await openPaths([chosen]);
  }

  async function chooseFolder() {
    const chosen = await open({ title: 'Choose a folder of photos to retouch', directory: true });
    if (typeof chosen === 'string') await openPaths([chosen]);
  }

  if (items) {
    return (
      <Retoucher
        mode="files"
        items={items}
        onClose={() => setItems(null)}
        onSave={async ({ photo, edits, adjust }) => {
          const where = await saveRetouchedPhoto(photo.id, { edits, adjust });
          return `Saved to ${where}`;
        }}
      />
    );
  }

  return (
    <main className="home">
      {opening && <LoaderScreen label="Opening the photos…" />}
      <header className="home-head">
        <button type="button" className="btn" onClick={onBack}><ArrowLeftIcon aria-hidden="true" />Back</button>
      </header>
      <section className="home-body">
        <h1><WandSparklesIcon aria-hidden="true" className="title-icon" /> Magic Retouch</h1>
        <p className="muted">
          Heal spots, smooth and brighten skin, whiten teeth, fix red eyes and set the colour.
          Your photos are never changed: each one you save is copied into a <strong>Retouched</strong> folder beside it.
        </p>
        <div className="home-cards">
          <button type="button" className="home-card primary" onClick={() => void choosePhotos()}><ImagesIcon aria-hidden="true" />
            <strong>Choose photos</strong>
            <span>One photo, or several to work through one after another.</span>
          </button>
          <button type="button" className="home-card" onClick={() => void chooseFolder()}><FolderOpenIcon aria-hidden="true" />
            <strong>Choose a folder</strong>
            <span>Every photo in the folder, ready to retouch.</span>
          </button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
