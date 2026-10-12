import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

const SECTIONS: [string, [string, string][]][] = [
  ['Worksheet', [
    ['Click empty space', 'Place the insertion cursor (+)'],
    ['Start typing', 'Create a math region at the cursor'],
    ['"', 'Create a text region'],
    ['@', 'Create a plot'],
    ['Drag a region', 'Move it (Shift-click to multi-select, drag on empty space to box-select)'],
    ['Arrows', 'Move the cursor, or nudge selected regions'],
    ['Enter', 'Edit the selected region'],
    ['Delete', 'Delete selected regions'],
    ['Ctrl+C / X / V / D', 'Copy, cut, paste, duplicate regions'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
    ['F9', 'Calculate now (needed when Auto is off)'],
    ['Esc', 'Interrupt a long calculation'],
    ['Ctrl+wheel, Ctrl+= / −', 'Zoom'],
  ]],
  ['Math editing', [
    [':', 'Definition :='],
    ['~', 'Global definition ≡'],
    ['=', 'Evaluate (type a unit after it to convert)'],
    ['Ctrl+.', 'Symbolic evaluation →'],
    ['Ctrl+G', 'Make the previous letter Greek (a → α, w → ω)'],
    ['..', 'Range: 0 .. 10 or 0, 0.5 .. 10'],
    ['x_max', 'Literal subscript (part of the name)'],
    ['v[i]', 'Index (vector element, ORIGIN-based)'],
    ['Enter', 'Finish and move below'],
    ['Shift+Enter', 'New line (programs); Ctrl+Enter finishes multi-line regions'],
    ['Tab / Shift+Tab', 'Indent program lines'],
    ['Esc', 'Finish editing'],
  ]],
  ['Files', [
    ['Ctrl+S / Ctrl+Shift+S', 'Save / save as (.mstd)'],
    ['Ctrl+O', 'Open'],
    ['Ctrl+Alt+N', 'New worksheet'],
    ['Ctrl+P', 'Print or save as PDF'],
  ]],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="sc-title">
      <div className="dialog-head">
        <h2 id="sc-title">Keyboard shortcuts</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="dialog-body shortcuts">
        {SECTIONS.map(([title, rows]) => (
          <section key={title}>
            <h3>{title}</h3>
            <dl>
              {rows.map(([k, v]) => (
                <div key={k}>
                  <dt><kbd>{k}</kbd></dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="hint">On macOS use ⌘ instead of Ctrl.</p>
      </div>
    </dialog>
  );
}
