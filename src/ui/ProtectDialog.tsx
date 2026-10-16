import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, ShieldOff, X } from 'lucide-react';
import type { WorksheetProtection } from '../model/types';
import { checkPassword, makeProtection } from '../model/protect';

interface Props {
  /** The current protection (unprotect), or null (protect). */
  current: WorksheetProtection | null;
  /** Regions marked as inputs, which stay editable. */
  inputs: number;
  onClose: () => void;
  onDone: (p: WorksheetProtection | null) => void;
}

/** Protect the worksheet (only inputs stay editable), optionally with a password; or lift it. */
export function ProtectDialog({ current, inputs, onClose, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const unprotect = !!current;
  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (unprotect) {
        if (!(await checkPassword(current, pw))) return setError('Wrong password');
        onDone(null);
      } else {
        if (pw !== pw2) return setError('The passwords differ');
        onDone(await makeProtection(pw));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={ref} className="dialog protect" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="prot-title">
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="dialog-head">
          <h2 id="prot-title">{unprotect ? <><ShieldOff size={17} /> Unprotect worksheet</> : <><ShieldCheck size={17} /> Protect worksheet</>}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="dialog-body">
          {unprotect ? (
            <p>{current.hash ? 'Enter the password to edit the whole worksheet again.' : 'The whole worksheet becomes editable again.'}</p>
          ) : (
            <>
              <p>
                Only regions marked as inputs stay editable ({inputs ? `${inputs} input${inputs === 1 ? '' : 's'}` : 'none yet: right-click a region → Mark as input'}).
                Nothing can be moved, deleted, pasted or added, and undo leaves the rest alone.
              </p>
              <p className="hint protect-note">
                Protection prevents accidental edits, not determined ones: the file is readable JSON, and anyone with a text editor can change it or remove the protection.
              </p>
            </>
          )}
          {(!unprotect || current.hash) && (
            <label className="protect-field">
              Password{unprotect ? '' : ' (optional)'}
              <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={unprotect ? 'current-password' : 'new-password'} />
            </label>
          )}
          {!unprotect && pw && (
            <label className="protect-field">
              Repeat password
              <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
            </label>
          )}
          {error && <p className="protect-error" role="alert">{error}</p>}
          <div className="protect-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>{unprotect ? 'Unprotect' : 'Protect'}</button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
