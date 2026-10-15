import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

const SECTIONS: [string, [string, string][]][] = [
  ['Worksheet', [
    ['Click empty space', 'Place the insertion cursor (+)'],
    ['Start typing', 'Create a math region at the cursor'],
    ['"', 'Create a text region'],
    ['@', 'Create a plot'],
    ['#', 'Create a sketch (drawing)'],
    ['`', 'Create a Python region'],
    ['Right-click', 'Menu: edit, cut/copy/paste, delete, display unit, insert …'],
    ['Drag a region', 'Move it (Shift-click to multi-select, drag on empty space to box-select)'],
    ['Arrows', 'Move the cursor, or nudge selected regions'],
    ['Enter', 'Edit the selected region'],
    ['Delete', 'Delete selected regions'],
    ['Ctrl+C / X / V / D', 'Copy, cut, paste, duplicate regions'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
    ['Ctrl+F / Ctrl+H', 'Find / replace in every region (whole names: rename a variable)'],
    ['F9', 'Calculate now (needed when Auto is off)'],
    ['Esc', 'Interrupt a long calculation'],
    ['Ctrl+wheel / pinch', 'Zoom around the pointer'],
    ['Ctrl+= / Ctrl+− / Ctrl+0', 'Zoom in / out / reset to 100%'],
  ]],
  ['Math editing', [
    [':', 'Definition :='],
    ['~', 'Global definition ≡'],
    ['=', 'Evaluate; a list of fitting units appears (or type one)'],
    ['Tab / ↑↓', 'Accept / choose a suggestion (functions, variables, units)'],
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
  ['Sketches', [
    ['V / H', 'Select & move / pan (or middle mouse)'],
    ['L P R C A', 'Line, polyline, rectangle, circle, arc'],
    ['W D T F', 'Arrow, dimension, text, freehand'],
    ['K S X', 'Kinematic link, support/joint/load symbol, cross-section'],
    ['Shift', 'Constrain to 15° steps while drawing'],
    ['Alt', 'Disable snapping'],
    ['Enter / dbl-click', 'Finish a polyline (click the first point to close it)'],
    ['Corner handle', 'Resize the sketch; the drawing scales with it'],
    ['Del, Ctrl+D, arrows', 'Delete, duplicate, nudge selected shapes'],
    ['Esc', 'Cancel / deselect / leave the sketch'],
  ]],
  ['CAD window', [
    ['& or double-click a part', 'Open the CAD window (full screen on phones)'],
    ['L  R  Shift+R  C  A  Shift+A', 'Line, rectangle, centre rectangle, circle, arc, 3-point arc'],
    ['G  O  P', 'Polygon, slot, point'],
    ['I  T  M  X', 'Fillet, trim, mirror, construction'],
    ['D  Q', 'Dimension, measure'],
    ['Type digits while drawing', 'Exact length / size (Tab: next field, e.g. angle), Enter places it with a dimension'],
    ['H  V  E  K', 'Horizontal, vertical, equal, fix (with geometry selected)'],
    ['Wheel · middle/right drag · F', 'Zoom at the cursor · pan · fit'],
    ['Drag right / left', 'Window select / crossing select'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo for this part'],
  ]],
  ['Files', [
    ['Ctrl+S / Ctrl+Shift+S', 'Save / save as (.mstd)'],
    ['Ctrl+O', 'Open (also Mathcad .mcdx / .xmcd and SMath .sm / .smz; or drop a file on the window)'],
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
