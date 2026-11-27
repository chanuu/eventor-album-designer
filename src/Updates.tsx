import { Channel, invoke } from '@tauri-apps/api/core';
import { DownloadIcon, RefreshCwIcon, SparklesIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

type Offer = { version: string; current: string; notes: string };

/** How long after a check the app looks again, when it is left on the first screen. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const check = () => invoke<Offer | null>('check_for_update');

// Screens come and go, but an offer put off stays put off until the app is next started.
let putOff = '';
let known: Offer | null = null;
let lastChecked = 0;

/**
 * Offers a newer version, and shows which one this is. Only for screens with no album
 * open, since installing closes the app.
 */
export default function Updates() {
  const [version, setVersion] = useState('');
  const [offer, setOffer] = useState<Offer | null>(known);
  const [later, setLater] = useState(putOff);
  const [checking, setChecking] = useState(false);
  const [said, setSaid] = useState('');
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);

  async function look(asked: boolean) {
    setChecking(asked);
    if (asked) setSaid('');
    try {
      known = await check();
      lastChecked = Date.now();
      setOffer(known);
      if (asked) {
        putOff = '';
        setLater('');
        if (!known) setSaid('This is the newest version.');
      }
    } catch {
      // Being offline is normal, so only someone who asked is told.
      if (asked) setSaid('Could not check for updates. Please check your internet connection.');
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    invoke<string>('app_version').then(setVersion).catch(() => {});
    const lookIfDue = () => { if (Date.now() - lastChecked >= CHECK_EVERY_MS) void look(false); };
    lookIfDue();
    const timer = setInterval(lookIfDue, CHECK_EVERY_MS / 6);
    return () => clearInterval(timer);
  }, []);

  async function install() {
    setSaid('');
    setProgress(0);
    setInstalling(true);
    try {
      const channel = new Channel<number>();
      channel.onmessage = setProgress;
      await invoke('install_update', { progress: channel });
    } catch (e) {
      setInstalling(false);
      setSaid(`The update was not installed. Nothing has changed. (${String(e)})`);
    }
  }

  const shown = offer && offer.version !== later ? offer : null;
  return (
    <section className="updates" aria-label="Updates">
      {shown && (
        <div className="update-offer">
          <SparklesIcon aria-hidden="true" />
          <div>
            <strong>Version {shown.version} is ready</strong>
            {shown.notes && <p className="update-notes">{shown.notes}</p>}
            <p className="muted">The app closes while it updates, then opens again. Your albums stay as they are.</p>
          </div>
          <div className="update-actions">
            <button type="button" className="btn-primary" onClick={() => void install()}><DownloadIcon aria-hidden="true" />Update now</button>
            <button type="button" className="btn" onClick={() => { putOff = shown.version; setLater(shown.version); }}>Later</button>
          </div>
        </div>
      )}
      <div className="update-foot">
        {version && <span className="muted">Version {version}</span>}
        <button type="button" className="btn" disabled={checking || installing} onClick={() => void look(true)}><RefreshCwIcon aria-hidden="true" />{checking ? 'Checking…' : 'Check for updates'}</button>
        {said && <span role="status" className="muted">{said}</span>}
      </div>
      {installing && (
        <div className="update-busy" role="dialog" aria-modal="true" aria-label="Updating">
          <div>
            <strong>Updating to version {offer?.version}</strong>
            <progress max={100} value={progress} />
            <p className="muted">{progress < 100 ? `Downloading… ${progress}%` : 'Installing. The app will open again by itself.'}</p>
          </div>
        </div>
      )}
    </section>
  );
}
