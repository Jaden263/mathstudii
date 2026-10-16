// The tables of a plate region while it is edited: the outline's corners with the support
// of each edge, the openings, the walls and columns, the loads (spreadsheet-like: Enter and
// the arrow keys move along a column, rows pasted from Excel add corners), and the results
// of what is shown: reactions and extremes.
import type { Dispatch, ReactNode } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import type { PlateRegion } from '../../model/types';
import type { PlateResult } from '../../plate/evaluate';
import { EDGE_SUPPORTS, edgeName, nextName, plateId, type EdgeSupport, type PlateEdge, type PlateLoad, type PlatePoint, type PlateTab } from '../../plate/model';
import { loadCase } from '../../beam/model';
import { toTsv } from '../../model/tableData';
import type { Action } from '../store';
import { useSketchUI } from '../sketch/context';
import { Cell } from '../frame3d/Frame3DTables';
import { FORCE_N, LENGTH_M, fmt } from '../beam/beamDraw';
import { displayUnit, FIELDS, fieldOf } from './plateDraw';

const TABS: { id: PlateTab; label: string }[] = [
  { id: 'outline', label: 'Outline' },
  { id: 'openings', label: 'Openings' },
  { id: 'supports', label: 'Walls & columns' },
  { id: 'loads', label: 'Loads' },
  { id: 'results', label: 'Results' },
];

const num = (v: number) => String(+v.toPrecision(6));

/** "x y; x y; …" ↔ corners. */
const cornersText = (ps: PlatePoint[]) => ps.map((p) => `${p.x} ${p.y}`).join('; ');
function parseCorners(src: string): PlatePoint[] | null {
  const out = src.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const parts = s.split(/[\s,]+/).filter(Boolean);
    return parts.length === 2 ? { x: parts[0], y: parts[1] } : null;
  });
  return out.length >= 3 && out.every(Boolean) ? (out as PlatePoint[]) : null;
}

export function PlateTables({ region, result, dispatch, height }: { region: PlateRegion; result?: PlateResult; dispatch: Dispatch<Action>; height: number }) {
  const { ui, setUi } = useSketchUI();
  const tab = region.tab ?? 'outline';
  const commit = (patch: Partial<PlateRegion>) => dispatch({ type: 'update', id: region.id, patch });
  const sel = new Set(ui.regionId === region.id ? ui.selected : []);
  const pick = (id: string) => setUi({ regionId: region.id, selected: [id] });
  const err = (id: string) => result?.errors[id];
  const Lu = region.lengthUnit, F = region.forceUnit, Lm = LENGTH_M[Lu] ?? 1;
  const rowProps = (id: string) => ({ className: `${sel.has(id) ? 'sel' : ''}${err(id) ? ' err' : ''}`, title: err(id), onClick: () => pick(id) });
  const del = (onClick: () => void, what: string, disabled = false) => (
    <td className="f3-del"><button className="icon-btn" aria-label={`Remove ${what}`} title="Remove" disabled={disabled} onClick={onClick}><Trash2 size={12} /></button></td>
  );
  // the plate's middle and size, for new items
  const box = (() => {
    const o = result?.outline.length ? result.outline : region.outline.map((p) => [Number(p.x) * Lm, Number(p.y) * Lm]);
    const xs = o.map((p) => p[0]).filter(Number.isFinite), ys = o.map((p) => p[1]).filter(Number.isFinite);
    if (!xs.length) return { cx: 3, cy: 2, size: 1 };
    return { cx: (Math.min(...xs) + Math.max(...xs)) / 2 / Lm, cy: (Math.min(...ys) + Math.max(...ys)) / 2 / Lm, size: Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / Lm };
  })();

  // ------------------------------------------------------------ outline
  const edges = region.outline.map((_, i) => region.edges[i] ?? ({ support: 'free' } as PlateEdge));
  const updCorner = (i: number, patch: Partial<PlatePoint>) => commit({ outline: region.outline.map((p, k) => (k === i ? { ...p, ...patch } : p)), edges });
  const updEdge = (i: number, patch: Partial<PlateEdge>) => commit({ edges: edges.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
  const addCorner = () => {
    // in the middle of the selected edge (or the last one), which it splits in two of the same support
    const selected = region.outline.findIndex((_, i) => sel.has(`edge:${i}`));
    const i = selected >= 0 ? selected : region.outline.length - 1, j = (i + 1) % region.outline.length;
    const a = region.outline[i], b = region.outline[j];
    const mid = (p: string, q: string) => (Number.isFinite(Number(p)) && Number.isFinite(Number(q)) ? num((Number(p) + Number(q)) / 2) : `(${p} + ${q}) / 2`);
    const c: PlatePoint = a && b ? { x: mid(a.x, b.x), y: mid(a.y, b.y) } : { x: '0', y: '0' };
    commit({ outline: [...region.outline.slice(0, i + 1), c, ...region.outline.slice(i + 1)], edges: [...edges.slice(0, i + 1), { ...edges[i] }, ...edges.slice(i + 1)] });
    pick(`edge:${i + 1}`);
  };
  const removeCorner = (i: number) => commit({ outline: region.outline.filter((_, k) => k !== i), edges: edges.filter((_, k) => k !== i) });
  const pasteCorners = (row: number, col: number, grid: string[][]) => {
    const outline = [...region.outline], next = [...edges];
    grid.forEach((cells, k) => {
      const i = row + k;
      if (i >= outline.length) {
        outline.push({ x: '0', y: '0' });
        next.push({ ...(next[next.length - 1] ?? { support: 'free' }) });
      }
      const p = { ...outline[i] };
      cells.forEach((c, j) => {
        const key = (['x', 'y'] as const)[col + j];
        if (key && c.trim()) p[key] = c.trim();
      });
      outline[i] = p;
    });
    commit({ outline, edges: next });
  };

  // ------------------------------------------------------------ openings, walls, columns, loads
  const addOpening = () => {
    const h = +(box.size / 5).toPrecision(2);
    const o = { id: plateId('o'), name: nextName('O', region.openings), points: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({ x: num(box.cx + (x * h) / 2), y: num(box.cy + (y * h) / 2) })) };
    commit({ openings: [...region.openings, o] });
    pick(o.id);
  };
  const addWall = () => {
    const w = { id: plateId('w'), name: nextName('W', region.walls), a: { x: num(box.cx), y: num(box.cy - box.size / 4) }, b: { x: num(box.cx), y: num(box.cy + box.size / 4) } };
    commit({ walls: [...region.walls, w] });
    pick(w.id);
  };
  const addColumn = () => {
    const c = { id: plateId('c'), name: nextName('C', region.columns), x: num(box.cx), y: num(box.cy), b: '400', h: '400' };
    commit({ columns: [...region.columns, c] });
    pick(c.id);
  };
  const lc = region.loadCases;
  const newCase = lc ? (lc.cases.find((c) => c.id === lc.view)?.id ?? lc.cases[0]?.id) : undefined;
  const addLoad = (type: PlateLoad['type']) => {
    const c = newCase ? { case: newCase } : {};
    const h = box.size / 4, x1 = num(box.cx - h), x2 = num(box.cx + h), y1 = num(box.cy - h), y2 = num(box.cy + h);
    const l: PlateLoad = type === 'area' ? { id: plateId('l'), type, q: '5', ...c }
      : type === 'patch' ? { id: plateId('l'), type, q: '10', x1, y1, x2, y2, ...c }
      : type === 'line' ? { id: plateId('l'), type, q: '10', x1, y1: num(box.cy), x2, y2: num(box.cy), ...c }
      : type === 'point' ? { id: plateId('l'), type, F: '20', x: num(box.cx), y: num(box.cy), ...c }
      : { id: plateId('l'), type, ...c };
    commit({ loads: [...region.loads, l] });
    pick(l.id);
  };
  const updLoad = (id: string, patch: Partial<PlateLoad>) => commit({ loads: region.loads.map((l) => (l.id === id ? ({ ...l, ...patch } as PlateLoad) : l)) });

  // ------------------------------------------------------------ results
  const resultsTable = () => {
    const f = result?.fields;
    if (!f || !result?.reactions) return <p className="hint f3-pad">{result?.error ?? 'No results yet.'}</p>;
    const FN = FORCE_N[F] ?? 1e3;
    const force = (v: number) => fmt(v / FN), line = (v?: number) => (v === undefined || !Number.isFinite(v) ? '' : fmt((v * Lm) / FN));
    const rows = result.reactions.map((q) => {
      const inner = q.r?.slice(1, -1).filter(Number.isFinite) ?? [];
      const lo = q.rmin?.slice(1, -1) ?? inner;
      return [q.name, force(q.R), q.Rmin !== undefined ? force(q.Rmin) : '', inner.length ? line(Math.max(...inner)) : '', lo.length ? line(Math.min(...lo)) : '', q.ends ? force(q.ends[0]) : '', q.ends ? force(q.ends[1]) : ''];
    });
    const sum = result.reactions.reduce((s, q) => s + q.R, 0);
    const extremes = FIELDS.filter((fi) => f[fi.key]).map((fi) => {
      const du = displayUnit(region, fi.kind);
      const hi = fieldOf(result, fi.key, 'max')!, lo = fieldOf(result, fi.key, 'min')!;
      let mx = -Infinity, mn = Infinity;
      for (let i = 0; i < hi.length; i++) mx = Math.max(mx, hi[i]);
      for (let i = 0; i < lo.length; i++) mn = Math.min(mn, lo[i]);
      return [fi.label, fi.title, fmt(mx * du.k), fmt(mn * du.k), du.unit];
    });
    const block = (title: string, head: string[], body: string[][], key: string): ReactNode => (
      <div className="f3-result" key={key}>
        <h4>{title}<button className="icon-btn" title="Copy as a table (paste into Excel)" aria-label={`Copy ${title}`} onClick={() => void navigator.clipboard?.writeText(toTsv([head, ...body]))}><Copy size={12} /></button></h4>
        <table className="f3-table ro">
          <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j && j < r.length ? 'num' : ''}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    const m = result.mesh;
    return (
      <>
        <p className="hint f3-pad">
          {result.view === 'envelope' ? 'Envelope of the combinations (max and min). ' : ''}
          {m ? `${m.quads.length / 4} elements (${m.structured ? 'grid' : 'triangles split into quads'}, corners ${fmt(m.minAngle)}° – ${fmt(m.maxAngle)}°), ` : ''}
          {result.unknowns} unknowns{result.millis !== undefined && !result.cached ? `, solved in ${fmt(result.millis)} ms` : ''}. Reactions upwards; per length along a line, its end forces are the corner forces.
        </p>
        {block('Reactions', ['Support', `R [${F}]`, `R min [${F}]`, `r max [${F}/${Lu}]`, `r min [${F}/${Lu}]`, `at start [${F}]`, `at end [${F}]`], [...rows, ['Σ', force(sum), '', '', '', '', '']], 'r')}
        {block('Extremes', ['Field', '', 'max', 'min', 'unit'], extremes, 'e')}
      </>
    );
  };

  // ------------------------------------------------------------ render
  const count: Partial<Record<PlateTab, number>> = { outline: region.outline.length, openings: region.openings.length, supports: region.walls.length + region.columns.length, loads: region.loads.length };
  return (
    <div className="f3-tables" style={{ height }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="f3-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => dispatch({ type: 'update', id: region.id, patch: { tab: t.id }, history: false })}>
            {t.label}{count[t.id] !== undefined && <span className="f3-count">{count[t.id]}</span>}
          </button>
        ))}
      </div>
      <div className="f3-table-wrap">
        {tab === 'outline' && (
          <table className="f3-table">
            <thead><tr><th>Corner</th><th>X [{Lu}]</th><th>Y [{Lu}]</th><th title="The edge from this corner to the next">Edge</th><th>Support</th><th title={`Spring per length (bare number ${F}/${Lu}²)`}>k</th><th title={`Rotational spring per length (bare number ${F}·${Lu}/${Lu} per rad)`}>k<sub>θ</sub></th><th /></tr></thead>
            <tbody>
              {region.outline.map((p, i) => {
                const id = `edge:${i}`, e = edges[i];
                return (
                  <tr key={i} {...rowProps(id)}>
                    <td className="f3-kind">{i + 1}</td>
                    {(['x', 'y'] as const).map((key, c) => (
                      <td key={key}><Cell table="o" row={i} col={c} value={p[key]} title={`${key.toUpperCase()} (a bare number is ${Lu})`} onCommit={(v) => updCorner(i, { [key]: v.trim() || '0' })} onGrid={(g) => pasteCorners(i, c, g)} /></td>
                    ))}
                    <td className="f3-kind">{edgeName(i)}: {i + 1} → {((i + 1) % region.outline.length) + 1}</td>
                    <td>
                      <select value={e.support} aria-label={`Support of ${edgeName(i)}`} onChange={(ev) => updEdge(i, { support: ev.target.value as EdgeSupport })}>
                        {EDGE_SUPPORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                      </select>
                    </td>
                    <td>{e.support === 'spring' && <Cell table="o" row={i} col={3} value={e.k ?? ''} placeholder="—" title={`Spring per length (bare number ${F}/${Lu}²)`} onCommit={(v) => updEdge(i, { k: v.trim() || undefined })} />}</td>
                    <td>{e.support === 'spring' && <Cell table="o" row={i} col={4} value={e.kr ?? ''} placeholder="—" title="Rotational spring per length, about the edge" onCommit={(v) => updEdge(i, { kr: v.trim() || undefined })} />}</td>
                    {del(() => removeCorner(i), `corner ${i + 1}`, region.outline.length <= 3)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === 'openings' && (
          <table className="f3-table">
            <thead><tr><th>Name</th><th title="x y; x y; … counter-clockwise or clockwise">Corners [{Lu}]: x y; x y; …</th><th /></tr></thead>
            <tbody>
              {region.openings.map((o, i) => (
                <tr key={o.id} {...rowProps(o.id)}>
                  <td><Cell table="h" row={i} col={0} value={o.name} title="Opening name" onCommit={(v) => v.trim() && commit({ openings: region.openings.map((q) => (q.id === o.id ? { ...q, name: v.trim() } : q)) })} /></td>
                  <td className="pl-corners"><Cell table="h" row={i} col={1} value={cornersText(o.points)} title="Corners as x y pairs separated by ; (expressions allowed)"
                    onCommit={(v) => { const pts2 = parseCorners(v); if (pts2) commit({ openings: region.openings.map((q) => (q.id === o.id ? { ...q, points: pts2 } : q)) }); }} /></td>
                  {del(() => commit({ openings: region.openings.filter((q) => q.id !== o.id) }), `opening ${o.name}`)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'supports' && (
          <>
            <table className="f3-table">
              <thead><tr><th>Wall</th><th>x₁</th><th>y₁</th><th>x₂</th><th>y₂</th><th title={`Empty: rigid; else a spring per length (bare number ${F}/${Lu}²)`}>k</th><th /></tr></thead>
              <tbody>
                {region.walls.map((w, i) => (
                  <tr key={w.id} {...rowProps(w.id)}>
                    <td><Cell table="w" row={i} col={0} value={w.name} title="Wall name" onCommit={(v) => v.trim() && commit({ walls: region.walls.map((q) => (q.id === w.id ? { ...q, name: v.trim() } : q)) })} /></td>
                    {(['a', 'b'] as const).flatMap((end, e) => (['x', 'y'] as const).map((key, c) => (
                      <td key={`${end}${key}`}><Cell table="w" row={i} col={1 + 2 * e + c} value={w[end][key]} title={`${key}${e + 1} (a bare number is ${Lu})`}
                        onCommit={(v) => commit({ walls: region.walls.map((q) => (q.id === w.id ? { ...q, [end]: { ...q[end], [key]: v.trim() || '0' } } : q)) })} /></td>
                    )))}
                    <td><Cell table="w" row={i} col={5} value={w.k ?? ''} placeholder="rigid" title="Empty: rigid (w = 0); else a spring per length" onCommit={(v) => commit({ walls: region.walls.map((q) => (q.id === w.id ? { ...q, k: v.trim() || undefined } : q)) })} /></td>
                    {del(() => commit({ walls: region.walls.filter((q) => q.id !== w.id) }), `wall ${w.name}`)}
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="f3-table pl-columns">
              <thead><tr><th>Column</th><th>x [{Lu}]</th><th>y [{Lu}]</th><th title="Empty: a point support">b [mm]</th><th>h [mm]</th><th title="Round, of diameter b">Ø</th><th title={`Height for the head's bedding E A / H (bare number ${Lu}; empty 3 m)`}>H</th><th title={`A spring instead of rigid (bare number ${F}/${Lu})`}>k</th><th /></tr></thead>
              <tbody>
                {region.columns.map((c, i) => {
                  const upd = (patch: Partial<typeof c>) => commit({ columns: region.columns.map((q) => (q.id === c.id ? { ...q, ...patch } : q)) });
                  return (
                    <tr key={c.id} {...rowProps(c.id)}>
                      <td><Cell table="c" row={i} col={0} value={c.name} title="Column name" onCommit={(v) => v.trim() && upd({ name: v.trim() })} /></td>
                      <td><Cell table="c" row={i} col={1} value={c.x} title={`x (a bare number is ${Lu})`} onCommit={(v) => upd({ x: v.trim() || '0' })} /></td>
                      <td><Cell table="c" row={i} col={2} value={c.y} title={`y (a bare number is ${Lu})`} onCommit={(v) => upd({ y: v.trim() || '0' })} /></td>
                      <td><Cell table="c" row={i} col={3} value={c.b ?? ''} placeholder="point" title="Size b (bare number mm); empty: a point support" onCommit={(v) => upd({ b: v.trim() || undefined })} /></td>
                      <td>{!c.round && <Cell table="c" row={i} col={4} value={c.h ?? ''} placeholder="= b" title="Size h (bare number mm); empty: square" onCommit={(v) => upd({ h: v.trim() || undefined })} />}</td>
                      <td><input type="checkbox" aria-label="Round column" checked={!!c.round} onChange={(e) => upd({ round: e.target.checked || undefined })} /></td>
                      <td><Cell table="c" row={i} col={6} value={c.H ?? ''} placeholder="3 m" title="Height for the head's bedding E A / H" onCommit={(v) => upd({ H: v.trim() || undefined })} /></td>
                      <td><Cell table="c" row={i} col={7} value={c.k ?? ''} placeholder="rigid" title="A spring stiffness instead (spread over the head when it has a size)" onCommit={(v) => upd({ k: v.trim() || undefined })} /></td>
                      {del(() => commit({ columns: region.columns.filter((q) => q.id !== c.id) }), `column ${c.name}`)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        {tab === 'loads' && (
          <table className="f3-table">
            <thead><tr><th>Load</th>{lc && <th>Case</th>}<th>Value</th><th>Where [{Lu}]</th><th /></tr></thead>
            <tbody>
              {region.loads.map((l, i) => {
                const geo = (keys: ('x1' | 'y1' | 'x2' | 'y2' | 'x' | 'y')[]) => (
                  <div className="f3-where">
                    {keys.map((key, k) => (
                      <span key={key} className="pl-at">{k === 2 && <span>→</span>}<Cell table="l" row={i} col={2 + k} value={(l as Record<string, string>)[key] ?? ''} title={`${key} (a bare number is ${Lu})`}
                        onCommit={(v) => updLoad(l.id, { [key]: v.trim() || '0' } as Partial<PlateLoad>)} /></span>
                    ))}
                  </div>
                );
                return (
                  <tr key={l.id} {...rowProps(l.id)}>
                    <td className="f3-kind">{l.type === 'area' ? 'Area (all)' : l.type === 'patch' ? 'Patch' : l.type === 'line' ? 'Line' : l.type === 'point' ? 'Point' : 'Self-weight'}</td>
                    {lc && (
                      <td>
                        <select value={loadCase(l, lc)} aria-label="Load case" onChange={(e) => updLoad(l.id, { case: e.target.value })}>
                          {lc.cases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                    )}
                    <td>
                      {l.type === 'self' ? (
                        <div className="f3-where"><span>ρ g t ×</span><Cell table="l" row={i} col={1} value={l.factor ?? ''} placeholder="1" title="Factor on the self-weight" onCommit={(v) => updLoad(l.id, { factor: v.trim() || undefined })} /></div>
                      ) : l.type === 'point' ? (
                        <Cell table="l" row={i} col={1} value={l.F} title={`Force, downwards (a bare number is ${F})`} onCommit={(v) => updLoad(l.id, { F: v.trim() || '0' })} />
                      ) : (
                        <Cell table="l" row={i} col={1} value={l.q} title={l.type === 'line' ? `Per length, downwards (a bare number is ${F}/${Lu})` : `Per area, downwards (a bare number is ${F}/${Lu}²)`} onCommit={(v) => updLoad(l.id, { q: v.trim() || '0' })} />
                      )}
                    </td>
                    <td>
                      {l.type === 'patch' || l.type === 'line' ? geo(['x1', 'y1', 'x2', 'y2']) : l.type === 'point' ? geo(['x', 'y']) : <span className="f3-muted">the whole plate</span>}
                    </td>
                    {del(() => commit({ loads: region.loads.filter((q) => q.id !== l.id) }), 'load')}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === 'results' && resultsTable()}
      </div>
      {tab !== 'results' && (
        <div className="f3-table-actions">
          {tab === 'outline' && (
            <>
              <button className="btn" onClick={addCorner}>+ Corner</button>
              <span className="hint">A new corner splits the selected edge. Paste x, y rows from Excel into a cell; edges run from each corner to the next.</span>
            </>
          )}
          {tab === 'openings' && <button className="btn" onClick={addOpening}>+ Opening</button>}
          {tab === 'supports' && (
            <>
              <button className="btn" onClick={addWall}>+ Wall</button>
              <button className="btn" onClick={addColumn}>+ Column</button>
            </>
          )}
          {tab === 'loads' && (
            <>
              <button className="btn" onClick={() => addLoad('area')}>+ Area load</button>
              <button className="btn" onClick={() => addLoad('patch')}>+ Patch</button>
              <button className="btn" onClick={() => addLoad('line')}>+ Line load</button>
              <button className="btn" onClick={() => addLoad('point')}>+ Point load</button>
              <button className="btn" onClick={() => addLoad('self')} disabled={region.loads.some((l) => l.type === 'self' && (!lc || loadCase(l, lc) === newCase))}>+ Self-weight</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export { parseCorners };
