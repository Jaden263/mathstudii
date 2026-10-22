import { useEffect, useRef } from 'react';
import { X, CheckCircle2, AlertTriangle, FileUp } from 'lucide-react';

export interface ImportReport {
  name: string;
  format: string;
  warnings: string[];
  count: number;
  /** Other worksheets the file reads (SMath's include(…)) and whether they came in. */
  references?: { name: string; found: boolean }[];
}

/** onPickReference: the user picked the file of a worksheet the import did not have (import again with it). */
export function ImportReportDialog({ report, onClose, onPickReference }: { report: ImportReport; onClose: () => void; onPickReference?: (name: string, file: File) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const ok = report.warnings.length === 0;
  const missing = (report.references ?? []).filter((r) => !r.found);
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
        {missing.length > 0 && onPickReference && (
          <div className="import-references">
            <p>
              It includes {missing.length === 1 ? 'another worksheet' : `${missing.length} other worksheets`} that {missing.length === 1 ? 'is' : 'are'} not part of the file.
              Pick {missing.length === 1 ? 'it' : 'them'} to bring {missing.length === 1 ? 'its' : 'their'} definitions in: they are kept in this worksheet, in a collapsed area.
            </p>
            {missing.map((r) => (
              <label key={r.name} className="btn">
                <FileUp size={14} /> Pick {r.name}…
                <input type="file" accept=".sm,.smz" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickReference(r.name, f); }} />
              </label>
            ))}
          </div>
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
