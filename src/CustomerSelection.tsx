import { ArrowRightIcon, ChevronLeftIcon, FolderOpenIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { matchCustomerSelection, type PhotoInfo, type PublishLink, type SelectionMatch } from './api';
import { listJobNames, selectedPhotos, type JobGallery, type JobName, type SelectedPhoto, type Staff } from './eventor';
import { galleryFolder, rememberGalleryFolder } from './galleryFolders';
import Loader from './Loader';

type Chosen = { job: JobName; gallery: JobGallery; wanted: SelectedPhoto[] };

/** Starts an album from what the customer selected, using the originals on this computer. */
export default function CustomerSelection({
  staff, onCancel, onReady,
}: {
  staff: Staff;
  onCancel: () => void;
  onReady: (photos: PhotoInfo[], link: PublishLink) => void;
}) {
  const [jobs, setJobs] = useState<JobName[] | null>(null);
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [report, setReport] = useState<SelectionMatch | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Where the photos were looked for, and what to tell the photographer about it. */
  const [searchedIn, setSearchedIn] = useState('');
  const [folderNote, setFolderNote] = useState('');

  useEffect(() => {
    listJobNames(staff).then(setJobs).catch((e) => {
      setJobs([]);
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [staff]);

  async function pickGallery(job: JobName, gallery: JobGallery) {
    setBusy(true);
    setError('');
    try {
      const wanted = await selectedPhotos(gallery.id);
      if (!wanted.length) {
        setError(`${job.clientName} has not selected any photos in “${gallery.title}” yet.`);
        return;
      }
      const next = { job, gallery, wanted };
      setChosen(next);
      setReport(null);
      setFolderNote('');
      // A gallery uploaded from this computer remembers its folder, so there is nothing to ask.
      const saved = galleryFolder(gallery.id);
      if (saved) await findIn(next, saved, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Looks for the selected photos in a folder. Looking by itself in the remembered folder,
   * a folder that has gone or holds none of them means asking for the folder instead.
   */
  async function findIn(target: Chosen, folder: string, automatic: boolean) {
    setBusy(true);
    setError('');
    setFolderNote('');
    setPicks({});
    try {
      const found = await matchCustomerSelection(folder, target.wanted);
      const usable = found.photos.length + found.ambiguous.length;
      if (automatic && usable === 0) {
        setReport(null);
        setFolderNote(`None of the selected photos are in ${folder} any more. The folder may have been moved or renamed. Choose the folder where they are now.`);
        return;
      }
      setReport(found);
      setSearchedIn(folder);
      if (!automatic && usable > 0) rememberGalleryFolder(target.gallery.id, folder);
      if (automatic && found.missing.length) {
        setFolderNote(`Some photos are no longer in ${folder}. If they have been moved, choose the folder where they are now.`);
      }
    } catch (e) {
      if (automatic) {
        setReport(null);
        setFolderNote(`The folder this gallery was uploaded from, ${folder}, cannot be found. It may have been moved or renamed, or be on a drive that is not connected. Choose the folder where the photos are now.`);
      } else {
        setError(`Could not read that folder: ${String(e)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function chooseFolder() {
    if (!chosen) return;
    const folder = await open({ directory: true, title: 'Choose the folder with the original photos' });
    if (typeof folder !== 'string') return;
    await findIn(chosen, folder, false);
  }

  function finish() {
    if (!chosen || !report) return;
    const extra = report.ambiguous.flatMap((a) => {
      const photo = a.options.find((o) => o.id === picks[a.file_name]);
      return photo ? [photo] : [];
    });
    const known = new Set(report.photos.map((p) => p.id));
    onReady(
      [...report.photos, ...extra.filter((p) => !known.has(p.id))],
      // Not published yet, but it will go to this job when it is.
      { job_id: chosen.job.id, job_title: chosen.job.title, album_id: '' },
    );
  }

  if (chosen) {
    const unanswered = report ? report.ambiguous.filter((a) => !picks[a.file_name]).length : 0;
    const found = report ? report.photos.length + report.ambiguous.length - unanswered : 0;
    return (
      <div className="selection">
        <h2>{chosen.gallery.title}</h2>
        <p className="muted">{chosen.job.title} · {chosen.job.clientName} · {chosen.wanted.length} photos selected</p>
        {!chosen.gallery.selection_submitted_at && (
          <p className="warn" role="alert">{chosen.job.clientName} has not finished selecting yet, so this may still change.</p>
        )}
        {error && <p className="error" role="alert">{error}</p>}

        {folderNote && (
          <p className="folder-note" role="alert">{folderNote}</p>
        )}
        {busy && !report && <Loader label="Finding your customer's photos…" />}
        {!report && !busy && !folderNote && (
          <p className="muted">Choose the folder that holds the original photos of this shoot. It is remembered for next time.</p>
        )}

        {report && (
          <div className="selection-report" role="status">
            <strong>{found} of {chosen.wanted.length} photos found</strong>
            <span className="muted folder-path" title={searchedIn}>In {searchedIn}</span>
            {report.changed.length > 0 && (
              <p className="muted">
                {report.changed.length} {report.changed.length === 1 ? 'has' : 'have'} changed since the gallery was uploaded,
                probably from editing, and will be used as they are now: {report.changed.slice(0, 5).join(', ')}.
              </p>
            )}
            {report.missing.length > 0 && (
              <>
                <p className="warn">{report.missing.length} could not be found in this folder:</p>
                <ul className="name-list">
                  {report.missing.slice(0, 8).map((n) => <li key={n}>{n}</li>)}
                  {report.missing.length > 8 && <li>and {report.missing.length - 8} more</li>}
                </ul>
              </>
            )}
            {report.ambiguous.map((a) => (
              <fieldset key={a.file_name} className="pick-file">
                <legend>More than one {a.file_name}. Which did the customer select?</legend>
                {a.options.map((option) => (
                  <label key={option.id}>
                    <input
                      type="radio"
                      name={a.file_name}
                      checked={picks[a.file_name] === option.id}
                      onChange={() => setPicks({ ...picks, [a.file_name]: option.id })}
                    />
                    <span title={option.path}>{option.path}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        )}

        <div className="flow-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => { setChosen(null); setReport(null); setError(''); setFolderNote(''); }}><ChevronLeftIcon aria-hidden="true" />Back</button>
          <button type="button" className={report ? 'btn' : 'btn-primary'} disabled={busy} onClick={() => void chooseFolder()}><FolderOpenIcon aria-hidden="true" />
            {busy ? 'Finding photos…' : report ? 'Choose another folder' : 'Choose photo folder'}
          </button>
          {report && (
            <button type="button" className="btn-primary" disabled={busy || found === 0 || unanswered > 0} onClick={finish}><ArrowRightIcon aria-hidden="true" />
              {unanswered > 0 ? `Answer ${unanswered} more` : `Continue with ${found} photo${found === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const shown = (jobs ?? [])
    .filter((j) => j.galleries.length > 0)
    .filter((j) => !query || `${j.title} ${j.clientName}`.toLowerCase().includes(query));

  return (
    <div className="selection">
      <h2>Which customer selection?</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {jobs === null && <Loader label="Loading your galleries…" />}
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
            {shown.flatMap((job) => job.galleries.map((gallery) => (
              <button key={gallery.id} type="button" className="job-row" disabled={busy} onClick={() => void pickGallery(job, gallery)}>
                <strong>{job.title} · {gallery.title}</strong>
                <span>{job.clientName} · {gallery.selection_submitted_at ? 'Selection sent' : 'Still selecting'}</span>
              </button>
            )))}
            {shown.length === 0 && !error && <p className="muted">No galleries yet. Choose Create gallery on the first screen to make one.</p>}
          </div>
        </>
      )}
      <div className="flow-actions">
        <button type="button" className="btn" onClick={onCancel}><ChevronLeftIcon aria-hidden="true" />Back</button>
      </div>
    </div>
  );
}
