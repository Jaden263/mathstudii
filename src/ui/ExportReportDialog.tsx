import { useEffect, useRef } from 'react';
import { X, CheckCircle2, AlertTriangle } from 'lucide-react';

export interface ExportReport {
  name: string;
  /** "Mathcad Prime (.mcdx)" … */
  format: string;
  warnings: string[];
}

/** What an export to Mathcad or SMath wrote differently from the worksheet. */
export function ExportReportDialog({ report, onClose }: { report: ExportReport; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const ok = report.warnings.length === 0;
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="exp-title">
      <div className="dialog-head">
        <h2 id="exp-title">Exported {report.name}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="dialog-body">
        <p className={`import-summary ${ok ? 'ok' : 'warn'}`}>
          {ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          {report.format}: {ok ? 'everything was written as it is.' : `${report.warnings.length} thing${report.warnings.length > 1 ? 's' : ''} written differently:`}
        </p>
        {!ok && (
          <ul className="import-warnings">
            {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
        <p className="hint">
          Math, programs, solve blocks, text and units are written in the program’s own form; it calculates them again when it opens the file. Regions it has
          no counterpart for (beams, plates, CAD parts …) are a labelled note, a picture and the values the worksheet reads from them.
          The file was checked by reading it back here, not in Mathcad or SMath.
        </p>
      </div>
    </dialog>
  );
}
