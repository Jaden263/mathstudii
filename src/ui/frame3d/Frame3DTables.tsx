// The tables of a 3-D frame region while it is edited: nodes, members, sections,
// supports and loads, spreadsheet-like (Enter and the arrow keys move between rows,
// pasting rows from Excel adds them), and the results of what is shown.
import { useEffect, useState, type Dispatch, type ReactNode } from 'react';
import { Copy, Trash2 } from 'lucide-react';
import type { Frame3DRegion } from '../../model/types';
import type { Frame3DResult } from '../../frame3d/evaluate';
import { materialValues, profileValues } from '../../frame3d/evaluate';
import { boundExtremes, type ForceKey, type Reaction3 } from '../../frame3d/solve';
import {
  DIRS, RELEASES, RELEASE_PRESETS, SUPPORT_PRESETS, frameId, nextName, removeFrameItems,
  type F3Dir, type F3Load, type F3Member, type F3Node, type F3Section, type F3Support, type Frame3DData, type Frame3DTab, type ReleaseName,
} from '../../frame3d/model';
import { loadCase } from '../../beam/model';
import { ROLLED_SECTIONS } from '../../engine/sections';
import { CONCRETE_GRADES, STEEL_GRADES, TIMBER_GRADES } from '../../engine/materials';
import { parseDelimited, toTsv } from '../../model/tableData';
import type { Action } from '../store';
import { useSketchUI } from '../sketch/context';
import { LENGTH_M, FORCE_N, fmt } from '../beam/beamDraw';

const TABS: { id: Frame3DTab; label: string }[] = [
  { id: 'nodes', label: 'Nodes' },
  { id: 'members', label: 'Members' },
  { id: 'sections', label: 'Sections' },
  { id: 'supports', label: 'Supports' },
  { id: 'loads', label: 'Loads' },
  { id: 'results', label: 'Results' },
];

const PROFILE_HINTS = [...ROLLED_SECTIONS, 'CHS 60.3x4', 'CHS 114.3x5', 'CHS 168.3x6.3', 'SHS 100x5', 'SHS 150x8', 'RHS 200x100x6.3', 'RHS 300x200x10'];
const MATERIALS = [...STEEL_GRADES, ...CONCRETE_GRADES, ...TIMBER_GRADES];

/** A table cell: commits on Enter or leaving it; Enter and ↑ ↓ move along the column; a pasted block goes to `onGrid`. */
export function Cell({ value, onCommit, table, row, col, placeholder, title, list, onGrid, readOnly }: {
  value: string; onCommit: (v: string) => void; table: string; row: number; col: number; placeholder?: string; title?: string; list?: string;
  onGrid?: (grid: string[][]) => void; readOnly?: boolean;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onCommit(v);
  const move = (dr: number) => {
    const el = document.querySelector<HTMLInputElement>(`input[data-f3t="${table}"][data-r="${row + dr}"][data-c="${col}"]`);
    el?.focus();
    el?.select();
  };
  return (
    <input
      className="mono" value={v} placeholder={placeholder} title={title} list={list} spellCheck={false} readOnly={readOnly}
      data-f3t={table} data-r={row} data-c={col} aria-label={title ?? placeholder ?? table}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onPaste={(e) => {
        const text = e.clipboardData.getData('text/plain');
        if (!onGrid || !/[\t\n]/.test(text.trim())) return;
        e.preventDefault();
        onGrid(parseDelimited(text));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.altKey)) {
          e.preventDefault();
          commit();
          move(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          setV(value);
        }
      }}
    />
  );
}

export function Frame3DTables({ region, result, dispatch, height }: { region: Frame3DRegion; result?: Frame3DResult; dispatch: Dispatch<Action>; height: number }) {
  const { ui, setUi } = useSketchUI();
  const tab = region.tab ?? 'nodes';
  const data: Frame3DData = { nodes: region.nodes, members: region.members, sections: region.sections, supports: region.supports, loads: region.loads };
  const commit = (patch: Partial<Frame3DData>) => dispatch({ type: 'update', id: region.id, patch });
  const sel = new Set(ui.regionId === region.id ? ui.selected : []);
  const pick = (id: string) => setUi({ regionId: region.id, selected: [id] });
  const err = (id: string) => result?.errors[id];
  const Lu = region.lengthUnit, F = region.forceUnit;
  const nodeName = new Map(region.nodes.map((n) => [n.id, n.name]));
  const byName = (name: string) => region.nodes.find((n) => n.name === name.trim())?.id;
  const remove = (id: string) => {
    commit(removeFrameItems(data, new Set([id])));
    if (sel.has(id)) setUi({ selected: [] });
  };
  const del = (id: string, what: string) => <td className="f3-del"><button className="icon-btn" aria-label={`Remove ${what}`} title="Remove" onClick={() => remove(id)}><Trash2 size={12} /></button></td>;
  const rowProps = (id: string) => ({ className: `${sel.has(id) ? 'sel' : ''}${err(id) ? ' err' : ''}`, title: err(id), onClick: () => pick(id) });

  // ------------------------------------------------------------ nodes

  const updNode = (id: string, patch: Partial<F3Node>) => commit({ nodes: region.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
  const NODE_COLS = ['name', 'x', 'y', 'z'] as const;
  const pasteNodes = (row: number, col: number, grid: string[][]) => {
    const nodes = [...region.nodes];
    grid.forEach((cells, i) => {
      const k = row + i;
      if (k >= nodes.length) nodes.push({ id: frameId('n'), name: nextName('N', nodes), x: '0', y: '0', z: '0' });
      const n = { ...nodes[k] };
      cells.forEach((c, j) => {
        const key = NODE_COLS[col + j];
        if (key && c.trim()) n[key] = c.trim();
      });
      nodes[k] = n;
    });
    commit({ nodes });
  };
  const addNode = () => {
    const last = region.nodes[region.nodes.length - 1];
    const k = LENGTH_M[Lu] ?? 1, at = last && result?.pos[last.id];
    const n: F3Node = { id: frameId('n'), name: nextName('N', region.nodes), x: last?.x ?? '0', y: last?.y ?? '0', z: last ? bump(last.z, at ? at[2] / k : undefined, 3 / k) : '0' };
    commit({ nodes: [...region.nodes, n] });
    pick(n.id);
  };

  // ------------------------------------------------------------ members

  const updMember = (id: string, patch: Partial<F3Member>) => commit({ members: region.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const parseRel = (src: string): ReleaseName[] | undefined => {
    const preset = RELEASE_PRESETS.find((p) => p.label === src.trim());
    if (preset) return preset.rel.length ? [...preset.rel] : undefined;
    const names = src.split(/[\s,;]+/).map((t) => RELEASES.find((r) => r.toLowerCase() === t.toLowerCase())).filter((r): r is ReleaseName => !!r);
    return names.length ? [...new Set(names)] : undefined;
  };
  const pasteMembers = (row: number, col: number, grid: string[][]) => {
    const members = [...region.members];
    grid.forEach((cells, i) => {
      const k = row + i;
      if (k >= members.length) members.push({ id: frameId('m'), name: nextName('M', members), a: region.nodes[0]?.id ?? '', b: region.nodes[1]?.id ?? '', section: region.sections[0]?.id ?? '' });
      const m = { ...members[k] };
      cells.forEach((c, j) => {
        const v = c.trim();
        switch (col + j) {
          case 0: if (v) m.name = v; break;
          case 1: m.a = byName(v) ?? m.a; break;
          case 2: m.b = byName(v) ?? m.b; break;
          case 3: m.section = region.sections.find((s) => s.name === v || s.profile === v)?.id ?? m.section; break;
          case 4: m.beta = v || undefined; break;
        }
      });
      members[k] = m;
    });
    commit({ members });
  };
  const addMember = () => {
    const n = region.nodes, last = region.members[region.members.length - 1];
    const m: F3Member = {
      id: frameId('m'), name: nextName('M', region.members), a: n[n.length - 2]?.id ?? n[0]?.id ?? '', b: n[n.length - 1]?.id ?? '',
      section: last?.section ?? region.sections[0]?.id ?? '',
    };
    commit({ members: [...region.members, m] });
    pick(m.id);
  };
  const nodeSelect = (value: string, onChange: (id: string) => void, label: string) => (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {!region.nodes.some((n) => n.id === value) && <option value={value}>—</option>}
      {region.nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
    </select>
  );

  // ------------------------------------------------------------ sections

  const updSection = (id: string, patch: Partial<F3Section>) => commit({ sections: region.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  /** A value typed over a profile's makes the section custom, with the profile's other values kept. */
  const editGeometry = (s: F3Section, key: keyof F3Section, v: string) => {
    if (!s.profile) return updSection(s.id, { [key]: v.trim() || undefined });
    let base: Partial<F3Section> = {};
    try {
      const p = profileValues(s.profile);
      const cm = (x: number | undefined, pow: number) => (x === undefined ? undefined : `${+(x * 100 ** pow).toPrecision(5)}`);
      base = { A: cm(p.A, 2), Iy: cm(p.Iy, 4), Iz: cm(p.Iz, 4), It: cm(p.It, 4), Avy: cm(p.Avy, 2), Avz: cm(p.Avz, 2), Wy: cm(p.Wy, 3), Wz: cm(p.Wz, 3) };
    } catch {
      // an unknown profile: start from the values typed
    }
    updSection(s.id, { ...base, profile: undefined, name: s.name, [key]: v.trim() || undefined });
  };
  const shownGeometry = (s: F3Section) => {
    if (!s.profile) return null;
    try {
      const p = profileValues(s.profile);
      const cm = (x: number | undefined, pow: number) => (x === undefined ? '' : fmt(x * 100 ** pow));
      return { A: cm(p.A, 2), Iy: cm(p.Iy, 4), Iz: cm(p.Iz, 4), It: cm(p.It, 4), Avy: cm(p.Avy, 2), Avz: cm(p.Avz, 2) } as Record<string, string>;
    } catch {
      return null;
    }
  };
  const addSection = () => {
    const s: F3Section = { id: frameId('s'), name: nextName('S', region.sections), profile: 'IPE 300', material: 'S355' };
    commit({ sections: [...region.sections, s] });
    pick(s.id);
  };

  // ------------------------------------------------------------ supports

  const updSupport = (id: string, patch: Partial<F3Support>) => commit({ supports: region.supports.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const addSupport = () => {
    const free = region.nodes.find((n) => !region.supports.some((s) => s.node === n.id)) ?? region.nodes[0];
    if (!free) return;
    const s: F3Support = { id: frameId('p'), node: free.id, dofs: [...SUPPORT_PRESETS[0].dofs] };
    commit({ supports: [...region.supports, s] });
    pick(s.id);
  };

  // ------------------------------------------------------------ loads

  const updLoad = (id: string, patch: Partial<F3Load>) => commit({ loads: region.loads.map((l) => (l.id === id ? ({ ...l, ...patch } as F3Load) : l)) });
  const lc = region.loadCases;
  const newCase = lc ? (lc.cases.find((c) => c.id === lc.view)?.id ?? lc.cases[0]?.id) : undefined;
  const addLoad = (type: F3Load['type']) => {
    const c = newCase ? { case: newCase } : {};
    const node = region.nodes[region.nodes.length - 1]?.id ?? '', member = region.members[0]?.id ?? '';
    const l: F3Load = type === 'node' ? { id: frameId('l'), type, node, Fz: '-10', ...c }
      : type === 'point' ? { id: frameId('l'), type, member, at: '', dir: 'Z', value: '-10', ...c }
      : type === 'line' ? { id: frameId('l'), type, member, dir: 'Z', q1: '-5', ...c }
      : { id: frameId('l'), type, ...c };
    commit({ loads: [...region.loads, l] });
    pick(l.id);
  };
  const memberSelect = (value: string, onChange: (id: string) => void) => (
    <select value={value} aria-label="Member" onChange={(e) => onChange(e.target.value)}>
      {!region.members.some((m) => m.id === value) && <option value={value}>—</option>}
      {region.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
    </select>
  );

  // ------------------------------------------------------------ results

  const resultsTable = () => {
    const sol = result?.solution;
    if (!sol) return <p className="hint f3-pad">{result?.error ?? 'No results yet.'}</p>;
    const kN = FORCE_N[F] ?? 1e3, Lm = LENGTH_M[Lu] ?? 1, metric = Lu === 'm' || Lu === 'cm' || Lu === 'mm';
    const f = (v: number) => fmt(v / kN), mo = (v: number) => fmt(v / (kN * Lm)), d = (v: number) => fmt(metric ? v * 1000 : v / 0.0254);
    // the envelope: maxima from its upper side, minima from its lower one (a row each)
    const low = result?.lower;
    const reactions = sol.reactions.flatMap((r) => {
      const row = (q: Reaction3, tag: string) => [`${nodeName.get(q.node) ?? '?'}${tag}`, ...q.F.map(f), ...q.M.map(mo)];
      const lo = low?.reactions.find((q) => q.id === r.id);
      return lo ? [row(r, ' max'), row(lo, ' min')] : [row(r, '')];
    });
    const keys: ForceKey[] = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'];
    const extremes = sol.members.map((mr) => {
      const ex = boundExtremes(mr, low?.members.find((q) => q.id === mr.id)), m = region.members.find((q) => q.id === mr.id);
      return [m?.name ?? '?', ...keys.flatMap((k) => (k === 'N' || k === 'Vy' || k === 'Vz' ? [f(ex[k].max), f(ex[k].min)] : [mo(ex[k].max), mo(ex[k].min)]))];
    });
    // (a node no member uses is not part of the structure: no row)
    const displacements = region.nodes.filter((n) => sol.nodes[n.id]).flatMap((n) => {
      const row = (u: number[], tag: string) => [`${n.name}${tag}`, ...u.slice(0, 3).map(d), ...u.slice(3).map((x) => fmt(x * 1000))];
      const lo = low?.nodes[n.id];
      return lo ? [row(sol.nodes[n.id], ' max'), row(lo, ' min')] : [row(sol.nodes[n.id], '')];
    });
    const block = (title: string, head: string[], rows: string[][], key: string): ReactNode => (
      <div className="f3-result" key={key}>
        <h4>{title}<button className="icon-btn" title="Copy as a table (paste into Excel)" aria-label={`Copy ${title}`} onClick={() => void navigator.clipboard?.writeText(toTsv([head, ...rows]))}><Copy size={12} /></button></h4>
        <table className="f3-table ro">
          <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : ''}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    const dl = metric ? 'mm' : 'in';
    const alphas = result?.combos?.filter((c) => c.alpha !== undefined) ?? [];
    return (
      <>
        <p className="hint f3-pad">
          {result?.view === 'envelope' ? 'Envelope of the combinations (max and min). ' : ''}
          {sol.unknowns} unknowns, degree of indeterminacy {sol.indeterminacy}{result?.millis !== undefined ? `, solved in ${fmt(result.millis)} ms` : ''}
          {sol.secondOrder ? `, second order in ${sol.secondOrder.iterations} iterations` : ''}.
          {alphas.length > 0 && <> α<sub>cr</sub>: {alphas.map((c) => `${c.name} ${fmt(c.alpha!)}`).join(', ')}.</>}
        </p>
        {block('Reactions', ['Node', `Rx [${F}]`, `Ry [${F}]`, `Rz [${F}]`, `Mx [${F}·${Lu}]`, `My [${F}·${Lu}]`, `Mz [${F}·${Lu}]`], reactions, 'r')}
        {block('Member extremes (max, min)', ['Member', ...keys.flatMap((k) => {
          const unit = k === 'N' || k === 'Vy' || k === 'Vz' ? F : `${F}·${Lu}`;
          return [`${k} max [${unit}]`, `${k} min`];
        })], extremes, 'e')}
        {block('Node displacements', ['Node', `ux [${dl}]`, `uy [${dl}]`, `uz [${dl}]`, 'φx [mrad]', 'φy [mrad]', 'φz [mrad]'], displacements, 'd')}
      </>
    );
  };

  // ------------------------------------------------------------ render

  const count: Partial<Record<Frame3DTab, number>> = { nodes: region.nodes.length, members: region.members.length, sections: region.sections.length, supports: region.supports.length, loads: region.loads.length };
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
        <datalist id="f3-profiles">{PROFILE_HINTS.map((p) => <option key={p} value={p} />)}</datalist>
        <datalist id="f3-releases">{RELEASE_PRESETS.map((p) => <option key={p.id} value={p.rel.join(' ')}>{p.label}</option>)}</datalist>
        <datalist id="f3-dofs"><option value="fixed" /><option value="free" /></datalist>
        {tab === 'nodes' && (
          <table className="f3-table">
            <thead><tr><th>Name</th><th>X [{Lu}]</th><th>Y [{Lu}]</th><th>Z [{Lu}]</th><th /></tr></thead>
            <tbody>
              {region.nodes.map((n, i) => (
                <tr key={n.id} {...rowProps(n.id)}>
                  {NODE_COLS.map((key, c) => (
                    <td key={key}><Cell table="n" row={i} col={c} value={n[key]} title={key === 'name' ? 'Node name' : `${key.toUpperCase()} (a bare number is ${Lu})`}
                      onCommit={(v) => updNode(n.id, { [key]: v.trim() || (key === 'name' ? n.name : '0') })} onGrid={(g) => pasteNodes(i, c, g)} /></td>
                  ))}
                  {del(n.id, `node ${n.name}`)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'members' && (
          <table className="f3-table">
            <thead><tr><th>Name</th><th>Start</th><th>End</th><th>Section</th><th title="Rotation of the section about the member axis">β [°]</th><th title="End forces released at the start: N Vy Vz T My Mz">Released (start)</th><th>Released (end)</th><th>L [{Lu}]</th><th /></tr></thead>
            <tbody>
              {region.members.map((m, i) => {
                const geo = result?.geometry[m.id];
                return (
                  <tr key={m.id} {...rowProps(m.id)}>
                    <td><Cell table="m" row={i} col={0} value={m.name} title="Member name" onCommit={(v) => v.trim() && updMember(m.id, { name: v.trim() })} onGrid={(g) => pasteMembers(i, 0, g)} /></td>
                    <td>{nodeSelect(m.a, (a) => updMember(m.id, { a }), 'Start node')}</td>
                    <td>{nodeSelect(m.b, (b) => updMember(m.id, { b }), 'End node')}</td>
                    <td>
                      <select value={m.section} aria-label="Section" onChange={(e) => updMember(m.id, { section: e.target.value })}>
                        {!region.sections.some((s) => s.id === m.section) && <option value={m.section}>—</option>}
                        {region.sections.map((s) => <option key={s.id} value={s.id}>{s.name}{s.profile ? ` · ${s.profile}` : ''}</option>)}
                      </select>
                    </td>
                    <td><Cell table="m" row={i} col={4} value={m.beta ?? ''} placeholder="0" title="β: a bare number is degrees" onCommit={(v) => updMember(m.id, { beta: v.trim() || undefined })} /></td>
                    <td><Cell table="m" row={i} col={5} value={m.relA?.join(' ') ?? ''} placeholder="—" list="f3-releases" title="Released at the start: N Vy Vz T My Mz (My Mz = a hinge)" onCommit={(v) => updMember(m.id, { relA: parseRel(v) })} /></td>
                    <td><Cell table="m" row={i} col={6} value={m.relB?.join(' ') ?? ''} placeholder="—" list="f3-releases" title="Released at the end" onCommit={(v) => updMember(m.id, { relB: parseRel(v) })} /></td>
                    <td className="num">{geo ? fmt(geo.L / (LENGTH_M[Lu] ?? 1)) : ''}</td>
                    {del(m.id, `member ${m.name}`)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === 'sections' && (
          <table className="f3-table">
            <thead><tr>
              <th>Name</th><th title="Steel profile from the library; empty for your own values">Profile</th><th>Material</th>
              <th>A [cm²]</th><th title="Strong axis (the profile's y)">I<sub>y</sub> [cm⁴]</th><th>I<sub>z</sub> [cm⁴]</th><th title="St Venant torsion constant">I<sub>t</sub> [cm⁴]</th>
              <th title="Shear area for V_y (shear deformation)">A<sub>vy</sub> [cm²]</th><th title="Shear area for V_z">A<sub>vz</sub> [cm²]</th>
              <th>E [GPa]</th><th>G [GPa]</th><th>ρ [kg/m³]</th><th />
            </tr></thead>
            <tbody>
              {region.sections.map((s, i) => {
                const geo = shownGeometry(s);
                let mat: { E: string; G: string; rho: string } | null = null;
                if (s.material !== 'custom') {
                  try {
                    const v = materialValues(s.material);
                    mat = { E: fmt(v.E / 1e9), G: fmt(v.G / 1e9), rho: fmt(v.rho) };
                  } catch {
                    mat = null;
                  }
                }
                const gcell = (key: 'A' | 'Iy' | 'Iz' | 'It' | 'Avy' | 'Avz', c: number) => (
                  <td className={geo ? 'derived' : ''}><Cell table="s" row={i} col={c} value={geo ? geo[key] : s[key] ?? ''} placeholder={key === 'Avy' || key === 'Avz' ? '5/6 A' : ''}
                    title={geo ? `From the profile; typing a value makes the section custom` : 'A value or expression; bare numbers in cm units'} onCommit={(v) => editGeometry(s, key, v)} /></td>
                );
                const mcell = (key: 'E' | 'G' | 'rho', c: number) => (
                  <td className={mat ? 'derived' : ''}><Cell table="s" row={i} col={c} value={mat ? mat[key] : s[key] ?? ''} readOnly={!!mat} placeholder={key === 'G' ? 'E/2.6' : key === 'rho' ? '0' : ''}
                    title={mat ? `From ${s.material}; choose Custom to type your own` : key === 'rho' ? 'Density for the self-weight (bare number kg/m³)' : 'A bare number is GPa'}
                    onCommit={(v) => updSection(s.id, { [key]: v.trim() || undefined })} /></td>
                );
                return (
                  <tr key={s.id} {...rowProps(s.id)}>
                    <td><Cell table="s" row={i} col={0} value={s.name} title="Section name" onCommit={(v) => v.trim() && updSection(s.id, { name: v.trim() })} /></td>
                    <td><Cell table="s" row={i} col={1} value={s.profile ?? ''} placeholder="custom" list="f3-profiles" title="IPE 300, HEB 200, CHS 168.3x6.3, RHS 200x100x6.3 …; empty for your own values" onCommit={(v) => updSection(s.id, { profile: v.trim() || undefined })} /></td>
                    <td>
                      <select value={s.material} aria-label="Material" onChange={(e) => updSection(s.id, { material: e.target.value, ...(e.target.value === 'custom' && mat ? { E: `${mat.E} GPa`, G: `${mat.G} GPa`, rho: `${mat.rho} kg/m^3` } : {}) })}>
                        {!MATERIALS.includes(s.material) && s.material !== 'custom' && <option value={s.material}>{s.material}</option>}
                        <optgroup label="Steel">{STEEL_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}</optgroup>
                        <optgroup label="Concrete">{CONCRETE_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}</optgroup>
                        <optgroup label="Timber">{TIMBER_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}</optgroup>
                        <option value="custom">Custom E, G, ρ</option>
                      </select>
                    </td>
                    {gcell('A', 3)}{gcell('Iy', 4)}{gcell('Iz', 5)}{gcell('It', 6)}{gcell('Avy', 7)}{gcell('Avz', 8)}
                    {mcell('E', 9)}{mcell('G', 10)}{mcell('rho', 11)}
                    {del(s.id, `section ${s.name}`)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === 'supports' && (
          <table className="f3-table">
            <thead><tr><th>Node</th><th>Type</th>{['ux', 'uy', 'uz', 'φx', 'φy', 'φz'].map((h) => <th key={h} title={`fixed, free, or a spring stiffness (bare number ${h[0] === 'u' ? `${F}/${Lu}` : `${F}·${Lu}/rad`})`}>{h}</th>)}<th /></tr></thead>
            <tbody>
              {region.supports.map((s, i) => {
                const preset = SUPPORT_PRESETS.find((p) => p.dofs.every((d, k) => d === (s.dofs[k] || 'free')));
                return (
                  <tr key={s.id} {...rowProps(s.id)}>
                    <td>{nodeSelect(s.node, (node) => updSupport(s.id, { node }), 'Supported node')}</td>
                    <td>
                      <select value={preset?.id ?? 'custom'} aria-label="Support type" onChange={(e) => {
                        const p = SUPPORT_PRESETS.find((q) => q.id === e.target.value);
                        if (p) updSupport(s.id, { dofs: [...p.dofs] });
                      }}>
                        {SUPPORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                        {!preset && <option value="custom">Custom</option>}
                      </select>
                    </td>
                    {[0, 1, 2, 3, 4, 5].map((k) => (
                      <td key={k} className={`f3-dof ${s.dofs[k] === 'fixed' ? 'held' : s.dofs[k] && s.dofs[k] !== 'free' ? 'spring' : ''}`}>
                        <Cell table="p" row={i} col={k + 2} value={s.dofs[k] ?? 'free'} list="f3-dofs" title="fixed, free, or a spring stiffness"
                          onCommit={(v) => updSupport(s.id, { dofs: s.dofs.map((d, q) => (q === k ? v.trim() || 'free' : d)) })} />
                      </td>
                    ))}
                    {del(s.id, 'support')}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {tab === 'loads' && (
          <table className="f3-table">
            <thead><tr><th>Load</th><th>On</th>{lc && <th>Case</th>}<th>Direction</th><th>Value</th><th>Where</th><th /></tr></thead>
            <tbody>
              {region.loads.map((l, i) => (
                <tr key={l.id} {...rowProps(l.id)}>
                  <td className="f3-kind">{l.type === 'node' ? 'Node' : l.type === 'point' ? (l.moment ? 'Moment' : 'Point') : l.type === 'line' ? 'Line' : 'Self-weight'}</td>
                  <td>{l.type === 'node' ? nodeSelect(l.node, (node) => updLoad(l.id, { node }), 'Loaded node') : l.type === 'self' ? <span className="f3-muted">all members</span> : memberSelect(l.member, (member) => updLoad(l.id, { member }))}</td>
                  {lc && (
                    <td>
                      <select value={loadCase(l, lc)} aria-label="Load case" onChange={(e) => updLoad(l.id, { case: e.target.value })}>
                        {lc.cases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                  )}
                  {l.type === 'node' && (
                    <td colSpan={3}><div className="f3-six">
                      {(['Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz'] as const).map((k, c) => (
                        <label key={k}><span>{k}</span><Cell table="l" row={i} col={3 + c} value={l[k] ?? ''} placeholder="0" title={`${k} (a bare number is ${k[0] === 'F' ? F : `${F}·${Lu}`})`} onCommit={(v) => updLoad(l.id, { [k]: v.trim() || undefined })} /></label>
                      ))}
                    </div></td>
                  )}
                  {(l.type === 'point' || l.type === 'line') && (
                    <td>
                      <select value={l.dir} aria-label="Direction" title="Global X, Y, Z or the member's x, y, z" onChange={(e) => updLoad(l.id, { dir: e.target.value as F3Dir })}>
                        {DIRS.map((d) => <option key={d} value={d}>{d === d.toUpperCase() ? `${d} (global)` : `${d} (member)`}</option>)}
                      </select>
                      {l.type === 'point' && (
                        <select value={l.moment ? 'M' : 'F'} aria-label="Force or moment" onChange={(e) => updLoad(l.id, { moment: e.target.value === 'M' || undefined })}>
                          <option value="F">force</option><option value="M">moment</option>
                        </select>
                      )}
                      {l.type === 'line' && l.dir === l.dir.toUpperCase() && (
                        <label className="f3-check" title="Per length projected across the load (snow on a slope), instead of per length of member">
                          <input type="checkbox" checked={!!l.projected} onChange={(e) => updLoad(l.id, { projected: e.target.checked || undefined })} /> projected
                        </label>
                      )}
                    </td>
                  )}
                  {l.type === 'point' && (
                    <>
                      <td><Cell table="l" row={i} col={4} value={l.value} title={`A bare number is ${l.moment ? `${F}·${Lu}` : F}`} onCommit={(v) => updLoad(l.id, { value: v.trim() || '0' })} /></td>
                      <td><div className="f3-where"><span>at</span><Cell table="l" row={i} col={5} value={l.at} placeholder="middle" title={`Distance from the member's start (a bare number is ${Lu}); empty = the middle`} onCommit={(v) => updLoad(l.id, { at: v.trim() })} /></div></td>
                    </>
                  )}
                  {l.type === 'line' && (
                    <>
                      <td><div className="f3-where">
                        <Cell table="l" row={i} col={4} value={l.q1} title={`Start value (a bare number is ${F}/${Lu})`} onCommit={(v) => updLoad(l.id, { q1: v.trim() || '0' })} />
                        <span>→</span>
                        <Cell table="l" row={i} col={5} value={l.q2 ?? ''} placeholder="same" title="End value (empty: uniform)" onCommit={(v) => updLoad(l.id, { q2: v.trim() || undefined })} />
                      </div></td>
                      <td><div className="f3-where">
                        <Cell table="l" row={i} col={6} value={l.from ?? ''} placeholder="start" title={`From (distance from the member's start, ${Lu}); empty = its start`} onCommit={(v) => updLoad(l.id, { from: v.trim() || undefined })} />
                        <span>–</span>
                        <Cell table="l" row={i} col={7} value={l.to ?? ''} placeholder="end" title="To; empty = its end" onCommit={(v) => updLoad(l.id, { to: v.trim() || undefined })} />
                      </div></td>
                    </>
                  )}
                  {l.type === 'self' && (
                    <>
                      <td><span className="f3-muted">−Z</span></td>
                      <td><div className="f3-where"><span>×</span><Cell table="l" row={i} col={4} value={l.factor ?? ''} placeholder="1" title="Factor on ρ g A" onCommit={(v) => updLoad(l.id, { factor: v.trim() || undefined })} /></div></td>
                      <td />
                    </>
                  )}
                  {del(l.id, 'load')}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'results' && resultsTable()}
      </div>
      {tab !== 'results' && (
        <div className="f3-table-actions">
          {tab === 'nodes' && <button className="btn" onClick={addNode}>+ Node</button>}
          {tab === 'members' && <button className="btn" onClick={addMember} disabled={region.nodes.length < 2}>+ Member</button>}
          {tab === 'sections' && <button className="btn" onClick={addSection}>+ Section</button>}
          {tab === 'supports' && <button className="btn" onClick={addSupport} disabled={!region.nodes.length}>+ Support</button>}
          {tab === 'loads' && (
            <>
              <button className="btn" onClick={() => addLoad('node')} disabled={!region.nodes.length}>+ Node load</button>
              <button className="btn" onClick={() => addLoad('point')} disabled={!region.members.length}>+ Point load</button>
              <button className="btn" onClick={() => addLoad('line')} disabled={!region.members.length}>+ Line load</button>
              <button className="btn" onClick={() => addLoad('self')} disabled={region.loads.some((l) => l.type === 'self' && (!lc || loadCase(l, lc) === newCase))}>+ Self-weight</button>
            </>
          )}
          {(tab === 'nodes' || tab === 'members') && <span className="hint">Paste rows from Excel into a cell ({tab === 'nodes' ? 'name, X, Y, Z' : 'name, start, end, section, β'}); Enter and ↑ ↓ move along a column.</span>}
        </div>
      )}
    </div>
  );
}

/**
 * A storey (3 m, `step` in the region's unit) above a coordinate: "4.5" → "7.5". An
 * expression ("h", which may carry units) goes by its evaluated value, else stays as it is.
 */
function bump(z: string, value: number | undefined, step: number): string {
  const n = Number(z), d = +step.toPrecision(10);
  if (Number.isFinite(n)) return String(+(n + d).toPrecision(10));
  return value !== undefined && Number.isFinite(value) ? String(+(value + d).toPrecision(10)) : z;
}
