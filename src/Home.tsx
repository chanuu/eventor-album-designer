import { BookOpenIcon, FolderOpenIcon, ImagesIcon, LogOutIcon } from 'lucide-react';
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import type { Album } from './App';
import type { Staff } from './eventor';
import { LoaderScreen } from './Loader';
import { ALBUM_FILTERS, loadAlbum, recentAlbums, type RecentAlbum } from './project';

/** The first screen: what the studio has come here to do. */
export default function Home({
  staff, canCreateGallery, offline, onCreateGallery, onCreateAlbum, onOpen, onSignOut,
}: {
  staff: Staff | null;
  canCreateGallery: boolean;
  offline: boolean;
  onCreateGallery: () => void;
  onCreateAlbum: () => void;
  onOpen: (album: Album) => void;
  onSignOut: () => void;
}) {
  const [recent] = useState<RecentAlbum[]>(recentAlbums);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState('');

  async function openPath(path: string) {
    setError('');
    setOpening(path.split(/[\\/]/).pop() ?? 'album');
    try {
      onOpen(await loadAlbum(path));
    } catch (e) {
      setError(String(e));
    } finally {
      setOpening('');
    }
  }

  async function chooseFile() {
    const path = await open({ title: 'Open an album', filters: ALBUM_FILTERS });
    if (typeof path === 'string') await openPath(path);
  }

  return (
    <main className="home">
      {opening && <LoaderScreen label={`Opening ${opening}…`} />}
      <header className="home-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">E</span>
          <div>
            <strong>Eventor</strong>
            <span>Album Designer</span>
          </div>
        </div>
        <span className="topbar-gap" />
        {offline && <span className="muted">Working offline</span>}
        {staff?.full_name && <span className="muted">{staff.full_name}</span>}
        {!offline && <button type="button" className="btn" onClick={onSignOut}><LogOutIcon aria-hidden="true" />Sign out</button>}
      </header>

      <section className="home-body">
        <h1>What would you like to do?</h1>
        <div className="home-cards">
          <button
            type="button"
            className="home-card"
            data-go="gallery"
            disabled={!canCreateGallery || offline}
            onClick={onCreateGallery}
          ><ImagesIcon aria-hidden="true" />
            <strong>Create gallery</strong>
            <span>
              {offline
                ? 'Needs an internet connection.'
                : canCreateGallery
                  ? 'Upload a shoot so your customer can select photos for the album.'
                  : 'Galleries are not part of your package.'}
            </span>
          </button>
          <button type="button" className="home-card primary" data-go="album" onClick={onCreateAlbum}><BookOpenIcon aria-hidden="true" />
            <strong>Create album</strong>
            <span>Design an album from a folder of photos, or from your customer&apos;s selection.</span>
          </button>
        </div>

        <div className="home-open">
          <div className="home-open-head">
            <h2 className="eyebrow">Recent albums</h2>
            <button type="button" className="btn" onClick={() => void chooseFile()}><FolderOpenIcon aria-hidden="true" />Open album…</button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
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
        </div>
      </section>
    </main>
  );
}
