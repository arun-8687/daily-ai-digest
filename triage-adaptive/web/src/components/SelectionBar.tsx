import { hasRole } from '../../../shared/rules';
import { store } from '../store';
import { useSession } from '../session';
import { bulkAckSelected } from './actions';
import { ui, useUi } from './ui';

export function SelectionBar() {
  const selected = useUi((s) => s.selected);
  const busy = useUi((s) => s.bulkBusy);
  const user = useSession().user;
  if (selected.size === 0) return null;
  const canAck = user !== null && hasRole(user.role, 'responder');

  return (
    <div className="selection-bar" role="region" aria-label="Bulk selection">
      <span className="selection-count">{`${selected.size} selected`}</span>
      <button
        type="button"
        className="primary"
        disabled={!canAck || busy}
        aria-keyshortcuts="Shift+A"
        onClick={() => void bulkAckSelected()}
      >
        Ack selected <kbd aria-hidden="true">Shift+A</kbd>
      </button>
      <button
        type="button"
        onClick={() =>
          ui.setSelected(store.getList().order.filter((id) => store.getEntry(id)?.inc.status === 'open'))
        }
      >
        Select open
      </button>
      <button type="button" onClick={() => ui.clearSelected()}>
        Clear
      </button>
    </div>
  );
}
