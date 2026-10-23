import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { Plus, Minus, Loader2 } from 'lucide-react';
import type { MathRegion, TextRegion, SolveRegion, TableRegion, ImageRegion, PlotRegion, SketchRegion, CadRegion, BeamRegion, PythonRegion, DrawingRegion, Frame3DRegion, PlateRegion, SpreadsheetRegion } from '../model/types';
import type { MathResult, SolveResult, TableResult, TextResult, PlotResult, RegionResult } from '../engine/evaluator';
import type { Action } from './store';
import { Tex } from './Tex';
import { renderMarkdown } from './markdown';
import { handleMathKeyDown, autosize, makeEditorHandle, type EditorHandle } from './editing';
import { PlotView } from './plot/PlotView';
import { useAutocomplete } from './autocomplete';
import { SketchView } from './sketch/SketchView';
import { CadView } from './cad/CadView';
import { BeamView } from './beam/BeamView';
import { Frame3DView } from './frame3d/Frame3DView';
import { PlateView } from './plate/PlateView';
import { parseDelimited, toCsv, toTableData, type TableData } from '../model/tableData';
import { PythonView } from './python/PythonView';
import { DrawingView } from './cad/DrawingView';
import type { CadResult } from '../cad/evaluate';
import { SpreadsheetView } from './sheet/SpreadsheetView';
import { askXlsxTable } from './sheet/XlsxTableDialog';
import { tableToXlsx } from '../sheet/tableXlsx';
import { XLSX_MIME } from '../sheet/xlsx';
import { exportFile as saveFile, pickFile } from '../platform/files';
import { pickChoice } from '../model/choices';

export interface RegionViewProps<R> {
  region: R;
  result?: RegionResult;
  editing: boolean;
  selected: boolean;
  dispatch: Dispatch<Action>;
  /** Leave edit mode; moveBelow places the insertion cursor under the region (Enter). */
  onDone: (moveBelow?: boolean) => void;
  registerEditor: (h: EditorHandle | null) => void;
  /** Page zoom, so canvases can render at screen resolution. */
  zoom: number;
}

function useEditorRegistration(editing: boolean, ref: React.RefObject<HTMLTextAreaElement | null>, register: (h: EditorHandle | null) => void) {
  useEffect(() => {
    if (!editing) return;
    const h = makeEditorHandle(() => ref.current);
    register(h);
    return () => register(null);
  }, [editing, ref, register]);
}

// ---------------------------------------------------------------- math

export function MathView({ region, result, editing, dispatch, onDone, registerEditor }: RegionViewProps<MathRegion>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const r = result as MathResult | undefined;
  useEditorRegistration(editing, ref, registerEditor);
  useLayoutEffect(() => {
    if (editing && ref.current) {
      autosize(ref.current);
    }
  }, [editing, region.source]);
  useLayoutEffect(() => {
    if (editing && ref.current && document.activeElement !== ref.current) {
      ref.current.focus();
      const n = ref.current.value.length;
      ref.current.setSelectionRange(n, n);
    }
  }, [editing]);
  const ac = useAutocomplete(r);
  const multiline = region.source.includes('\n');
  const display = r?.tex ? <Tex tex={r.tex} /> : <span className="placeholder-math">{region.source || ' '}</span>;
  return (
    <div className={`math-region${r?.error ? ' has-error' : ''}${editing ? ' editing' : ''}`}>
      {editing && (
        <textarea
          ref={ref}
          className="math-input"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          value={region.source}
          aria-label="Math expression"
          onChange={(e) => {
            dispatch({ type: 'update', id: region.id, patch: { source: e.target.value }, coalesce: `src:${region.id}` });
            ac.update(e.target);
          }}
          onKeyDown={(e) => {
            if (ac.onKeyDown(e)) return;
            handleMathKeyDown(e, { multiline, onCommit: () => onDone(true), onEscape: () => onDone(false) });
          }}
          onKeyUp={(e) => {
            if (e.key.startsWith('Arrow') && !e.shiftKey && !['ArrowUp', 'ArrowDown'].includes(e.key)) ac.update(e.currentTarget);
          }}
          onClick={(e) => ac.update(e.currentTarget)}
          onBlur={ac.close}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
      {editing && ac.popup(ref.current)}
      <div className="math-display">
        {display}
        {r?.pending && <Loader2 className="spin inline-icon" size={14} aria-label="Loading symbolic engine" />}
        {region.choices && !editing && (
          <select
            className="math-choice"
            value={region.choices.selected}
            aria-label="Choice"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const i = Number(e.target.value);
              const source = pickChoice(region.source, region.choices!, i);
              if (source !== null) dispatch({ type: 'update', id: region.id, patch: { source, choices: { ...region.choices!, selected: i } } });
            }}
          >
            {region.choices.labels.map((l, i) => <option key={i} value={i}>{l}</option>)}
          </select>
        )}
      </div>
      {r?.error && <div className="region-error" role="alert">{r.error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- text

export function TextView({ region, result, editing, dispatch, onDone, registerEditor }: RegionViewProps<TextRegion>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEditorRegistration(editing, ref, registerEditor);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (editing && ta) {
      ta.style.height = '0px';
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [editing, region.markdown, region.width]);
  useLayoutEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  const html = useMemo(() => renderMarkdown(region.markdown || '', result as TextResult | undefined), [region.markdown, result]);
  return (
    <div className="text-region" style={{ width: region.width }}>
      {editing ? (
        <textarea
          ref={ref}
          className="text-input"
          value={region.markdown}
          placeholder="Text — Markdown, $math$, {{live value | unit}}"
          aria-label="Text"
          onChange={(e) => dispatch({ type: 'update', id: region.id, patch: { markdown: e.target.value }, coalesce: `md:${region.id}` })}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
              e.preventDefault();
              onDone(e.key === 'Enter');
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="markdown" dangerouslySetInnerHTML={{ __html: html || '<p class="placeholder">Empty text</p>' }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- solve block

export function SolveView({ region, result, editing, dispatch, onDone, registerEditor }: RegionViewProps<SolveRegion>) {
  const r = result as SolveResult | undefined;
  const refs = { guesses: useRef<HTMLTextAreaElement>(null), constraints: useRef<HTMLTextAreaElement>(null), solver: useRef<HTMLTextAreaElement>(null) };
  const [active, setActive] = useState<'guesses' | 'constraints' | 'solver'>('guesses');
  useEffect(() => {
    if (!editing) return;
    registerEditor(makeEditorHandle(() => refs[active].current));
    return () => registerEditor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, active, registerEditor]);
  useEffect(() => {
    if (editing) refs.guesses.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useLayoutEffect(() => {
    Object.values(refs).forEach((x) => autosize(x.current));
  });
  const section = (key: 'guesses' | 'constraints' | 'solver', title: string, lines: { tex: string; error?: string }[]) => (
    <div className="solve-section">
      <div className="solve-title">{title}</div>
      {editing && (
        <textarea
          ref={refs[key]}
          className="math-input"
          spellCheck={false}
          wrap="off"
          value={region[key]}
          aria-label={title}
          onFocus={() => setActive(key)}
          onChange={(e) => dispatch({ type: 'update', id: region.id, patch: { [key]: e.target.value }, coalesce: `${key}:${region.id}` })}
          onKeyDown={(e) => handleMathKeyDown(e, { multiline: key !== 'solver', onCommit: key === 'solver' ? () => onDone(true) : undefined, onEscape: () => onDone(false) })}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
      {lines.map((l, i) => (
        <div key={i} className={`solve-line${l.error ? ' has-error' : ''}`}>
          <Tex tex={l.tex} />
          {l.error && <div className="region-error">{l.error}</div>}
        </div>
      ))}
    </div>
  );
  return (
    <div className="solve-region">
      {section('guesses', 'Guess values', r?.guesses ?? [])}
      {section('constraints', 'Constraints', r?.constraints ?? [])}
      {section('solver', 'Solver', r ? [r.solver] : [])}
    </div>
  );
}

// ---------------------------------------------------------------- table

export function TableView({ region, result, editing, dispatch }: RegionViewProps<TableRegion>) {
  const r = result as TableResult | undefined;
  const headers = region.headers ?? [];
  const cols = Math.max(1, region.units.length, headers.length, ...region.cells.map((c) => c.length));
  const named = headers.some((h) => h.trim());
  const set = (patch: Partial<TableRegion>, coalesce: string | undefined = `tbl:${region.id}`) => dispatch({ type: 'update', id: region.id, patch, coalesce });
  const pad = (row: string[], n = cols) => [...row, ...Array(Math.max(0, n - row.length)).fill('')];
  const setCell = (i: number, j: number, v: string) => {
    const cells = region.cells.map((row) => pad(row));
    cells[i][j] = v;
    set({ cells });
  };
  const setUnit = (j: number, v: string) => set({ units: pad(region.units).map((u, k) => (k === j ? v : u)) });
  const setHeader = (j: number, v: string) => set({ headers: pad(headers).map((h, k) => (k === j ? v : h)) });
  const addRow = () => set({ cells: [...region.cells, Array(cols).fill('')] }, undefined);
  const delRow = () => region.cells.length > 1 && set({ cells: region.cells.slice(0, -1) }, undefined);
  const addCol = () => set({ cells: region.cells.map((row) => [...pad(row), '']), units: [...pad(region.units), ''], headers: [...pad(headers), ''] }, undefined);
  const delCol = () => cols > 1 && set({ cells: region.cells.map((row) => pad(row).slice(0, cols - 1)), units: pad(region.units).slice(0, cols - 1), headers: pad(headers).slice(0, cols - 1) }, undefined);
  /** Put a block of data (pasted or imported) into the table, starting at row i, column j. */
  const putBlock = (data: TableData, i: number, j: number, replace: boolean) => {
    if (replace) {
      set({ cells: data.cells, units: data.units, headers: data.headers }, undefined);
      return;
    }
    const w = Math.max(cols, j + Math.max(...data.cells.map((c) => c.length)));
    const cells = region.cells.map((row) => pad(row, w));
    data.cells.forEach((row, di) => {
      while (cells.length <= i + di) cells.push(Array(w).fill(''));
      row.forEach((c, dj) => { cells[i + di][j + dj] = c; });
    });
    const units = pad(region.units, w), hs = pad(headers, w);
    data.headers.forEach((h, dj) => { if (h) hs[j + dj] = h; });
    data.units.forEach((u, dj) => { if (u) units[j + dj] = u; });
    set({ cells, units, headers: hs }, undefined);
  };
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>, i: number, j: number) => {
    const text = e.clipboardData.getData('text/plain');
    if (!/[\t\n]/.test(text.trim())) return;
    e.preventDefault();
    const data = toTableData(parseDelimited(text));
    // pasting a whole table with a header into the first cell replaces the table
    putBlock(data, i, j, i === 0 && j === 0 && data.headers.some((h) => h));
  };
  const importFile = async () => {
    const f = await pickTextFile('.csv,.tsv,.txt,text/csv,text/plain');
    if (!f) return;
    const data = toTableData(parseDelimited(f.text));
    const base = f.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^(\d)/, '_$1');
    set({ cells: data.cells, units: data.units, headers: data.headers, ...(region.name === 'T' && base ? { name: base } : {}) }, undefined);
  };
  const exportFile = () => {
    const csv = toCsv(headers, region.units, region.cells.filter((row) => row.some((c) => c.trim())));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${region.name || 'table'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const [xlsxError, setXlsxError] = useState<string | null>(null);
  /** A sheet or range of an .xlsx file, with names and units from its header row. */
  const importXlsx = async () => {
    const f = await pickFile('.xlsx,.xlsm');
    if (!f) return;
    try {
      const t = await askXlsxTable(new Uint8Array(await f.arrayBuffer()), f.name);
      if (!t) return;
      set({ cells: t.cells, units: t.units, headers: t.headers, ...(region.name === 'T' ? { name: t.name } : {}) }, undefined);
      setXlsxError(null);
    } catch (e) {
      setXlsxError(`${f.name}: ${(e as Error).message}`);
    }
  };
  const exportXlsx = () => {
    const values = r?.error ? undefined : r?.values;
    void saveFile(`${region.name || 'table'}.xlsx`, tableToXlsx({ ...region, cells: region.cells.filter((row) => row.some((c) => c.trim())) }, values), XLSX_MIME);
  };
  const keyNav = (e: React.KeyboardEvent<HTMLInputElement>, i: number, j: number) => {
    const move = (di: number, dj: number) => {
      const el = (e.currentTarget.closest('table') as HTMLTableElement).querySelector<HTMLInputElement>(`input[data-cell="${i + di},${j + dj}"]`);
      if (el) { e.preventDefault(); el.focus(); el.select(); }
    };
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      if (e.key === 'Enter' && i === region.cells.length - 1) { addRow(); setTimeout(() => move(1, 0)); return; }
      move(1, 0);
    } else if (e.key === 'ArrowUp') move(-1, 0);
    else if (e.key === 'ArrowRight' && e.currentTarget.selectionStart === e.currentTarget.value.length) move(0, 1);
    else if (e.key === 'ArrowLeft' && e.currentTarget.selectionStart === 0) move(0, -1);
    e.stopPropagation();
  };
  return (
    <div className={`table-region${r?.error ? ' has-error' : ''}`}>
      <div className="table-head">
        {editing ? (
          <input className="table-name" value={region.name} aria-label="Table variable name" onChange={(e) => set({ name: e.target.value })} onPointerDown={(e) => e.stopPropagation()} />
        ) : (
          <Tex tex={`${region.name.replace(/_(.+)/, '_{$1}')} \\coloneqq`} />
        )}
      </div>
      <table onPointerDown={(e) => editing && e.stopPropagation()}>
        <thead>
          {(editing || named) && (
            <tr className="names">
              <th className="idx" />
              {Array.from({ length: cols }, (_, j) => (
                <th key={j}>
                  {editing ? (
                    <input value={headers[j] ?? ''} placeholder="name" aria-label={`Column ${j} name`} onChange={(e) => setHeader(j, e.target.value)} />
                  ) : (
                    <span className="hname">{headers[j] ?? ''}</span>
                  )}
                </th>
              ))}
            </tr>
          )}
          <tr>
            <th className="idx" />
            {Array.from({ length: cols }, (_, j) => (
              <th key={j}>
                {editing ? (
                  <input value={region.units[j] ?? ''} placeholder="unit" aria-label={`Column ${j} unit`} onChange={(e) => setUnit(j, e.target.value)} />
                ) : (
                  <span className="unit">{region.units[j] || '—'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {region.cells.map((row, i) => (
            <tr key={i}>
              <td className="idx">{i}</td>
              {Array.from({ length: cols }, (_, j) => (
                <td key={j}>
                  {editing ? (
                    <input
                      data-cell={`${i},${j}`} value={row[j] ?? ''} aria-label={`Row ${i} column ${j}`}
                      onChange={(e) => setCell(i, j, e.target.value)} onKeyDown={(e) => keyNav(e, i, j)} onPaste={(e) => onPaste(e, i, j)}
                    />
                  ) : (
                    <span>{row[j] ?? ''}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <div className="table-tools" onPointerDown={(e) => e.stopPropagation()}>
          <button onClick={addRow} title="Add row"><Plus size={13} /> row</button>
          <button onClick={delRow} title="Remove last row"><Minus size={13} /> row</button>
          <button onClick={addCol} title="Add column"><Plus size={13} /> col</button>
          <button onClick={delCol} title="Remove last column"><Minus size={13} /> col</button>
          <button onClick={() => void importFile()} title="Load a CSV or TSV file (the first row may hold names and units: x [m])">Import CSV…</button>
          <button onClick={exportFile} title="Save as CSV (opens in Excel)">Export CSV</button>
          <button onClick={() => void importXlsx()} title="Load a sheet or range of an Excel workbook (a header row with units such as F [kN] gives the column units)">Import Excel…</button>
          <button onClick={exportXlsx} title="Save as an Excel workbook, the header row with the units">Export Excel</button>
          <label className="table-opt" title="Define each named column as a vector variable">
            <input type="checkbox" checked={!!region.columnVars} onChange={(e) => set({ columnVars: e.target.checked }, undefined)} /> columns as variables
          </label>
        </div>
      )}
      {editing && <div className="table-hint">Paste a range from Excel into any cell; a header row with units like <code>F [kN]</code> is understood.</div>}
      {xlsxError && <div className="region-error">{xlsxError}</div>}
      {r?.error && <div className="region-error">{r.error}</div>}
    </div>
  );
}

/** Ask for a text file (CSV …) and read it. */
function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}

// ---------------------------------------------------------------- image

export function ImageView({ region }: RegionViewProps<ImageRegion>) {
  return (
    <div className="image-region" style={{ width: region.width }}>
      {region.src ? <img src={region.src} alt="" draggable={false} /> : <div className="placeholder">No image</div>}
    </div>
  );
}

// ---------------------------------------------------------------- plot

export function PlotRegionView({ region, result, selected, dispatch, zoom }: RegionViewProps<PlotRegion>) {
  return <PlotView region={region} data={result as PlotResult | undefined} selected={selected} dispatch={dispatch} zoom={zoom} />;
}

// ---------------------------------------------------------------- sketch

export function SketchRegionView({ region, result, editing, selected, dispatch, onDone }: RegionViewProps<SketchRegion>) {
  return <SketchView region={region} result={result} editing={editing} selected={selected} dispatch={dispatch} onDone={onDone} />;
}

// ---------------------------------------------------------------- beam / frame

export function BeamRegionView({ region, result, editing, selected, dispatch, onDone }: RegionViewProps<BeamRegion>) {
  return <BeamView region={region} result={result} editing={editing} selected={selected} dispatch={dispatch} onDone={onDone} />;
}

// ---------------------------------------------------------------- 3-D frame

export function Frame3DRegionView({ region, result, editing, selected, dispatch, onDone }: RegionViewProps<Frame3DRegion>) {
  return <Frame3DView region={region} result={result} editing={editing} selected={selected} dispatch={dispatch} onDone={onDone} />;
}

// ---------------------------------------------------------------- plate

export function PlateRegionView({ region, result, editing, selected, dispatch, onDone }: RegionViewProps<PlateRegion>) {
  return <PlateView region={region} result={result} editing={editing} selected={selected} dispatch={dispatch} onDone={onDone} />;
}

// ---------------------------------------------------------------- CAD part

export function CadRegionView({ region, result, editing, selected, dispatch, onDone }: RegionViewProps<CadRegion>) {
  return <CadView region={region} result={result} editing={editing} selected={selected} dispatch={dispatch} onDone={onDone} />;
}

// ---------------------------------------------------------------- python

export function PythonRegionView({ region, result, editing, dispatch, onDone, registerEditor, zoom }: RegionViewProps<PythonRegion>) {
  return <PythonView region={region} result={result} editing={editing} dispatch={dispatch} onDone={onDone} registerEditor={registerEditor} zoom={zoom} />;
}

// ---------------------------------------------------------------- drawing

export function DrawingRegionView({ region, selected, dispatch, cad, cadResult }: RegionViewProps<DrawingRegion> & { cad?: CadRegion; cadResult?: RegionResult }) {
  return <DrawingView region={region} cad={cad} cadResult={cadResult?.kind === 'cad' ? (cadResult as CadResult) : undefined} selected={selected} dispatch={dispatch} />;
}

// ---------------------------------------------------------------- spreadsheet component

export function SpreadsheetRegionView({ region, result, editing, dispatch, onDone, zoom }: RegionViewProps<SpreadsheetRegion>) {
  return <SpreadsheetView region={region} result={result} editing={editing} dispatch={dispatch} onDone={onDone} zoom={zoom} />;
}
