import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { describeFailure } from '../messages';
import { session } from '../session';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // On success the App switches to the board, so this form unmounts and busy is not reset.
      await session.login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? err.message : describeFailure(err, 'sign in', []));
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>Triage</h1>
      <form className="login-form" onSubmit={onSubmit} aria-describedby="login-hint">
        <label className="field">
          <span>Username</span>
          <input
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error !== null && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p id="login-hint" className="hint">
        Demo logins: alice (admin), bob (responder), carol (viewer). Password for all: triage-demo.
      </p>
    </main>
  );
}
