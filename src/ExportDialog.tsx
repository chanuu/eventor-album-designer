import { CheckIcon, DownloadIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  checkForExport,
  exportPrintFiles,
  type ExportIssue,
  type ExportResult,
  type Project,
} from './api';

type Stage =
  | { name: 'checking' }
  | { name: 'ready' }
  | { name: 'exporting'; done: number; total: number }
  | { name: 'finished'; result: ExportResult };

const MM_PER_INCH = 25.4;

export default function ExportDialog({
  project, onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ name: 'checking' });
  const [issues, setIssues] = useState<ExportIssue[]>([]);
  const [jpeg, setJpeg] = useState(true);
  const [pdf, setPdf] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let current = true;
    checkForExport(project)
      .then((found) => {
        if (!current) return;
        setIssues(found);
        setStage({ name: 'ready' });
      })
      .catch((e) => {
        if (!current) return;
        setError(String(e));
        setStage({ name: 'ready' });
      });
    return () => { current = false; };
  }, [project]);

  const exporting = stage.name === 'exporting';

  useEffect(() => {
    if (exporting) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exporting, onClose]);

  const blockers = issues.filter((i) => i.severity === 'blocker');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const { spec } = project;
  const pixels = (mm: number) => Math.round((mm / MM_PER_INCH) * spec.target_dpi);
  const width = pixels(spec.trim_w_mm * 2 + spec.bleed_mm * 2);
  const height = pixels(spec.trim_h_mm + spec.bleed_mm * 2);

  async function start() {
    setError('');
    const folder = await open({ directory: true, title: 'Choose where to save the print files' });
    if (typeof folder !== 'string') return;

    const total = project.spreads.length;
    setStage({ name: 'exporting', done: 0, total });
    const stop = await listen<[number, number]>('export-progress', (event) => {
      setStage({ name: 'exporting', done: event.payload[0], total: event.payload[1] });
    });
    try {
      const result = await exportPrintFiles(project, folder, { jpeg, pdf });
      setStage({ name: 'finished', result });
    } catch (e) {
      setError(String(e));
      setStage({ name: 'ready' });
    } finally {
      stop();
    }
  }

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Export">
      <div className="modal">
        <h2>Export for print</h2>

        {stage.name === 'finished' ? (
          <>
            <p className="export-done" role="status">
              Exported {stage.result.files.length} file{stage.result.files.length === 1 ? '' : 's'}.
            </p>
            <p className="muted">Saved in</p>
            <p className="export-path">{stage.result.folder}</p>
            <div className="modal-actions">
              <button type="button" className="btn-primary" onClick={onClose}><CheckIcon aria-hidden="true" />Done</button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              {project.spreads.length} spread{project.spreads.length === 1 ? '' : 's'} · {width} × {height} px
              at {spec.target_dpi} DPI · {spec.bleed_mm} mm bleed
            </p>

            <div className="export-formats">
              <label className="toggle">
                <input type="checkbox" checked={jpeg} disabled={exporting} onChange={(e) => setJpeg(e.target.checked)} />
                JPG for each spread
              </label>
              <label className="toggle">
                <input type="checkbox" checked={pdf} disabled={exporting} onChange={(e) => setPdf(e.target.checked)} />
                One PDF
              </label>
            </div>

            {stage.name === 'checking' && <p className="muted">Checking the album…</p>}

            {stage.name !== 'checking' && !issues.length && !error && (
              <p className="export-clear">No print problems found.</p>
            )}

            {blockers.length > 0 && (
              <IssueList title="Fix these before exporting" items={blockers} className="error" />
            )}
            {warnings.length > 0 && (
              <IssueList title="Worth checking" items={warnings} className="warn" />
            )}

            {exporting && (
              <div className="export-progress" role="status">
                <progress value={stage.done} max={stage.total} />
                <span>Rendered {stage.done} of {stage.total} spreads from the originals…</span>
              </div>
            )}

            {error && <p className="error">{error}</p>}

            <div className="modal-actions">
              <button type="button" className="btn" disabled={exporting} onClick={onClose}><XIcon aria-hidden="true" />Cancel</button>
              <button
                type="button"
                className="btn-primary"
                disabled={stage.name !== 'ready' || blockers.length > 0 || (!jpeg && !pdf)}
                onClick={() => void start()}
              ><DownloadIcon aria-hidden="true" />
                {exporting ? 'Exporting…' : 'Choose folder and export'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function IssueList({
  title, items, className,
}: {
  title: string;
  items: ExportIssue[];
  className: string;
}) {
  return (
    <section className="issues">
      <h3 className={className}>{title}</h3>
      <ul>
        {items.map((issue, i) => (
          <li key={i}>
            {issue.spread !== null && <strong>Spread {issue.spread}: </strong>}
            {issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
