import { CheckIcon, ChevronLeftIcon, EyeIcon, FolderOpenIcon, RefreshCwIcon, SquareIcon, UploadIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { rememberGalleryFolder } from './galleryFolders';
import Loader from './Loader';
import {
  analyzePhotos, checkForGallery, GRID_PREVIEW, importFolder, previewUrl, uploadGalleryPhoto, type PhotoInfo,
} from './api';
import {
  galleryUploadAddresses, listJobNames, openGalleryForSelection, recordGalleryPhotos, startGallery,
  type GalleryPhotoRow, type JobName, type Staff,
} from './eventor';

const BATCH = 20;
const TOGETHER = 3;

type Stage =
  | { name: 'job' }
  | { name: 'details'; job: JobName }
  | { name: 'uploading'; job: JobName; done: number; total: number }
  | { name: 'failed'; job: JobName; failed: PhotoInfo[]; done: number }
  | { name: 'finished'; job: JobName; count: number };

/** Uploads a shoot as a gallery, so the customer can select their photos in the portal. */
export default function CreateGallery({ staff, onDone }: { staff: Staff; onDone: () => void }) {
  const [stage, setStage] = useState<Stage>({ name: 'job' });
  const [jobs, setJobs] = useState<JobName[] | null>(null);
  const [search, setSearch] = useState('');
  const [title, setTitle] = useState('Photo selection');
  const [deadline, setDeadline] = useState('');
  const [photos, setPhotos] = useState<PhotoInfo[]>([]);
  const [folder, setFolder] = useState('');
  const [skipped, setSkipped] = useState(0);
  const [reading, setReading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [leftOut, setLeftOut] = useState<Map<string, string[]>>(new Map());
  const [putBack, setPutBack] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const gallery = useRef<string | null>(null);
  const nextOrder = useRef(0);
  const stopping = useRef(false);
  const recorded = useRef(new Set<string>());

  useEffect(() => {
    listJobNames(staff).then(setJobs).catch((e) => {
      setJobs([]);
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [staff]);

  async function chooseFolder() {
    const chosen = await open({ directory: true, title: 'Choose the folder of photos' });
    if (typeof chosen !== 'string') return;
    setReading(true);
    setError('');
    try {
      const scan = await importFolder(chosen);
      setFolder(chosen);
      setPhotos(scan.photos);
      setSkipped(scan.skipped.length);
      setLeftOut(new Map());
      setPutBack(new Set());
      setReading(false);
      setChecking(true);
      const ids = scan.photos.map((p) => p.id);
      await analyzePhotos(ids);
      const found = await checkForGallery(ids);
      setLeftOut(new Map(found.map((item) => [item.id, item.reasons])));
    } catch (e) {
      setError(`The photos could not all be checked, so none were left out: ${String(e)}`);
    } finally {
      setReading(false);
      setChecking(false);
    }
  }

  /** What goes to the customer. Anything left out stays on disk, and can be put back. */
  const chosen = photos.filter((p) => !leftOut.has(p.id) || putBack.has(p.id));
  const leftOutPhotos = photos.filter((p) => leftOut.has(p.id));
  const stillOut = leftOutPhotos.filter((p) => !putBack.has(p.id));

  /** Sends these photos in batches. Only what is recorded counts as done. */
  async function send(job: JobName, list: PhotoInfo[]) {
    let attempted = recorded.current.size;
    const total = attempted + list.length;
    setStage({ name: 'uploading', job, done: attempted, total });

    for (let at = 0; at < list.length && !stopping.current; at += BATCH) {
      const batch = list.slice(at, at + BATCH);
      // Asked for as they are needed, because an address only lasts minutes.
      const addresses = await galleryUploadAddresses(gallery.current!, batch.length);
      const sent: { id: string; row: GalleryPhotoRow }[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < batch.length) {
          const index = cursor++;
          const photo = batch[index];
          try {
            const hash = await uploadGalleryPhoto(photo, addresses[index].full.uploadUrl, addresses[index].thumb.uploadUrl);
            sent.push({
              id: photo.id,
              row: {
                url: addresses[index].full.publicUrl,
                thumbUrl: addresses[index].thumb.publicUrl,
                fileName: photo.file_name,
                hash,
                order: nextOrder.current + index,
              },
            });
          } catch {
            // Still not recorded, so it is offered again at the end.
          }
          attempted += 1;
          setStage({ name: 'uploading', job, done: attempted, total });
        }
      };
      await Promise.all(Array.from({ length: TOGETHER }, worker));
      nextOrder.current += batch.length;
      if (sent.length) {
        await recordGalleryPhotos(staff, gallery.current!, sent.map((s) => s.row));
        for (const s of sent) recorded.current.add(s.id);
      }
    }
  }

  async function run(job: JobName, list: PhotoInfo[]) {
    setError('');
    stopping.current = false;
    const left = () => list.filter((p) => !recorded.current.has(p.id));
    try {
      if (!gallery.current) {
        gallery.current = await startGallery(job.id, title.trim() || 'Photo selection', deadline);
        // So that Customer selection can find the originals again without asking.
        rememberGalleryFolder(gallery.current, folder);
      }
      await send(job, list);
      if (stopping.current) setError('Stopped. Your customer cannot see this gallery until it is finished.');
      if (left().length) {
        setStage({ name: 'failed', job, failed: left(), done: recorded.current.size });
      } else {
        await openGalleryForSelection(gallery.current);
        setStage({ name: 'finished', job, count: recorded.current.size });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage(gallery.current ? { name: 'failed', job, failed: left(), done: recorded.current.size } : { name: 'details', job });
    }
  }

  async function finishWithout(job: JobName, done: number) {
    setError('');
    try {
      await openGalleryForSelection(gallery.current!);
      setStage({ name: 'finished', job, count: done });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const query = search.trim().toLowerCase();
  const shown = (jobs ?? []).filter((j) => !query || `${j.title} ${j.clientName}`.toLowerCase().includes(query));

  return (
    <main className="home">
      <header className="home-head">
        {(stage.name === 'job' || stage.name === 'details') && (
          <button
            type="button"
            className="btn"
            onClick={() => (stage.name === 'details' ? setStage({ name: 'job' }) : onDone())}
          ><ChevronLeftIcon aria-hidden="true" />Back</button>
        )}
        <div className="title"><strong>Create gallery</strong><span>For your customer to select album photos</span></div>
      </header>

      <section className="flow-body">
        {error && <p className="error" role="alert">{error}</p>}

        {stage.name === 'job' && (
          <>
            <h1>Which job is this for?</h1>
            {jobs === null && <Loader label="Loading your jobs…" />}
            {jobs !== null && (
              <>
                <input
                  className="job-search"
                  aria-label="Search jobs"
                  placeholder="Search by job or client"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="job-list" role="list">
                  {shown.map((job) => (
                    <button key={job.id} type="button" className="job-row" onClick={() => setStage({ name: 'details', job })}>
                      <strong>{job.title}</strong>
                      <span>{job.clientName}</span>
                    </button>
                  ))}
                  {shown.length === 0 && !error && <p className="muted">No jobs found.</p>}
                </div>
              </>
            )}
          </>
        )}

        {stage.name === 'details' && (
          <>
            <h1>{stage.job.title}</h1>
            <p className="muted">{stage.job.clientName}</p>
            <label className="field">
              Gallery name
              <input className="input" aria-label="Gallery name" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              Selection deadline (optional)
              <input className="input" type="date" aria-label="Selection deadline" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
            <div className="flow-row">
              <button type="button" className="btn" disabled={reading} onClick={() => void chooseFolder()}><FolderOpenIcon aria-hidden="true" />
                {reading ? 'Reading photos…' : folder ? 'Choose another folder' : 'Choose photo folder'}
              </button>
              {folder && (
                <span className="muted" role="status">
                  {photos.length} photo{photos.length === 1 ? '' : 's'} found
                  {skipped ? `, ${skipped} could not be read` : ''}
                </span>
              )}
            </div>
            {checking && <Loader label="Checking photo quality…" />}
            {!checking && folder && leftOutPhotos.length > 0 && (
              <section className="quality-review" aria-label="Photos left out">
                <h2>{stillOut.length} left out of the gallery</h2>
                <p className="muted">
                  These look overexposed, blurry, too dark or too small, or someone has their eyes closed. Check them, and click any good photo to put it back.
                  Nothing is deleted from your computer.
                </p>
                <div className="left-out quality-grid">
                  {leftOutPhotos.map((photo) => {
                    const back = putBack.has(photo.id);
                    return (
                      <button
                        key={photo.id}
                        type="button"
                        aria-pressed={back}
                        className={`left-out-item ${back ? 'put-back' : ''}`}
                        title={photo.file_name}
                        onClick={() => {
                          const next = new Set(putBack);
                          if (back) next.delete(photo.id);
                          else next.add(photo.id);
                          setPutBack(next);
                        }}
                      >
                        <img src={previewUrl(photo.id, GRID_PREVIEW)} alt={photo.file_name} loading="lazy" draggable={false} />
                        <span className="why">{leftOut.get(photo.id)!.join(', ')}</span>
                        <span className="restore">{back ? 'Will be included' : 'Put back'}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
            <p className="muted">Smaller copies are uploaded. Your originals stay on this computer and are not changed.</p>
            <div className="flow-actions">
              <button type="button" className="btn-primary" disabled={!chosen.length || reading || checking} onClick={() => void run(stage.job, chosen)}>
                <UploadIcon aria-hidden="true" />Upload {chosen.length || ''} photo{chosen.length === 1 ? '' : 's'} and open for selection
              </button>
            </div>
          </>
        )}

        {stage.name === 'uploading' && (
          <>
            <h1>Uploading {stage.done} of {stage.total}</h1>
            <progress value={stage.done} max={stage.total} aria-label="Upload progress" />
            <p className="muted">Your customer will see the gallery once every photo is up.</p>
            <div className="flow-actions">
              <button type="button" className="btn" onClick={() => { stopping.current = true; }}><SquareIcon aria-hidden="true" />Stop</button>
            </div>
          </>
        )}

        {stage.name === 'failed' && (
          <>
            <h1>{stage.failed.length} photo{stage.failed.length === 1 ? '' : 's'} not uploaded</h1>
            <p className="muted">{stage.done} uploaded so far. Your customer cannot see this gallery yet.</p>
            <ul className="name-list">
              {stage.failed.slice(0, 8).map((p) => <li key={p.id}>{p.file_name}</li>)}
              {stage.failed.length > 8 && <li>and {stage.failed.length - 8} more</li>}
            </ul>
            <div className="flow-actions">
              {stage.done > 0 && (
                <button type="button" className="btn" onClick={() => void finishWithout(stage.job, stage.done)}><EyeIcon aria-hidden="true" />
                  Open without them
                </button>
              )}
              <button type="button" className="btn-primary" onClick={() => void run(stage.job, stage.failed)}><RefreshCwIcon aria-hidden="true" />
                Try again
              </button>
            </div>
          </>
        )}

        {stage.name === 'finished' && (
          <>
            <h1>The gallery is ready</h1>
            <p role="status">
              {stage.count} photo{stage.count === 1 ? '' : 's'} uploaded for {stage.job.clientName}. They can now select
              their photos in the portal. When they have, choose Create album and then Customer selection.
            </p>
            <div className="flow-actions">
              <button type="button" className="btn-primary" onClick={onDone}><CheckIcon aria-hidden="true" />Done</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
