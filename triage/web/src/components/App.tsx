import { useEffect } from 'react';
import { session, useSession } from '../session';
import { Board } from './Board';
import { Login } from './Login';

export function App() {
  const state = useSession();

  useEffect(() => {
    void session.init();
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="splash" role="status">
        Loading Triage…
      </div>
    );
  }
  if (state.status === 'anon') return <Login />;
  return <Board />;
}
