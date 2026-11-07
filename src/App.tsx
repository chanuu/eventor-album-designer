import { useCallback, useEffect, useState } from 'react';
import type { PhotoInfo, ProjectSpec, Rating, Spread, PublishLink } from './api';
import CreateGallery from './CreateGallery';
import { checkAccess, OFFLINE_DAYS, signOut, type Access } from './eventor';
import EventorSignIn from './EventorSignIn';
import Home from './Home';
import NewAlbum from './NewAlbum';
import Workspace from './Workspace';

export type Album = {
  name: string;
  spec: ProjectSpec;
  sizeLabel: string;
  /** Where it is saved, or null if it never has been. */
  path: string | null;
  photos: PhotoInfo[];
  spreads: Spread[];
  /** Photos whose original file could not be found when the album was opened. */
  missing: string[];
  /** Ratings set by hand. */
  ratings: Record<string, Rating>;
  /** The Eventor job it has been published to, if any. */
  publish: PublishLink | null;
  /** Ask for a folder of photos as soon as the album opens. */
  importOnOpen?: boolean;
};

export default function App() {
  const [access, setAccess] = useState<Access | null>(null);
  const [album, setAlbum] = useState<Album | null>(null);
  const [screen, setScreen] = useState<'home' | 'album' | 'gallery'>('home');

  const check = useCallback(() => {
    setAccess(null);
    checkAccess().then(setAccess).catch((e) => {
      setAccess({ state: 'problem', message: e instanceof Error ? e.message : String(e) });
    });
  }, []);
  useEffect(check, [check]);

  if (album) return <Workspace album={album} />;
  if (!access) return <p className="center-note">Checking your account…</p>;

  if (access.state !== 'allowed') {
    return (
      <main className="gate">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">E</span>
          <div>
            <strong>Eventor</strong>
            <span>Album Designer</span>
          </div>
        </div>
        {access.state === 'signed-out' && <EventorSignIn onSignedIn={check} />}
        {access.state === 'not-in-package' && (
          <>
            <h1>Not part of your package</h1>
            <p className="muted">The album designer tool is not included in your Eventor package. Please contact Eventor to add it.</p>
          </>
        )}
        {access.state === 'offline-too-long' && (
          <>
            <h1>Please connect to the internet</h1>
            <p className="muted">The tool works offline for {OFFLINE_DAYS} days at a time, and needs to check your account again.</p>
          </>
        )}
        {access.state === 'problem' && (
          <>
            <h1>Your account could not be checked</h1>
            <p className="error" role="alert">{access.message}</p>
          </>
        )}
        {access.state !== 'signed-out' && (
          <div className="gate-actions">
            <button type="button" className="btn-primary" onClick={check}>Check again</button>
            {access.state === 'not-in-package' && (
              <button type="button" className="btn" onClick={() => void signOut().then(check)}>Sign out</button>
            )}
          </div>
        )}
      </main>
    );
  }

  if (screen === 'gallery' && access.staff) {
    return <CreateGallery staff={access.staff} onDone={() => setScreen('home')} />;
  }
  if (screen === 'album') {
    return <NewAlbum staff={access.offline ? null : access.staff} onCreate={setAlbum} onBack={() => setScreen('home')} />;
  }
  return (
    <Home
      staff={access.staff}
      canCreateGallery={access.canCreateGallery}
      offline={access.offline}
      onCreateGallery={() => setScreen('gallery')}
      onCreateAlbum={() => setScreen('album')}
      onOpen={setAlbum}
      onSignOut={() => void signOut().then(check)}
    />
  );
}
