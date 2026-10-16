import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { FileSpreadsheet, FileUp, FileDown, Link2, Unlink, RefreshCw, Plus, X } from 'lucide-react';
import type { SpreadsheetRegion } from '../../model/types';
import type { RegionResult } from '../../engine/evaluator';
import type { SpreadsheetResult } from '../../sheet/component';
import type { Action } from '../store';
import { Tex } from '../Tex';
import { areaName, cellName, colName, parseCell, parseRange, quoteSheet, type Area } from '../../sheet/refs';
import { COL_W, HEAD_W, ROW_H } from '../../sheet/model';
import { Workbook, type SheetModel } from '../../sheet/engine';
import { tidyFormula, translateFormula } from '../../sheet/formula';
import { importWorkbook, reportText } from '../../sheet/importBook';
import { modelToWriteBook, writeXlsx, XLSX_MIME } from '../../sheet/xlsx';
import { parseDelimited } from '../../model/tableData';
import { canLinkXlsx, linkModified, linkOf, pickXlsx, readLinked } from '../../platform/xlsxFiles';
import { exportFile } from '../../platform/files';
import { BindingsEditor } from './BindingsEditor';

interface Props {
  region: SpreadsheetRegion;
  result?: RegionResult;
  editing: boolean;
  dispatch: Dispatch<Action>;
  onDone: (moveBelow?: boolean) => void;
  zoom: number;
}

interface Sel {
  r: number;
  c: number;
  /** The other corner of the selected range. */
  r2: number;
  c2: number;
}

const areaOf = (s: Sel): Area => ({ r1: Math.min(s.r, s.r2), c1: Math.min(s.c, s.c2), r2: Math.max(s.r, s.r2), c2: Math.max(s.c, s.c2) });
const inSel = (a: Area, r: number, c: number) => r >= a.r1 && r <= a.r2 && c >= a.c1 && c <= a.c2;

/** Cells copied here, so pasting them in this app keeps their formulas (moved like Excel moves them). */
let clipboard: { text: string; inputs: string[][]; r: number; c: number } | null = null;

const quoteTsv = (s: string) => (/[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** A pasted block with decimal commas (1,5 from a German Excel) read as numbers. */
function decimalCommas(grid: string[][]): string[][] {
  const flat = grid.flat();
  const comma = flat.some((c) => /^[-+]?\d+,\d+$/.test(c) && !/,\d{3}$/.test(c)) && !flat.some((c) => /^[-+]?\d+\.\d+$/.test(c) && !/\.\d{3}$/.test(c));
  return comma ? grid.map((r) => r.map((c) => (/^[-+]?[\d.]*,\d+$/.test(c) ? c.replace(/\./g, '').replace(',', '.') : c))) : grid;
}

/** Spreadsheet component: a grid of cells and formulas, worksheet inputs, outputs back to the worksheet. */
export function SpreadsheetView({ region, result, editing, dispatch, onDone, zoom }: Props) {
  const res = result?.kind === 'spreadsheet' ? (result as SpreadsheetResult) : undefined;
  const active = Math.min(region.active ?? 0, region.sheets.length - 1);
  const sheet = region.sheets[active] ?? { name: 'Sheet1', cells: {} };
  const shows = res?.cells[active] ?? {};
  const [sel, setSel] = useState<Sel>({ r: 0, c: 0, r2: 0, c2: 0 });
  /** The cell being edited; `caret`: arrows move in the text (F2) rather than to the next cell; `bar`: in the formula bar. */
  const [edit, setEdit] = useState<{ r: number; c: number; text: string; caret: boolean; bar?: boolean } | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [note, setNote] = useState<string | null>(null);
  const [linkIssue, setLinkIssue] = useState<{ why: string; message: string } | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const area = areaOf(sel);

  const set = (patch: Partial<SpreadsheetRegion>, coalesce?: string) => dispatch({ type: 'update', id: region.id, patch, coalesce });
  /** The grid growing or the sheet shown: not undo steps. */
  const setView = (patch: Partial<SpreadsheetRegion>) => dispatch({ type: 'update', id: region.id, patch, history: false });
  const setSheet = (patch: Partial<SheetModel>, coalesce?: string) => set({ sheets: region.sheets.map((s, i) => (i === active ? { ...s, ...patch } : s)) }, coalesce);
  const writeCells = (changes: [string, string][]) => {
    const cells = { ...sheet.cells };
    for (const [ref, v] of changes) {
      if (v === '') delete cells[ref];
      else cells[ref] = v;
    }
    setSheet({ cells });
  };

  // the grid holds what is used and a little more
  const used = useMemo(() => {
    let r = -1, c = -1;
    for (const k of [...Object.keys(sheet.cells), ...Object.keys(shows)]) {
      const p = parseCell(k);
      if (p) { r = Math.max(r, p.r); c = Math.max(c, p.c); }
    }
    return { r, c };
  }, [sheet.cells, shows]);
  const rows = Math.max(region.rows ?? 20, used.r + 2, area.r2 + 2);
  const cols = Math.min(16384, Math.max(region.cols ?? 8, used.c + 2, area.c2 + 2));
  const colW = (j: number) => sheet.widths?.[j] ?? COL_W;
  const colLeft = useMemo(() => {
    const out = [0];
    for (let j = 0; j < cols; j++) out.push(out[j] + (sheet.widths?.[j] ?? COL_W));
    return out;
  }, [cols, sheet.widths]);
  const merges = useMemo(() => (sheet.merges ?? []).map((m) => parseRange(m)).filter((a): a is NonNullable<ReturnType<typeof parseRange>> => !!a), [sheet.merges]);

  const viewH = region.height;
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - 4);
  const last = Math.min(rows - 1, Math.ceil((scroll.top + viewH) / ROW_H) + 4);

  const inputOf = (r: number, c: number) => sheet.cells[cellName(r, c)] ?? '';
  const selLabel = area.r1 === area.r2 && area.c1 === area.c2 ? cellName(area.r1, area.c1) : areaName(area);
  const qualified = (label: string) => (region.sheets.length > 1 ? `${quoteSheet(sheet.name)}!${label}` : label);

  // ------------------------------------------------------------ selection and keys

  const focusKeys = () => keysRef.current?.focus({ preventScroll: true });
  useEffect(() => {
    if (editing && !edit) focusKeys();
    if (!editing) {
      setEdit(null);
      // on the page the grid shows its top left corner
      if (gridRef.current) gridRef.current.scrollTop = gridRef.current.scrollLeft = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  // the hidden text box holds the selection as text, so the browser's own copy takes it
  useLayoutEffect(() => {
    const ta = keysRef.current;
    if (!ta || !editing || edit) return;
    ta.value = tsvOf(area);
    ta.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, shows, editing, edit]);

  const tsvOf = (a: Area) => {
    const lines: string[] = [];
    for (let r = a.r1; r <= Math.min(a.r2, a.r1 + 5000); r++) {
      const line: string[] = [];
      for (let c = a.c1; c <= a.c2; c++) {
        const s = shows[cellName(r, c)];
        line.push(quoteTsv(s ? s.t : inputOf(r, c).replace(/^'/, '')));
      }
      lines.push(line.join('\t'));
    }
    return lines.join('\n');
  };

  const scrollTo = (r: number, c: number) => {
    const g = gridRef.current;
    if (!g) return;
    const top = r * ROW_H, bottom = top + ROW_H * 2;
    if (top < g.scrollTop) g.scrollTop = top;
    else if (bottom > g.scrollTop + g.clientHeight) g.scrollTop = bottom - g.clientHeight;
    const left = colLeft[c] ?? 0, right = (colLeft[c + 1] ?? left + COL_W) + HEAD_W;
    if (left < g.scrollLeft) g.scrollLeft = left;
    else if (right > g.scrollLeft + g.clientWidth) g.scrollLeft = right - g.clientWidth;
  };
  const moveTo = (r: number, c: number, extend = false) => {
    const nr = Math.max(0, r), nc = Math.max(0, Math.min(16383, c));
    setSel((s) => (extend ? { ...s, r2: nr, c2: nc } : { r: nr, c: nc, r2: nr, c2: nc }));
    if (nr >= (region.rows ?? 20) - 1) setView({ rows: nr + 2 });
    if (nc >= (region.cols ?? 8) - 1) setView({ cols: nc + 2 });
    requestAnimationFrame(() => scrollTo(nr, nc));
  };

  const startEdit = (r: number, c: number, text: string, caret: boolean) => {
    setSel({ r, c, r2: r, c2: c });
    setEdit({ r, c, text, caret });
  };
  const commit = (dr: number, dc: number, refocus = true) => {
    if (!edit) return;
    const t = edit.text;
    const value = t.startsWith('=') ? tidyFormula(t) : t;
    if (value !== inputOf(edit.r, edit.c)) writeCells([[cellName(edit.r, edit.c), value]]);
    setEdit(null);
    if (!refocus) return;
    moveTo(edit.r + dr, edit.c + dc);
    focusKeys();
  };
  const clear = (a: Area) => {
    const changes: [string, string][] = [];
    for (const ref of Object.keys(sheet.cells)) {
      const p = parseCell(ref)!;
      if (inSel(a, p.r, p.c)) changes.push([ref, '']);
    }
    if (changes.length) writeCells(changes);
  };
  /** Copy the first row (down) or column (right) of the selection over the rest, formulas moved. */
  const fill = (down: boolean) => {
    const changes: [string, string][] = [];
    for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) {
      const sr = down ? area.r1 : r, sc = down ? c : area.c1;
      if (r === sr && c === sc) continue;
      const src = inputOf(sr, sc);
      changes.push([cellName(r, c), src.startsWith('=') ? translateFormula(src, r - sr, c - sc) : src]);
    }
    if (changes.length) writeCells(changes);
  };

  const onKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const { r2, c2 } = sel;
    const cur = e.shiftKey ? { r: r2, c: c2 } : { r: sel.r, c: sel.c };
    const page = Math.max(1, Math.floor(viewH / ROW_H) - 2);
    const go = (dr: number, dc: number) => { e.preventDefault(); moveTo(cur.r + dr, cur.c + dc, e.shiftKey); };
    if (k === 'ArrowDown') return go(1, 0);
    if (k === 'ArrowUp') return go(-1, 0);
    if (k === 'ArrowRight') return go(0, 1);
    if (k === 'ArrowLeft') return go(0, -1);
    if (k === 'PageDown') return go(page, 0);
    if (k === 'PageUp') return go(-page, 0);
    if (k === 'Home') { e.preventDefault(); return moveTo(cur.r, 0, e.shiftKey); }
    if (k === 'Enter') { e.preventDefault(); return moveTo(sel.r + (e.shiftKey ? -1 : 1), sel.c); }
    if (k === 'Tab') { e.preventDefault(); return moveTo(sel.r, sel.c + (e.shiftKey ? -1 : 1)); }
    if (k === 'F2') { e.preventDefault(); return startEdit(sel.r, sel.c, inputOf(sel.r, sel.c), true); }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); return clear(area); }
    if (k === 'Escape') { e.preventDefault(); return onDone(false); }
    if (mod && k.toLowerCase() === 'd') { e.preventDefault(); return fill(true); }
    if (mod && k.toLowerCase() === 'r') { e.preventDefault(); return fill(false); }
    if (mod && k.toLowerCase() === 'a') {
      e.preventDefault();
      return setSel({ r: 0, c: 0, r2: Math.max(0, used.r), c2: Math.max(0, used.c) });
    }
    // typing replaces the cell, as in Excel
    if (!mod && !e.altKey && k.length === 1) {
      e.preventDefault();
      startEdit(sel.r, sel.c, k, false);
    }
  };
  const onCopy = (e: React.ClipboardEvent, cut: boolean) => {
    e.preventDefault();
    const text = tsvOf(area);
    e.clipboardData.setData('text/plain', text);
    const inputs: string[][] = [];
    for (let r = area.r1; r <= area.r2; r++) inputs.push(Array.from({ length: area.c2 - area.c1 + 1 }, (_, j) => inputOf(r, area.c1 + j)));
    clipboard = { text, inputs, r: area.r1, c: area.c1 };
    if (cut) clear(area);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const changes: [string, string][] = [];
    const ours = clipboard && clipboard.text === text ? clipboard : null;
    const grid = ours ? ours.inputs : decimalCommas(parseDelimited(text));
    // one cell pasted onto a range fills it
    const h = grid.length === 1 && grid[0].length === 1 ? area.r2 - area.r1 + 1 : grid.length;
    const w = grid.length === 1 && grid[0].length === 1 ? area.c2 - area.c1 + 1 : grid[0]?.length ?? 0;
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
      const src = grid[i % grid.length][j % grid[0].length];
      const r = area.r1 + i, c = area.c1 + j;
      const moved = ours && src.startsWith('=') ? translateFormula(src, r - (ours.r + (i % grid.length)), c - (ours.c + (j % grid[0].length))) : src;
      changes.push([cellName(r, c), moved]);
    }
    writeCells(changes);
    setSel({ r: area.r1, c: area.c1, r2: area.r1 + h - 1, c2: area.c1 + w - 1 });
  };

  // ------------------------------------------------------------ pointer

  const cellAt = (x: number, y: number): { r: number; c: number } | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-cell]');
    if (!el || !gridRef.current?.contains(el)) return null;
    const [r, c] = el.dataset.cell!.split(',').map(Number);
    return { r, c };
  };
  const onCellDown = (e: React.PointerEvent, r: number, c: number) => {
    if (!editing || e.button !== 0) return;
    e.stopPropagation();
    if (edit && (edit.r !== r || edit.c !== c)) commit(0, 0);
    else if (edit) return;
    e.preventDefault();
    if (e.shiftKey) setSel((s) => ({ ...s, r2: r, c2: c }));
    else setSel({ r, c, r2: r, c2: c });
    focusKeys();
    const move = (ev: PointerEvent) => {
      const at = cellAt(ev.clientX, ev.clientY);
      if (at) setSel((s) => ({ ...s, r2: at.r, c2: at.c }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onHeadDown = (e: React.PointerEvent, what: 'col' | 'row', i: number) => {
    if (!editing || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (edit) commit(0, 0);
    const lastRow = Math.max(rows - 1, used.r), lastCol = Math.max(cols - 1, used.c);
    setSel(what === 'col' ? { r: 0, c: i, r2: lastRow, c2: i } : { r: i, c: 0, r2: i, c2: lastCol });
    focusKeys();
  };
  const onColResize = (e: React.PointerEvent, j: number) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX, w0 = colW(j);
    const move = (ev: PointerEvent) => setSheet({ widths: { ...sheet.widths, [j]: Math.max(24, Math.round(w0 + (ev.clientX - x0) / zoom)) } }, `sscol:${region.id}:${j}`);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY, w0 = region.width, h0 = region.height;
    const move = (ev: PointerEvent) => set({
      width: Math.max(240, Math.round((w0 + (ev.clientX - x0) / zoom) / 8) * 8),
      height: Math.max(80, Math.round((h0 + (ev.clientY - y0) / zoom) / 8) * 8),
    }, `ssize:${region.id}`);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ------------------------------------------------------------ files and the live link

  const applyFile = (bytes: Uint8Array, file: string, extra: Partial<SpreadsheetRegion> = {}) => {
    try {
      const patch = importWorkbook(bytes, file);
      set({ ...patch, active: 0, ...extra });
      setSel({ r: 0, c: 0, r2: 0, c2: 0 });
      return true;
    } catch (e) {
      setNote(`${file}: ${(e as Error).message}`);
      return false;
    }
  };
  const importFile = async () => {
    const f = await pickXlsx(false).catch((e: Error) => { setNote(e.message); return null; });
    if (f && applyFile(f.bytes, f.name, { link: undefined })) setNote(null);
  };
  const linkFile = async () => {
    const f = await pickXlsx(true).catch((e: Error) => { setNote(e.message); return null; });
    if (!f) return;
    const link = await linkOf(f);
    if (applyFile(f.bytes, f.name, { link: link ?? undefined })) {
      setLinkIssue(null);
      setNote(link ? null : 'This browser cannot keep a link to a file (Chrome and Edge can): the workbook was imported; import it again after it changes.');
    }
  };
  const reload = async (ask: boolean) => {
    const link = region.link;
    if (!link) return;
    const got = await readLinked(link, ask);
    if ('ok' in got) {
      setLinkIssue({ why: got.why, message: got.message });
      return;
    }
    setLinkIssue(null);
    applyFile(got.bytes, link.file, { link: { ...link, modified: got.modified } });
  };
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  // a watched link reads the file again when it changes (checked every 2 s while the page is shown)
  const link = region.link;
  useEffect(() => {
    if (!link?.watch) return;
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      const st = await linkModified(link);
      if (stopped) return;
      if (!st.ok) return setLinkIssue({ why: st.why, message: st.message });
      setLinkIssue(null);
      if (st.modified > (link.modified ?? 0)) await reloadRef.current(false);
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
  }, [link]);

  const exportXlsx = () => {
    const wb = new Workbook(region);
    for (const [s, ref, v] of res?.written ?? []) {
      const p = parseCell(ref);
      if (p) wb.setInput(s, p.r, p.c, v);
    }
    wb.recalc();
    const base = (region.link?.file ?? region.report?.file ?? 'spreadsheet').replace(/\.xls[xm]?$/i, '');
    void exportFile(`${base}.xlsx`, writeXlsx(modelToWriteBook(region, wb, base)), XLSX_MIME).catch((e: Error) => setNote(`Export failed: ${e.message}`));
  };

  // ------------------------------------------------------------ sheets

  const addSheet = () => {
    let n = region.sheets.length + 1;
    while (region.sheets.some((s) => s.name.toUpperCase() === `SHEET${n}`)) n++;
    set({ sheets: [...region.sheets, { name: `Sheet${n}`, cells: {} }], active: region.sheets.length });
  };
  const removeSheet = (i: number) => {
    if (region.sheets.length < 2 || !window.confirm(`Delete the sheet "${region.sheets[i].name}" and what is on it?`)) return;
    set({ sheets: region.sheets.filter((_, k) => k !== i), active: Math.max(0, i - 1) });
  };
  const renameSheet = (i: number, name: string) => {
    const n = name.trim().replace(/[[\]:*?/\\]/g, '_').slice(0, 31);
    setRenaming(null);
    if (!n || region.sheets.some((s, k) => k !== i && s.name.toUpperCase() === n.toUpperCase())) return;
    set({ sheets: region.sheets.map((s, k) => (k === i ? { ...s, name: n } : s)) });
  };

  // ------------------------------------------------------------ render

  const covered = new Set<string>();
  const spans = new Map<string, { rs: number; cs: number }>();
  for (const m of merges) {
    if (m.r1 < first || m.r2 > last) continue;
    spans.set(`${m.r1},${m.c1}`, { rs: m.r2 - m.r1 + 1, cs: m.c2 - m.c1 + 1 });
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(`${r},${c}`);
  }
  const editKeys = (bar: boolean) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (!edit) return;
    if (e.key === 'Enter') { e.preventDefault(); commit(e.shiftKey ? -1 : 1, 0); }
    else if (e.key === 'Tab') { e.preventDefault(); commit(0, e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); setEdit(null); focusKeys(); }
    else if (!edit.caret && !bar && e.key.startsWith('Arrow')) {
      // typed into a cell: arrows finish it and move on, as in Excel
      e.preventDefault();
      commit(e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0, e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
    }
  };
  // leaving the cell editor for anything but the formula bar keeps what was typed
  const onEditBlur = (e: React.FocusEvent) => {
    const to = e.relatedTarget as HTMLElement | null;
    if (to?.classList.contains('ss-edit') || to?.classList.contains('ss-fx-input')) return;
    commit(0, 0, false);
  };
  const status = res?.error;
  const width = region.width;

  return (
    <div className={`ss-region${editing ? ' editing' : ''}${status ? ' has-error' : ''}`} style={{ width }}>
      <div className="ss-head">
        <FileSpreadsheet size={14} aria-hidden />
        <span className="ss-tag">Spreadsheet</span>
        {link && (
          <span className={`ss-link${linkIssue ? ' warn' : ''}`} title={linkIssue?.message ?? (link.path ?? 'Linked: read again when it changes')}>
            <Link2 size={12} /> {link.file}{linkIssue ? '' : link.watch ? ' · live' : ''}
          </span>
        )}
        {editing && (
          <span className="ss-tools" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => void importFile()} title="Read an .xlsx file into this spreadsheet (a copy: formulas recalculated here)"><FileUp size={13} /> Import</button>
            <button onClick={() => void linkFile()} title={canLinkXlsx ? 'Link an .xlsx file: it is read again whenever it changes' : 'This browser cannot keep a link to a file (Chrome, Edge and the desktop app can): the file is imported'}><Link2 size={13} /> Link…</button>
            {link && <button onClick={() => void reload(true)} title="Read the linked file again now"><RefreshCw size={13} /> Reload</button>}
            {link && <button onClick={() => set({ link: undefined })} title="Keep the cells, forget the file"><Unlink size={13} /></button>}
            <button onClick={exportXlsx} title="Save as an .xlsx file (formulas and their results)"><FileDown size={13} /> Export</button>
          </span>
        )}
      </div>
      {editing && (
        <div className="ss-fx" onPointerDown={(e) => e.stopPropagation()}>
          <input
            key={selLabel}
            className="ss-namebox"
            defaultValue={selLabel}
            aria-label="Selected cell or range (type a reference to go there, or a name to name the selection)"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const t = e.currentTarget.value.trim();
              const p = parseRange(t);
              if (p && !p.sheet) {
                setSel({ r: p.r1, c: p.c1, r2: p.r2, c2: p.c2 });
                requestAnimationFrame(() => scrollTo(p.r1, p.c1));
              } else if (/^[A-Za-z_\\][\w.]*$/.test(t)) {
                // a name for the selection, as Excel's name box makes one
                const ref = `${quoteSheet(sheet.name)}!${areaName(area).replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}`;
                set({ names: [...(region.names ?? []).filter((n) => n.name.toUpperCase() !== t.toUpperCase()), { name: t, ref }] });
                setNote(`${t} is ${ref}`);
              }
              focusKeys();
            }}
          />
          <span className="ss-fx-label">fx</span>
          <input
            className="ss-fx-input"
            value={edit ? edit.text : inputOf(sel.r, sel.c)}
            spellCheck={false}
            aria-label={`Contents of ${cellName(edit?.r ?? sel.r, edit?.c ?? sel.c)}`}
            onFocus={() => { if (!edit) setEdit({ r: sel.r, c: sel.c, text: inputOf(sel.r, sel.c), caret: true, bar: true }); }}
            onChange={(e) => setEdit(edit ? { ...edit, text: e.target.value } : { r: sel.r, c: sel.c, text: e.target.value, caret: true, bar: true })}
            onKeyDown={editKeys(true)}
            onBlur={onEditBlur}
          />
        </div>
      )}
      <div
        ref={gridRef}
        className="ss-grid"
        style={{ height: viewH, overflow: editing ? 'auto' : 'hidden' }}
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}
      >
        <table style={{ width: HEAD_W + colLeft[cols] }}>
          <colgroup>
            <col style={{ width: HEAD_W }} />
            {Array.from({ length: cols }, (_, j) => <col key={j} style={{ width: colW(j) }} />)}
          </colgroup>
          <thead>
            <tr style={{ height: ROW_H }}>
              <th className="ss-corner" />
              {Array.from({ length: cols }, (_, j) => (
                <th key={j} className={j >= area.c1 && j <= area.c2 && editing ? 'on' : undefined} onPointerDown={(e) => onHeadDown(e, 'col', j)}>
                  {colName(j)}
                  {editing && <span className="ss-colresize" onPointerDown={(e) => onColResize(e, j)} />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {first > 0 && <tr style={{ height: first * ROW_H }} aria-hidden><td colSpan={cols + 1} /></tr>}
            {Array.from({ length: last - first + 1 }, (_, k) => {
              const r = first + k;
              return (
                <tr key={r} style={{ height: ROW_H }}>
                  <th className={`ss-rowhead${r >= area.r1 && r <= area.r2 && editing ? ' on' : ''}`} onPointerDown={(e) => onHeadDown(e, 'row', r)}>{r + 1}</th>
                  {Array.from({ length: cols }, (_, c) => {
                    if (covered.has(`${r},${c}`)) return null;
                    const ref = cellName(r, c);
                    const s = shows[ref];
                    const raw = sheet.cells[ref];
                    const isEdit = edit && edit.r === r && edit.c === c;
                    const span = spans.get(`${r},${c}`);
                    const text = s ? s.t : raw && !raw.startsWith('=') ? raw.replace(/^'/, '') : '';
                    const kind = s?.k ?? (raw && /^[-+]?[\d.]/.test(raw) ? 'n' : 's');
                    const cls = [`k-${kind}`, s?.in && 'in', s?.out && 'out', s?.sp && 'sp', sheet.styles?.[ref]?.b && 'b',
                      editing && inSel(area, r, c) && 'sel', editing && r === sel.r && c === sel.c && 'cur', isEdit && 'editing'].filter(Boolean).join(' ');
                    return (
                      <td
                        key={c} data-cell={`${r},${c}`} className={cls} rowSpan={span?.rs} colSpan={span?.cs}
                        title={raw?.startsWith('=') ? raw : undefined}
                        onPointerDown={(e) => onCellDown(e, r, c)}
                        onDoubleClick={() => editing && startEdit(r, c, inputOf(r, c), true)}
                      >
                        {isEdit && !edit.bar ? (
                          <input
                            className="ss-edit" autoFocus spellCheck={false} value={edit.text} aria-label={`Contents of ${ref}`}
                            onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                            onPointerDown={(e) => e.stopPropagation()} onKeyDown={editKeys(false)} onBlur={onEditBlur}
                          />
                        ) : isEdit ? edit.text : text}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {last < rows - 1 && <tr style={{ height: (rows - 1 - last) * ROW_H }} aria-hidden><td colSpan={cols + 1} /></tr>}
          </tbody>
        </table>
      </div>
      {editing && (
        <textarea
          ref={keysRef}
          className="ss-keys"
          aria-label="Spreadsheet cells"
          onKeyDown={onKeys}
          onCopy={(e) => onCopy(e, false)}
          onCut={(e) => onCopy(e, true)}
          onPaste={onPaste}
        />
      )}
      {(region.sheets.length > 1 || editing) && (
        <div className="ss-tabs" onPointerDown={(e) => editing && e.stopPropagation()}>
          {region.sheets.map((s, i) => (
            renaming === i ? (
              <input key={i} className="ss-tab-name" autoFocus defaultValue={s.name} aria-label="Sheet name"
                onBlur={(e) => renameSheet(i, e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') renameSheet(i, e.currentTarget.value); if (e.key === 'Escape') setRenaming(null); }} />
            ) : (
              <button key={i} className={`ss-tab${i === active ? ' on' : ''}`} onClick={() => i !== active && setView({ active: i })}
                onDoubleClick={() => editing && setRenaming(i)} title={editing ? 'Double-click to rename' : undefined}>
                {s.name}
                {editing && i === active && region.sheets.length > 1 && <X size={11} className="ss-tab-x" onClick={(e) => { e.stopPropagation(); removeSheet(i); }} aria-label={`Delete ${s.name}`} />}
              </button>
            )
          ))}
          {editing && <button className="ss-tab add" onClick={addSheet} title="Add a sheet" aria-label="Add a sheet"><Plus size={12} /></button>}
          {editing && <span className="ss-hint">F2 edit · Ctrl+D fill down · paste from Excel</span>}
        </div>
      )}
      {editing ? (
        <BindingsEditor region={region} result={res} selection={qualified(selLabel)} set={set} />
      ) : (
        <div className="ss-bindings-view">
          {region.inputs.map((_, i) => res?.inputs[i] && (
            <div key={`i${i}`} className={`ss-binding${res.inputs[i].error ? ' has-error' : ''}`}>
              {res.inputs[i].tex && <Tex tex={res.inputs[i].tex!} />}
              {res.inputs[i].error && <span className="region-error">{region.inputs[i].expr || 'input'}: {res.inputs[i].error}</span>}
            </div>
          ))}
          {region.outputs.map((_, i) => res?.outputs[i] && (
            <div key={`o${i}`} className={`ss-binding${res.outputs[i].error ? ' has-error' : ''}`}>
              {res.outputs[i].tex && <Tex tex={res.outputs[i].tex!} />}
              {res.outputs[i].error && <span className="region-error">{region.outputs[i].name || 'output'}: {res.outputs[i].error}</span>}
            </div>
          ))}
        </div>
      )}
      {region.report && editing && (
        <div className={`ss-report${region.report.mismatchCount ? ' warn' : ''}`}>
          {reportText(region.report)}
          {region.report.mismatches.length > 0 && <ul>{region.report.mismatches.map((m) => <li key={m}>{m}</li>)}</ul>}
        </div>
      )}
      {linkIssue && (
        <div className="ss-note warn" onPointerDown={(e) => e.stopPropagation()}>
          {linkIssue.message}
          {linkIssue.why === 'permission' && <button onClick={() => void reload(true)}>Reconnect</button>}
        </div>
      )}
      {note && <div className="ss-note" onPointerDown={(e) => e.stopPropagation()}>{note} <button onClick={() => setNote(null)} aria-label="Dismiss"><X size={11} /></button></div>}
      {status && <div className="region-error" role="alert">{status}</div>}
      {editing && <span className="ss-resize" onPointerDown={onResize} title="Drag to resize" aria-hidden />}
    </div>
  );
}
