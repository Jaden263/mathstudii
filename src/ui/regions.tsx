import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { Plus, Minus, Loader2 } from 'lucide-react';
import type { MathRegion, TextRegion, SolveRegion, TableRegion, ImageRegion, PlotRegion, SketchRegion, CadRegion, BeamRegion, PythonRegion } from '../model/types';
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
import { PythonView } from './python/PythonView';

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
  const ac = useAutocomplete();
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
          onBlur={ac.close}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
      {editing && ac.popup(ref.current)}
      <div className="math-display">
        {display}
        {r?.pending && <Loader2 className="spin inline-icon" size={14} aria-label="Loading symbolic engine" />}
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
  const cols = Math.max(1, region.units.length, ...region.cells.map((c) => c.length));
  const set = (patch: Partial<TableRegion>) => dispatch({ type: 'update', id: region.id, patch, coalesce: `tbl:${region.id}` });
  const setCell = (i: number, j: number, v: string) => {
    const cells = region.cells.map((row) => [...row]);
    while (cells[i].length < cols) cells[i].push('');
    cells[i][j] = v;
    set({ cells });
  };
  const setUnit = (j: number, v: string) => {
    const units = [...region.units];
    while (units.length < cols) units.push('');
    units[j] = v;
    set({ units });
  };
  const addRow = () => set({ cells: [...region.cells, Array(cols).fill('')] });
  const delRow = () => region.cells.length > 1 && set({ cells: region.cells.slice(0, -1) });
  const addCol = () => set({ cells: region.cells.map((row) => [...row, '']), units: [...region.units, ''] });
  const delCol = () => cols > 1 && set({ cells: region.cells.map((row) => row.slice(0, cols - 1)), units: region.units.slice(0, cols - 1) });
  const keyNav = (e: React.KeyboardEvent<HTMLInputElement>, i: number, j: number) => {
    const move = (di: number, dj: number) => {
      const el = (e.currentTarget.closest('table') as HTMLTableElement).querySelector<HTMLInputElement>(`input[data-cell="${i + di},${j + dj}"]`);
      if (el) { e.preventDefault(); el.focus(); el.select(); }
    };
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      if (e.key === 'Enter' && i === region.cells.length - 1) { addRow(); setTimeout(() => move(1, 0)); return; }
      move(1, 0);
    } else if (e.key === 'ArrowUp') move(-1, 0);
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
                    <input data-cell={`${i},${j}`} value={row[j] ?? ''} aria-label={`Row ${i} column ${j}`} onChange={(e) => setCell(i, j, e.target.value)} onKeyDown={(e) => keyNav(e, i, j)} />
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
        </div>
      )}
      {r?.error && <div className="region-error">{r.error}</div>}
    </div>
  );
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

// ---------------------------------------------------------------- CAD part

export function CadRegionView({ region, result, editing, selected, dispatch, onDone }: RegionViewProps<CadRegion>) {
  return <CadView region={region} result={result} editing={editing} selected={selected} dispatch={dispatch} onDone={onDone} />;
}

// ---------------------------------------------------------------- python

export function PythonRegionView({ region, result, editing, dispatch, onDone, registerEditor, zoom }: RegionViewProps<PythonRegion>) {
  return <PythonView region={region} result={result} editing={editing} dispatch={dispatch} onDone={onDone} registerEditor={registerEditor} zoom={zoom} />;
}
