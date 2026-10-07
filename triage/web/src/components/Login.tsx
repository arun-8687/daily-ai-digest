import { useState, type FormEvent } from 'react';
import { messageOf } from '../api';
import { session } from '../session';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await session.login(username.trim(), password);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <main className="login" id="main">
      <div className="login-card">
        <h1>Triage</h1>
        <p className="muted">Real-time incident board</p>
        <form onSubmit={submit} aria-describedby={error ? 'login-error' : undefined}>
          <label className="field">
            Username
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
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p id="login-error" role="alert" className="error-text">
              {error}
            </p>
          )}
          <button type="submit" className="primary wide" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="hint">
          Demo accounts: <code>alice</code> (admin), <code>bob</code> (responder), <code>carol</code> (viewer).
          Password: <code>triage-demo</code>.
        </p>
      </div>
    </main>
  );
}
