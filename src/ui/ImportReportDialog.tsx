import { useEffect, useRef } from 'react';
import { X, CheckCircle2, AlertTriangle } from 'lucide-react';

export interface ImportReport {
  name: string;
  format: string;
  warnings: string[];
  count: number;
  /** Data files the worksheet reads that are not attached yet. */
  missingFiles?: string[];
}

export function ImportReportDialog({ report, onClose, onDataFiles }: { report: ImportReport; onClose: () => void; onDataFiles?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
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
        {!!report.missingFiles?.length && (
          <p className="import-files">
            It reads {report.missingFiles.length === 1 ? 'a data file' : `${report.missingFiles.length} data files`}: {report.missingFiles.join(', ')}. Attach {report.missingFiles.length === 1 ? 'it' : 'them'} to calculate with {report.missingFiles.length === 1 ? 'it' : 'them'} (they are kept in the worksheet).{' '}
            {onDataFiles && <button className="btn" onClick={onDataFiles}>Attach data files…</button>}
          </p>
        )}
        {!ok && (
          <ul className="import-warnings">
            {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
        <p className="hint">
          The import converts the math, programs, solve blocks, text with its formatting, images, X-Y plots, areas, input controls, page headers and footers. Results are recalculated here rather than copied, so check them
          against the original. Regions that could not be converted are marked ⚠️ on the page. Saving creates a new <code>.mstd</code> file; the original file is not changed.
        </p>
      </div>
    </dialog>
  );
}
