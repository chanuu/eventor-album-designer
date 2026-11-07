import { useEffect, useState } from 'react';
import type { PublishLink } from './api';
import { currentStaff, listComments, setCommentResolved, type ClientComment, type Staff } from './eventor';
import EventorSignIn from './EventorSignIn';

const when = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** What clients said about the published album, for the studio to act on and resolve. */
export default function CommentsDialog({
  link, spreadIds, onOpenCount, onGoToSpread, onClose,
}: {
  link: PublishLink;
  spreadIds: string[];
  onOpenCount: (count: number) => void;
  onGoToSpread: (id: string) => void;
  onClose: () => void;
}) {
  const [staff, setStaff] = useState<Staff | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [comments, setComments] = useState<ClientComment[] | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function load(who: Staff) {
    setStaff(who);
    setNeedsSignIn(false);
    setError('');
    try {
      const found = await listComments(link.album_id, who);
      setComments(found);
      onOpenCount(found.filter((c) => !c.resolved_at).length);
    } catch (e) {
      setComments([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    currentStaff()
      .then((who) => {
        if (who) void load(who);
        else setNeedsSignIn(true);
      })
      .catch((e) => {
        setNeedsSignIn(true);
        setError(e instanceof Error ? e.message : String(e));
      });
    // Runs when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function change(comment: ClientComment, resolved: boolean) {
    if (!staff) return;
    setBusyId(comment.id);
    setError('');
    try {
      const resolvedAt = await setCommentResolved(staff, comment.id, resolved);
      const next = (comments ?? []).map((c) => (c.id === comment.id ? { ...c, resolved_at: resolvedAt } : c));
      setComments(next);
      onOpenCount(next.filter((c) => !c.resolved_at).length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  const open = (comments ?? []).filter((c) => !c.resolved_at);
  const resolved = (comments ?? []).filter((c) => c.resolved_at);
  const shown = showResolved ? resolved : open;

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Client comments">
      <div className="modal modal-wide">
        <h2>Client comments</h2>
        <p className="muted">{link.job_title}. Only your studio and this client can see these, not people with the share link.</p>
        {error && <p className="error" role="alert">{error}</p>}

        {needsSignIn && <EventorSignIn onSignedIn={(who) => void load(who)} />}

        {!needsSignIn && comments === null && <p className="muted">Loading…</p>}

        {comments !== null && (
          <>
            <div className="comment-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={!showResolved} className={showResolved ? '' : 'on'} onClick={() => setShowResolved(false)}>
                Open ({open.length})
              </button>
              <button type="button" role="tab" aria-selected={showResolved} className={showResolved ? 'on' : ''} onClick={() => setShowResolved(true)}>
                Resolved ({resolved.length})
              </button>
            </div>
            <div className="comment-list">
              {shown.length === 0 && !error && (
                <p className="muted">{showResolved ? 'Nothing resolved yet.' : 'No open comments.'}</p>
              )}
              {shown.map((comment) => {
                const at = comment.spreadId ? spreadIds.indexOf(comment.spreadId) : -1;
                return (
                  <article key={comment.id} className="comment-row">
                    <header>
                      <strong>{at >= 0 ? `Spread ${at + 1}` : 'A spread no longer in the album'}</strong>
                      <span className="muted">{comment.clientName} · {when.format(new Date(comment.created_at))}</span>
                    </header>
                    <p>{comment.body}</p>
                    <div className="comment-actions">
                      {at >= 0 && (
                        <button type="button" className="btn" onClick={() => onGoToSpread(comment.spreadId!)}>Go to spread</button>
                      )}
                      <button type="button" className="btn" disabled={busyId === comment.id} onClick={() => void change(comment, !comment.resolved_at)}>
                        {comment.resolved_at ? 'Reopen' : 'Resolve'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
