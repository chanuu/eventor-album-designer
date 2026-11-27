import { LaptopIcon, MonitorIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { removeDevice, type DesignerDevice } from './eventor';

type Props = {
  used: number;
  limit: number;
  devices: DesignerDevice[];
  canRemove: boolean;
  /** Check again, which registers this computer now that there is room. */
  onFreed: () => void;
};

const PLATFORM: Record<string, string> = { windows: 'Windows', macos: 'Mac', linux: 'Linux' };

function lastUsed(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days < 1) return 'Used today';
  if (days === 1) return 'Used yesterday';
  return `Used ${days} days ago`;
}

/** The studio's plan allows no more computers. Shows which ones hold the places. */
export default function DeviceLimit({ used, limit, devices, canRemove, onFreed }: Props) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState('');

  const remove = async (device: DesignerDevice) => {
    const label = device.name ?? 'this computer';
    if (!window.confirm(`Remove ${label}? It will need a free place to use the album designer again.`)) return;
    setRemoving(device.id);
    setError('');
    try {
      await removeDevice(device.id);
      onFreed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRemoving(null);
    }
  };

  return (
    <>
      <h1>No computers left on your plan</h1>
      <p className="muted">
        {limit === 0
          ? 'Your Eventor plan does not include the album designer on any computer. Please contact Eventor to change your plan.'
          : `Your Eventor plan allows the album designer on ${limit} ${limit === 1 ? 'computer' : 'computers'}, and ${used} ${used === 1 ? 'is' : 'are'} already using it. `}
        {limit > 0 &&
          (canRemove
            ? 'Remove one you no longer use to use this computer instead, or contact Eventor for a plan with more.'
            : 'Ask someone who can manage your studio settings to remove one, or contact Eventor for a plan with more.')}
      </p>
      {devices.length > 0 && (
        <ul className="device-list" aria-label="Computers using the album designer">
          {devices.map((d) => (
            <li key={d.id}>
              {d.platform === 'macos' ? <LaptopIcon aria-hidden="true" /> : <MonitorIcon aria-hidden="true" />}
              <div>
                <strong>{d.name ?? 'Unnamed computer'}</strong>
                <span className="muted">
                  {[PLATFORM[d.platform ?? ''] ?? d.platform, lastUsed(d.last_seen)].filter(Boolean).join(' · ')}
                </span>
              </div>
              {canRemove && (
                <button
                  type="button"
                  className="btn"
                  disabled={removing !== null}
                  onClick={() => void remove(d)}
                >
                  <Trash2Icon aria-hidden="true" />
                  {removing === d.id ? 'Removing…' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
