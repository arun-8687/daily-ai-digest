import { ui, useUi } from './ui';
import { Modal } from './Modal';

const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['j or ↓', 'Next row'],
  ['k or ↑', 'Previous row'],
  ['Enter', 'Open the active row in the drawer'],
  ['a', 'Ack the current incident'],
  ['r', 'Resolve the current incident'],
  ['x or Space', 'Toggle selection of the active row (Space works on the list)'],
  ['Shift+A', 'Ack all selected incidents'],
  ['Ctrl/Cmd-click', 'Toggle selection of a row'],
  ['/', 'Focus the title search'],
  ['Esc', 'Close the drawer, else clear the selection'],
  ['?', 'Show this list'],
];

export function Shortcuts() {
  const open = useUi((s) => s.shortcuts);
  return (
    <Modal open={open} onClose={() => ui.setShortcuts(false)} labelledBy="shortcuts-title" className="shortcuts">
      {open && (
        <>
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <dl className="shortcut-list">
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys}>
                <dt>
                  <kbd>{keys}</kbd>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <p className="muted">Shortcuts are off while you type in a field or while a dialog is open.</p>
          <div className="dialog-actions">
            <button type="button" className="primary" onClick={() => ui.setShortcuts(false)}>
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
