import { ArrowRightIcon, ChevronLeftIcon, FolderOpenIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { matchCustomerSelection, type PhotoInfo, type PublishLink, type SelectionMatch } from './api';
import { listJobNames, selectedPhotos, type JobGallery, type JobName, type SelectedPhoto, type Staff } from './eventor';

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
      setChosen({ job, gallery, wanted });
      setReport(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseFolder() {
    if (!chosen) return;
    const folder = await open({ directory: true, title: 'Choose the folder with the original photos' });
    if (typeof folder !== 'string') return;
    setBusy(true);
    setError('');
    try {
      setPicks({});
      setReport(await matchCustomerSelection(folder, chosen.wanted));
    } catch (e) {
      setError(`Could not read that folder: ${String(e)}`);
    } finally {
      setBusy(false);
    }
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

        {!report && <p className="muted">Choose the folder that holds the original photos of this shoot.</p>}

        {report && (
          <div className="selection-report" role="status">
            <strong>{found} of {chosen.wanted.length} photos found</strong>
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
          <button type="button" className="btn" disabled={busy} onClick={() => { setChosen(null); setReport(null); setError(''); }}><ChevronLeftIcon aria-hidden="true" />Back</button>
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
      {jobs === null && <p className="muted">Loading your galleries…</p>}
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
