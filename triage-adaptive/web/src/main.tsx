import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api } from './api';
import { incidentRef } from './format';
import { realtime } from './realtime';
import { useUrlState } from './router';
import { session, useSession } from './session';
import { store } from './store';
import { toast } from './toasts';
import { BulkReport } from './components/BulkReport';
import { Drawer } from './components/Drawer';
import { Filters } from './components/Filters';
import { IncidentList } from './components/IncidentList';
import { Login } from './components/Login';
import { ResolveDialog } from './components/ResolveDialog';
import { SelectionBar } from './components/SelectionBar';
import { Shortcuts } from './components/Shortcuts';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { handleKeyDown } from './components/keyboard';
import { ui } from './components/ui';
import type { DetailResponse } from '../../shared/types';

function App() {
  const me = useSession();
  const url = useUrlState();
  const authed = me.status === 'authed';

  useEffect(() => {
    void session.init();
  }, []);

  // The live stream runs only while signed in. session.expire() and session.logout() stop it.
  useEffect(() => {
    if (authed) realtime.start(() => session.expire());
    else ui.reset();
  }, [authed]);

  // URL filters drive the store. setFilters is a no-op when nothing changed.
  useEffect(() => {
    if (authed) store.setFilters(url.filters);
  }, [authed, url.filters]);

  // A deep-linked or back-navigated drawer becomes the keyboard cursor.
  useEffect(() => {
    if (url.sel !== null) ui.activate(url.sel, store.getList().order.indexOf(url.sel));
  }, [url.sel]);

  useEffect(
    () =>
      store.onUpdate((id, type) => {
        if (type !== 'incident.sla_breached' || id === null) return;
        const loaded = store.getEntry(id)?.inc.title;
        if (loaded) {
          toast('error', `SLA breached: ${incidentRef(id)} ${loaded}`);
          return;
        }
        // Not in the loaded list (another filter or page): look the title up so the toast still names the incident.
        api<DetailResponse>(`/api/incidents/${id}`).then(
          (d) => toast('error', `SLA breached: ${incidentRef(id)} ${d.incident.title}`),
          () => toast('error', `SLA breached: ${incidentRef(id)}`),
        );
      }),
    [],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (me.status === 'loading') {
    return (
      <>
        <p className="boot" role="status">
          Loading…
        </p>
        <Toasts />
      </>
    );
  }

  if (me.status === 'anon') {
    return (
      <>
        <Login />
        <Toasts />
      </>
    );
  }

  return (
    <div className="app">
      <TopBar />
      <div className={`app-body${url.sel !== null ? ' has-drawer' : ''}`}>
        <main className="list-pane">
          <Filters />
          <IncidentList />
          <SelectionBar />
        </main>
        {url.sel !== null && <Drawer id={url.sel} />}
      </div>
      <ResolveDialog />
      <BulkReport />
      <Shortcuts />
      <Toasts />
    </div>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');
createRoot(rootEl).render(<App />);
