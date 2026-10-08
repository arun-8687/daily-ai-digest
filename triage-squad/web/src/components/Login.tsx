// Sign-in form. Shown only when the session is anonymous.
import { useState, type FormEvent } from 'react';
import { messageOf } from '../api';
import { session } from '../session';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.login(username.trim(), password);
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
      setPassword('');
    }
  }

  return (
    <div className="login-page">
      <main className="login">
        <h1>Triage</h1>
        <form className="login-form" onSubmit={(e) => void onSubmit(e)}>
          <div className="field">
            <label htmlFor="login-username">Username</label>
            <input
              id="login-username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            Sign in
          </button>
        </form>
        <p className="hint">
          Demo logins: <code>alice</code> (admin), <code>bob</code> (responder), <code>carol</code> (viewer). Password for
          all three: <code>triage-demo</code>.
        </p>
      </main>
    </div>
  );
}
