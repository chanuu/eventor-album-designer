import { useState, type FormEvent } from 'react';
import { signIn, type Staff } from './eventor';

/** The same account the studio uses for Eventor admin. */
export default function EventorSignIn({ onSignedIn }: { onSignedIn: (staff: Staff) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSignedIn(await signIn(email.trim(), password));
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : String(failed));
      setBusy(false);
    }
  }

  return (
    <form className="eventor-form" onSubmit={(e) => void submit(e)}>
      <p className="muted">Sign in with your Eventor studio account.</p>
      <label>
        <span>Email</span>
        <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        <span>Password</span>
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
    </form>
  );
}
