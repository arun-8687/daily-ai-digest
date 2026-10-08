// Session gate: a boot message while the session loads, the login form when anonymous, the board when signed in.
import { useSession } from '../session';
import { useUrlState } from '../router';
import { Board } from './Board';
import { Login } from './Login';
import { Toasts } from './Toasts';
import { TopBar } from './TopBar';
import { useSheetViewport } from './viewport';

export function App() {
  const state = useSession();
  const url = useUrlState();
  // The full-screen drawer covers the top bar too, so the top bar is inert while it is open.
  const sheet = useSheetViewport() && url.sel !== null;
  return (
    <>
      {state.status === 'loading' && (
        <div className="boot" role="status">
          Loading Triage…
        </div>
      )}
      {state.status === 'anon' && <Login />}
      {state.status === 'authed' && state.user && (
        <>
          <TopBar user={state.user} inert={sheet} />
          <Board user={state.user} users={state.users} />
        </>
      )}
      <Toasts />
    </>
  );
}
