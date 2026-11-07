import { useEffect, useMemo, useState } from 'react';
import { checkForExport, type Project, type PublishLink } from './api';
import { currentStaff, listJobs, publishAlbum, signOut, type EventorJob, type Staff } from './eventor';
import EventorSignIn from './EventorSignIn';

type Stage =
  | { name: 'loading' }
  | { name: 'signin' }
  | { name: 'choose' }
  | { name: 'confirm'; job: EventorJob }
  | { name: 'publishing'; job: EventorJob; done: number; total: number }
  | { name: 'finished'; job: EventorJob };

/** Publishes this album as the digital album of a job in Eventor. */
export default function PublishDialog({
  project, link, onPublished, onClose,
}: {
  project: Project;
  link: PublishLink | null;
  onPublished: (link: PublishLink) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ name: 'loading' });
  const [staff, setStaff] = useState<Staff | null>(null);
  const [jobs, setJobs] = useState<EventorJob[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const spreadIds = useMemo(() => project.spreads.map((s) => s.id), [project]);

  async function loadJobs(who: Staff) {
    setStaff(who);
    setStage({ name: 'loading' });
    setError('');
    try {
      const issues = await checkForExport(project);
      const blocker = issues.find((i) => i.severity === 'blocker');
      if (blocker) throw new Error(`${blocker.message} Fix this before publishing.`);
      const found = await listJobs(who, spreadIds);
      setJobs(found);
      // An album that has been published before goes back to the same job.
      const linked = link && found.find((j) => j.id === link.job_id);
      setStage(linked ? { name: 'confirm', job: linked } : { name: 'choose' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage({ name: 'choose' });
    }
  }

  useEffect(() => {
    currentStaff()
      .then((who) => {
        if (who) void loadJobs(who);
        else setStage({ name: 'signin' });
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setStage({ name: 'signin' });
      });
    // Runs when the dialog opens, for the album as it was then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function publish(job: EventorJob) {
    if (!staff) return;
    setError('');
    setStage({ name: 'publishing', job, done: 0, total: project.spreads.length });
    try {
      const made = await publishAlbum(staff, job, project, (done, total) => {
        setStage({ name: 'publishing', job, done, total });
      });
      onPublished(made);
      setStage({ name: 'finished', job });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage({ name: 'confirm', job });
    }
  }

  const query = search.trim().toLowerCase();
  const shown = jobs.filter((j) => !query || `${j.title} ${j.clientName}`.toLowerCase().includes(query));
  const busy = stage.name === 'publishing';

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Publish to Eventor">
      <div className="modal">
        <h2>Publish to Eventor</h2>

        {stage.name === 'loading' && <p className="muted">Checking…</p>}

        {stage.name === 'signin' && (
          <>
            {error && <p className="error" role="alert">{error}</p>}
            <EventorSignIn onSignedIn={(who) => void loadJobs(who)} />
          </>
        )}

        {stage.name === 'choose' && (
          <>
            <p className="muted">Choose the job this album belongs to. Its client will see the album in their portal.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <input
              className="job-search"
              aria-label="Search jobs"
              placeholder="Search by job or client"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="job-list" role="list">
              {shown.map((job) => (
                <button key={job.id} type="button" className="job-row" onClick={() => { setError(''); setStage({ name: 'confirm', job }); }}>
                  <strong>{job.title}</strong>
                  <span>{job.clientName}{job.pageCount ? ` · has an album of ${job.pageCount} pages` : ''}</span>
                </button>
              ))}
              {shown.length === 0 && !error && <p className="muted">No jobs found.</p>}
            </div>
          </>
        )}

        {(stage.name === 'confirm' || stage.name === 'publishing') && (
          <>
            <p>
              <strong>{stage.job.title}</strong>
              <span className="muted"> · {stage.job.clientName}</span>
            </p>
            <p className="muted">
              {project.spreads.length} spread{project.spreads.length === 1 ? '' : 's'} will be published, cropped to
              the printed size and made smaller for the web. Your client will see them in their portal straight away.
            </p>
            {stage.job.pagesToReplace > 0 && (
              <p className="warn" role="alert">
                This job already has an album, and {stage.job.pagesToReplace} of its page
                {stage.job.pagesToReplace === 1 ? '' : 's'} will be replaced. Its share link and settings stay the same.
              </p>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            {stage.name === 'publishing' && (
              <p role="status">Uploading spread {Math.min(stage.done + 1, stage.total)} of {stage.total}…</p>
            )}
          </>
        )}

        {stage.name === 'finished' && (
          <p className="publish-done" role="status">
            Published to <strong>{stage.job.title}</strong>. {stage.job.clientName} can now see it in their portal,
            and their comments will appear here under Comments.
          </p>
        )}

        <div className="modal-actions">
          {stage.name === 'choose' && staff && (
            <button
              type="button"
              className="btn"
              onClick={() => void signOut().then(() => { setStaff(null); setStage({ name: 'signin' }); })}
            >
              Sign out
            </button>
          )}
          {stage.name === 'confirm' && (
            <button type="button" className="btn" onClick={() => { setError(''); setStage({ name: 'choose' }); }}>Choose another job</button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {stage.name === 'finished' ? 'Done' : 'Cancel'}
          </button>
          {(stage.name === 'confirm' || stage.name === 'publishing') && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => stage.name === 'confirm' && void publish(stage.job)}>
              {stage.job.pagesToReplace > 0 ? 'Replace and publish' : 'Publish'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
