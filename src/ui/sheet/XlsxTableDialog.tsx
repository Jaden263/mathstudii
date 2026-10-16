import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FileSpreadsheet, X } from 'lucide-react';
import type { TableData } from '../../model/tableData';
import { areaName, parseRange, type Area } from '../../sheet/refs';
import { looksLikeHeader, sheetToTable, usedArea, withResults } from '../../sheet/tableXlsx';
import { readXlsx, type XlsxBook } from '../../sheet/xlsx';

export interface XlsxTableChoice extends TableData {
  /** A variable name from the sheet's name. */
  name: string;
}

interface Props {
  book: XlsxBook;
  file: string;
  onDone: (t: XlsxTableChoice | null) => void;
}

const varName = (s: string) => s.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1') || 'T';

/** Choose the sheet, the range and whether its first row names the columns (with units: "F [kN]"). */
export function XlsxTableDialog({ book, file, onDone }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const [sheetIdx, setSheetIdx] = useState(Math.max(0, book.sheets.findIndex((s) => !s.hidden && s.cells.length)));
  const sheet = book.sheets[sheetIdx];
  const used = usedArea(sheet);
  const [range, setRange] = useState(used ? areaName(used) : 'A1');
  const area: Area | null = useMemo(() => {
    const p = parseRange(range);
    return p && !p.sheet ? { r1: p.r1, c1: p.c1, r2: Math.min(p.r2, (used?.r2 ?? p.r1)), c2: Math.min(p.c2, (used?.c2 ?? p.c1)) } : null;
  }, [range, used]);
  const [header, setHeader] = useState(area ? looksLikeHeader(sheet, area) : false);
  const pickSheet = (i: number) => {
    setSheetIdx(i);
    const u = usedArea(book.sheets[i]);
    setRange(u ? areaName(u) : 'A1');
    if (u) setHeader(looksLikeHeader(book.sheets[i], u));
  };
  const table = area ? sheetToTable(sheet, area, header, book.date1904) : null;
  const preview = table ? table.cells.slice(0, 8) : [];
  return (
    <dialog ref={ref} className="dialog xlsx-import" onClose={() => onDone(null)} onClick={(e) => e.target === ref.current && onDone(null)} aria-labelledby="xlsx-title">
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); if (table) onDone({ ...table, name: varName(book.sheets.length > 1 ? sheet.name : file) }); }}>
        <div className="dialog-head">
          <h2 id="xlsx-title"><FileSpreadsheet size={17} /> {file} → table</h2>
          <button type="button" className="icon-btn" onClick={() => onDone(null)} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="dialog-body">
          <div className="xlsx-choose">
            <label>Sheet
              <select value={sheetIdx} onChange={(e) => pickSheet(Number(e.target.value))}>
                {book.sheets.map((s, i) => <option key={i} value={i}>{s.name}{s.hidden ? ' (hidden)' : ''}</option>)}
              </select>
            </label>
            <label>Range
              <input value={range} onChange={(e) => setRange(e.target.value)} spellCheck={false} aria-invalid={!area} />
            </label>
            <label className="check">
              <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row: names and units (<code>F [kN]</code>)
            </label>
          </div>
          {!area && <p className="protect-error">“{range}” is not a range such as A1:D20.</p>}
          {table && (
            <div className="xlsx-preview">
              <table>
                <thead>
                  {header && <tr>{table.headers.map((h, j) => <th key={j}>{h || '—'}</th>)}</tr>}
                  {header && <tr className="units">{table.units.map((u, j) => <th key={j}>{u || '—'}</th>)}</tr>}
                </thead>
                <tbody>
                  {preview.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
                </tbody>
              </table>
              {table.cells.length > preview.length && <p className="hint">… {table.cells.length - preview.length} more rows</p>}
            </div>
          )}
          <p className="hint">Formulas come in as the values the file was saved with; dates as ISO text (2023-03-15). The table does not stay linked to the file: a spreadsheet region can.</p>
          <div className="protect-actions">
            <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!table}>Import {table ? `${table.cells.length} rows` : ''}</button>
          </div>
        </div>
      </form>
    </dialog>
  );
}

/** Read an .xlsx and ask which part becomes a table. */
export function askXlsxTable(bytes: Uint8Array, file: string): Promise<XlsxTableChoice | null> {
  const book = withResults(readXlsx(bytes));
  if (!book.sheets.length) throw new Error('The workbook has no worksheets');
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (t: XlsxTableChoice | null) => {
      root.unmount();
      host.remove();
      resolve(t);
    };
    root.render(<XlsxTableDialog book={book} file={file} onDone={done} />);
  });
}
