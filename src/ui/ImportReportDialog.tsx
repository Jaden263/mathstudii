import { useEffect, useRef } from 'react';
import { X, CheckCircle2, AlertTriangle } from 'lucide-react';

export interface ImportReport {
  name: string;
  format: string;
  warnings: string[];
  count: number;
  /** Worksheets it references whose definitions the file does not keep. */
  references?: string[];
}

export function ImportReportDialog({ report, onClose, onReferences }: { report: ImportReport; onClose: () => void; onReferences?: (files: File[]) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const refs = report.references ?? [];
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const ok = report.warnings.length === 0;
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="imp-title">
      <div className="dialog-head">
        <h2 id="imp-title">Imported {report.name}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="dialog-body">
        <p className={`import-summary ${ok ? 'ok' : 'warn'}`}>
          {ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          {report.format}: {report.count} regions imported{ok ? ' with no problems.' : `, ${report.warnings.length} need attention.`}
        </p>
        {!!refs.length && (
          <p className="import-files">
            It references {refs.length === 1 ? 'a worksheet' : `${refs.length} worksheets`} whose definitions it does not keep: {refs.join(', ')}. Pick {refs.length === 1 ? 'it' : 'them'} to import {refs.length === 1 ? 'its' : 'their'} definitions where the references are (in a locked, collapsed area; the worksheet keeps them).{' '}
            {onReferences && (
              <>
                <button className="btn" onClick={() => pick.current?.click()}>Pick referenced worksheets…</button>
                <input ref={pick} type="file" accept=".mcdx,.xmcd,.sm,.smz" multiple hidden onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  if (files.length) onReferences(files);
                }} />
              </>
            )}
          </p>
        )}
        {!ok && (
          <ul className="import-warnings">
            {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
        <p className="hint">
          The import converts the math, programs, solve blocks, text, images and X-Y plots. Results are recalculated here rather than copied, so check them
          against the original. Regions that could not be converted are marked ⚠️ on the page. Saving creates a new <code>.mstd</code> file; the original file is not changed.
        </p>
      </div>
    </dialog>
  );
}
