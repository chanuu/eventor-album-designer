import { ChevronLeftIcon, ChevronRightIcon, MusicIcon, PaletteIcon, PauseIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { readMusic, type Cover, type Music, type PhotoInfo, type ProjectSpec, type Spread } from './api';
import FlipBook from './FlipBook';

/** The album as the client will see it: a book to open and leaf through, with its music. */
export default function AlbumPreview({
  title, spec, spreads, photos, cover, music, onDesignCover, onClose,
}: {
  title: string;
  spec: ProjectSpec;
  spreads: Spread[];
  photos: PhotoInfo[];
  cover: Cover | null;
  music: Music | null;
  onDesignCover: () => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState(0);
  const [track, setTrack] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [musicError, setMusicError] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const last = spreads.length + 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = e.key === 'ArrowRight' || e.key === ' ' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (e.key !== 'Escape' && !step) return;
      // The album behind has its own shortcuts, which must not act while this is open.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') onClose();
      else setAt((was) => Math.max(0, Math.min(last, was + step)));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [last, onClose]);

  useEffect(() => {
    if (!music) return undefined;
    let current = true;
    let url: string | null = null;
    readMusic(music.path)
      .then((file) => {
        if (!current) return;
        url = URL.createObjectURL(file);
        setTrack(url);
      })
      .catch((e) => setMusicError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [music]);

  // It starts by itself, as it does for the client, when the computer allows that.
  useEffect(() => {
    if (track) audio.current?.play().catch(() => setPlaying(false));
  }, [track]);

  const toggleMusic = () => {
    const player = audio.current;
    if (!player) return;
    if (player.paused) void player.play().catch(() => setMusicError('This track could not be played here.'));
    else player.pause();
  };

  const where = at === 0
    ? 'Cover'
    : at === last
      ? 'Back cover'
      : `Spread ${at} of ${spreads.length}`;

  return (
    <div className="preview" role="dialog" aria-modal="true" aria-label="Album preview">
      <header className="preview-bar">
        <div className="title">
          <strong>{title}</strong>
          <span>As your client will see it</span>
        </div>
        <span className="topbar-gap" />
        {music && (
          <button
            type="button"
            className={`btn ${playing ? 'active' : ''}`}
            disabled={!track}
            aria-pressed={playing}
            title={musicError || music.name}
            onClick={toggleMusic}
          >
            {playing ? <PauseIcon aria-hidden="true" /> : <MusicIcon aria-hidden="true" />}
            {playing ? 'Pause music' : 'Play music'}
          </button>
        )}
        <button type="button" className="btn" onClick={onDesignCover}><PaletteIcon aria-hidden="true" />{cover ? 'Edit cover' : 'Design a cover'}</button>
        <button type="button" className="btn" onClick={onClose}><XIcon aria-hidden="true" />Close</button>
      </header>

      <FlipBook spec={spec} spreads={spreads} photos={photos} cover={cover} title={title} at={at} onAt={setAt} />

      <footer className="preview-foot">
        <button type="button" className="btn icon-btn" aria-label="Previous page" disabled={at === 0} onClick={() => setAt(at - 1)}><ChevronLeftIcon aria-hidden="true" /></button>
        <span className="preview-where" role="status">{where}</span>
        <button type="button" className="btn icon-btn" aria-label="Next page" disabled={at === last} onClick={() => setAt(at + 1)}><ChevronRightIcon aria-hidden="true" /></button>
      </footer>

      {track && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio ref={audio} src={track} loop onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
      )}
    </div>
  );
}
