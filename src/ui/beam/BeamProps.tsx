// Side panel of a beam region: units and the default section, the selected member,
// support, load or node, and the results (reactions and extreme values).
import type { Dispatch, ReactNode } from 'react';
import { RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import type { BeamRegion } from '../../model/types';
import type { BeamResult } from '../../beam/evaluate';
import { straightBeam } from '../../beam/evaluate';
import {
  PROFILES, beamId, defaultCases, loadCase, profileSection, removeItems,
  type BeamCases, type BeamData, type BeamLoad, type BeamMember, type BeamMovingLoad, type BeamSection, type BeamSupport,
} from '../../beam/model';
import type { Action } from '../store';
import { useSketchUI } from '../sketch/context';
import { LazyInput } from '../sketch/SketchProps';
import { LENGTH_M, fmt, units } from './beamDraw';
import { AnalysisOptions, MaterialField, ShearFields, StabilityResults } from './BeamAnalysis';
import { TrafficProps } from './BeamTraffic';
import { BeamUnitsFields, QtyInput } from './BeamUnits';

/** An expression field with the unit its bare numbers are in written after it. */
function UnitField({ unit, children }: { unit: string; children: ReactNode }) {
  return <span className="bm-qty">{children}<span className="bm-qty-unit">{unit}</span></span>;
}

function SectionFields({ s, onChange, shear = false, si }: {
  s: BeamSection; onChange: (s: BeamSection) => void;
  /** Shear deformation is on: show G and the shear area. */
  shear?: boolean;
  si?: { G?: number; Av?: number };
}) {
  const known = PROFILES.find((p) => p.name === s.label);
  return (
    <>
      <label className="field">
        <span>Profile</span>
        <select value={known ? known.name : 'custom'} onChange={(e) => {
          const p = profileSection(e.target.value, s.E);
          // a new profile keeps the material; its shear area follows the profile again
          if (p) onChange({ ...p, material: s.material, grade: s.grade, G: s.G });
          else onChange({ ...s, label: undefined });
        }}>
          {PROFILES.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          <option value="custom">Custom values</option>
        </select>
      </label>
      <MaterialField s={s} onChange={onChange} />
      <div className="row2">
        <label className="field" title="Young's modulus; a bare number is GPa"><span>E</span><UnitField unit="GPa"><LazyInput label="E" value={s.E} onCommit={(v) => onChange({ ...s, E: v.trim() })} /></UnitField></label>
        <label className="field" title="Area; a bare number is cm²"><span>A</span><UnitField unit="cm²"><LazyInput label="A" value={s.A} onCommit={(v) => onChange({ ...s, A: v.trim(), label: undefined })} /></UnitField></label>
      </div>
      <div className="row2">
        <label className="field" title="Second moment of area; a bare number is cm⁴"><span>I</span><UnitField unit="cm⁴"><LazyInput label="I" value={s.I} onCommit={(v) => onChange({ ...s, I: v.trim(), label: undefined })} /></UnitField></label>
        <label className="field" title="Section modulus for the bending stress (optional); a bare number is cm³"><span>W</span><UnitField unit="cm³"><LazyInput label="W" value={s.W ?? ''} placeholder="optional" onCommit={(v) => onChange({ ...s, W: v.trim() || undefined, label: undefined })} /></UnitField></label>
      </div>
      {shear && <ShearFields s={s} onChange={onChange} si={si} />}
    </>
  );
}

/** Load cases and combinations: add, rename, factors (moving loads too), ULS / SLS. */
export function LoadCases({ lc, onChange, loads, moving = [], start }: {
  lc?: BeamCases; onChange: (lc: BeamCases | undefined) => void; loads: { case?: string }[]; moving?: BeamMovingLoad[];
  /** The cases and combinations a region starts with (default: G, Q, ULS, SLS). */
  start?: () => BeamCases;
}) {
  if (!lc) {
    return (
      <>
        <button className="btn" onClick={() => onChange((start ?? defaultCases)())}>Use load cases &amp; combinations</button>
        <p className="hint">Split the loads into cases (G permanent, Q imposed, wind …) and combine them with factors: ULS 1.35 G + 1.5 Q, SLS G + Q, and the envelope.</p>
      </>
    );
  }
  const setCase = (id: string, patch: Partial<BeamCases['cases'][number]>) => onChange({ ...lc, cases: lc.cases.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const setCombo = (id: string, patch: Partial<BeamCases['combos'][number]>) => onChange({ ...lc, combos: lc.combos.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const count = (id: string) => loads.filter((l) => loadCase(l, lc) === id).length;
  const addCase = () => {
    const used = new Set(lc.cases.map((c) => c.name));
    const name = ['W', 'S', 'Q2', 'T', 'A'].find((n) => !used.has(n)) ?? `C${lc.cases.length + 1}`;
    const id = beamId('c');
    onChange({ ...lc, cases: [...lc.cases, { id, name, label: name === 'W' ? 'Wind' : name === 'S' ? 'Snow' : '' }] });
  };
  const addCombo = () => {
    const id = beamId('k');
    onChange({ ...lc, combos: [...lc.combos, { id, name: `ULS${lc.combos.length + 1}`, kind: 'ULS', factors: Object.fromEntries(lc.cases.map((c) => [c.id, '1'])) }] });
  };
  return (
    <>
      <table className="props-table bm-cases">
        <thead><tr><th>Case</th><th>Description</th><th>Loads</th><th /></tr></thead>
        <tbody>
          {lc.cases.map((c) => (
            <tr key={c.id}>
              <td><LazyInput label="Case name" value={c.name} onCommit={(v) => v.trim() && setCase(c.id, { name: v.trim() })} /></td>
              <td><LazyInput label="Case description" mono={false} value={c.label ?? ''} placeholder="—" onCommit={(v) => setCase(c.id, { label: v.trim() || undefined })} /></td>
              <td className="num">{count(c.id)}</td>
              <td>{lc.cases.length > 1 && <button className="icon-btn" aria-label={`Remove case ${c.name}`} title="Remove (its loads move to the first case)" onClick={() => onChange({ ...lc, cases: lc.cases.filter((q) => q.id !== c.id) })}><Trash2 size={12} /></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn" onClick={addCase}>+ Load case</button>
      <table className="props-table bm-combos">
        <thead><tr><th>Combination</th><th />{[...lc.cases, ...moving].map((c) => <th key={c.id}>γ {c.name}</th>)}<th /></tr></thead>
        <tbody>
          {lc.combos.map((k) => (
            <tr key={k.id}>
              <td><LazyInput label="Combination name" value={k.name} onCommit={(v) => v.trim() && setCombo(k.id, { name: v.trim() })} /></td>
              <td>
                <select aria-label="Kind" value={k.kind} onChange={(e) => setCombo(k.id, { kind: e.target.value as 'ULS' | 'SLS' })} title="ULS: strength (forces, reactions); SLS: deflection">
                  <option value="ULS">ULS</option><option value="SLS">SLS</option>
                </select>
              </td>
              {[...lc.cases, ...moving].map((c) => (
                <td key={c.id}><LazyInput label={`Factor for ${c.name}`} value={k.factors[c.id] ?? ''} placeholder="0" onCommit={(v) => setCombo(k.id, { factors: { ...k.factors, [c.id]: v.trim() } })} /></td>
              ))}
              <td>{lc.combos.length > 1 && <button className="icon-btn" aria-label={`Remove ${k.name}`} onClick={() => onChange({ ...lc, combos: lc.combos.filter((q) => q.id !== k.id), view: lc.view === k.id ? undefined : lc.view })}><Trash2 size={12} /></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row2">
        <button className="btn" onClick={addCombo}>+ Combination</button>
        <button className="btn" onClick={() => onChange(undefined)} title="All loads act together again">Stop using cases</button>
      </div>
      <p className="hint">Factors are numbers or worksheet expressions (γ_G, ψ_0 …). The envelope takes N, V and M over the ULS combinations and the deflection over the SLS ones; the worksheet gets the governing values, plus <code>.combos.ULS</code> and <code>.cases.G</code> for each one.{moving.length ? <> A moving load adds its factored extremes to the combination, which then has two bounds (<code>.combos.ULS.min</code> the lower).</> : null}</p>
    </>
  );
}

const DIRECTIONS: [number, string][] = [[-90, 'Down ↓'], [90, 'Up ↑'], [0, 'Right →'], [180, 'Left ←']];

export function BeamProps({ region, result, dispatch }: { region: BeamRegion; result?: BeamResult; dispatch: Dispatch<Action> }) {
  const { ui, setUi } = useSketchUI();
  const set = (patch: Partial<BeamRegion>, key = 'beam') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const data: BeamData = { nodes: region.nodes, members: region.members, supports: region.supports, loads: region.loads };
  const sel = ui.regionId === region.id ? ui.selected : [];
  const one = sel.length === 1 ? sel[0] : null;
  const member = region.members.find((m) => m.id === one);
  const support = region.supports.find((s) => s.id === one);
  const load = region.loads.find((l) => l.id === one);
  const node = region.nodes.find((q) => q.id === one);
  const u = units(region);
  const sol = result?.solution;
  const name = region.name.trim() || 'beam';
  const N = new Map(region.nodes.map((q) => [q.id, q]));
  const memberLength = (m: BeamMember) => {
    const a = N.get(m.a), b = N.get(m.b);
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  };
  const updMember = (patch: Partial<BeamMember>) => set({ members: region.members.map((m) => (m.id === one ? { ...m, ...patch } : m)) }, `m:${one}`);
  const updSupport = (patch: Partial<BeamSupport>) => set({ supports: region.supports.map((s) => (s.id === one ? { ...s, ...patch } : s)) }, `s:${one}`);
  const updLoad = (patch: Partial<BeamLoad>) => set({ loads: region.loads.map((l) => (l.id === one ? ({ ...l, ...patch } as BeamLoad) : l)) }, `l:${one}`);
  const remove = () => {
    dispatch({ type: 'update', id: region.id, patch: removeItems(data, new Set(sel)) });
    setUi({ selected: [] });
  };
  const straight = straightBeam(region);
  const err = (id: string) => result?.errors[id] && <div className="region-error">{result.errors[id]}</div>;
  const onMember = (l: BeamLoad) => (l.type === 'line' ? region.members.find((m) => m.id === l.member) : 'member' in l.at ? region.members.find((m) => m.id === (l.at as { member: string }).member) : undefined);

  return (
    <div className="props">
      <h3 className="sub">Beam / frame</h3>
      <label className="field">
        <span>Variable for the results</span>
        <LazyInput label="Variable name" value={region.name} placeholder="e.g. b" onCommit={(v) => set({ name: v.trim() }, 'name')} />
      </label>
      <p className="hint">
        With a name the math below can use <code>{name}.A.Ry</code> (reactions per support), <code>{name}.M_max</code>, <code>{name}.V_max</code>, <code>{name}.w_max</code>
        {region.section.W || region.members.some((m) => m.section?.W) ? <>, <code>{name}.σ_max</code></> : null}
        {straight ? <> and the functions <code>{name}.M(x)</code>, <code>{name}.V(x)</code>, <code>{name}.w(x)</code> for plots</> : null}
        {region.analysis?.buckling || region.analysis?.secondOrder ? <>, <code>{name}.alpha_cr</code> and <code>{name}.L_cr</code></> : null}.
        Loads and sections accept worksheet expressions.
      </p>
      <h3 className="sub">Units</h3>
      <BeamUnitsFields region={region} result={result} dispatch={dispatch} />
      <label className="field" title="Spacing of the grid that points snap to"><span>Grid</span>
        <QtyInput label="Grid" value={region.grid} unit={region.lengthUnit} onCommit={(v) => set({ grid: Math.max(0, v) }, 'grid')} />
      </label>

      {member && (
        <>
          <h3 className="sub">Member {region.members.indexOf(member) + 1} · {u.length(memberLength(member))}</h3>
          {err(member.id)}
          <label className="check"><input type="checkbox" checked={!!member.hingeA} onChange={(e) => updMember({ hingeA: e.target.checked || undefined })} /> Hinge at the start</label>
          <label className="check"><input type="checkbox" checked={!!member.hingeB} onChange={(e) => updMember({ hingeB: e.target.checked || undefined })} /> Hinge at the end</label>
          <p className="hint">Both ends hinged: a truss bar (axial force only).</p>
          <label className="check" title="Moving loads travel along the members marked (with none marked: the horizontal ones)"><input type="checkbox" checked={!!member.deck} onChange={(e) => updMember({ deck: e.target.checked || undefined })} /> Load path (deck) for moving loads</label>
          <label className="check"><input type="checkbox" checked={!!member.section} onChange={(e) => updMember({ section: e.target.checked ? { ...region.section } : undefined })} /> Own section</label>
          {member.section && <SectionFields s={member.section} shear={!!region.analysis?.shear} si={result?.memberSections?.[member.id]} onChange={(s) => updMember({ section: s })} />}
          {(() => {
            const Lcr = (result?.buckling ?? result?.staticBuckling)?.Lcr[member.id];
            return Lcr !== undefined && <p className="hint">Buckling length in the lowest mode: L<sub>cr</sub> = {u.length(Lcr / (LENGTH_M[region.lengthUnit] ?? 1))}.</p>;
          })()}
        </>
      )}
      {support && (
        <>
          <h3 className="sub">Support {support.label}</h3>
          <div className="row2">
            <label className="field"><span>Type</span>
              <select value={support.type} onChange={(e) => updSupport({ type: e.target.value as BeamSupport['type'] })}>
                <option value="pin">Pinned (x, y)</option><option value="roller">Roller (one direction)</option><option value="fixed">Fixed (x, y, rotation)</option>
              </select>
            </label>
            <label className="field"><span>Name</span><LazyInput label="Support name" mono={false} value={support.label} onCommit={(v) => v.trim() && updSupport({ label: v.trim() })} /></label>
          </div>
          {err(support.id)}
          <div className="row2">
            <label className="field" title={`Spring along the support axis; empty = rigid. A bare number is ${region.forceUnit}/${region.lengthUnit}`}>
              <span>Spring k</span>
              <UnitField unit={`${region.forceUnit}/${region.lengthUnit}`}><LazyInput label="Spring stiffness" value={support.k ?? ''} placeholder="rigid" onCommit={(v) => updSupport({ k: v.trim() || undefined })} /></UnitField>
            </label>
            <label className="field" title="Settlement along the support axis (down for a support on the ground); a bare number is mm">
              <span>Settlement</span>
              <UnitField unit="mm"><LazyInput label="Settlement" value={support.settle ?? ''} placeholder="0" onCommit={(v) => updSupport({ settle: v.trim() || undefined })} /></UnitField>
            </label>
          </div>
          {support.type === 'fixed' && (
            <label className="field" title={`Rotational spring (semi-rigid foot); empty = fully fixed. A bare number is ${region.forceUnit}·${region.lengthUnit}/rad`}>
              <span>Rotational spring k<sub>θ</sub></span>
              <UnitField unit={`${region.forceUnit}·${region.lengthUnit}/rad`}><LazyInput label="Rotational spring" value={support.kr ?? ''} placeholder="rigid" onCommit={(v) => updSupport({ kr: v.trim() || undefined })} /></UnitField>
            </label>
          )}
          <label className="field"><span>Rotation</span>
            <div className="bm-rot">
              <button className="icon-btn" title="Turn 90° counter-clockwise" aria-label="Turn left" onClick={() => updSupport({ angle: (support.angle + 90) % 360 })}><RotateCcw size={14} /></button>
              <QtyInput label="Rotation" value={support.angle} unit="deg" show="°" onCommit={(v) => updSupport({ angle: v })} />
              <button className="icon-btn" title="Turn 90° clockwise" aria-label="Turn right" onClick={() => updSupport({ angle: (support.angle + 270) % 360 })}><RotateCw size={14} /></button>
            </div>
          </label>
        </>
      )}
      {load && (
        <>
          <h3 className="sub">{load.type === 'force' ? 'Point load' : load.type === 'moment' ? 'Moment' : 'Line load'}</h3>
          {err(load.id)}
          {region.loadCases && (
            <label className="field"><span>Load case</span>
              <select value={loadCase(load, region.loadCases)} onChange={(e) => updLoad({ case: e.target.value })}>
                {region.loadCases.cases.map((c) => <option key={c.id} value={c.id}>{c.name}{c.label ? ` · ${c.label}` : ''}</option>)}
              </select>
            </label>
          )}
          {load.type === 'force' && (
            <>
              <label className="field" title={`A bare number is ${region.forceUnit}; or with a unit (12 kN, 1.35*P_k)`}><span>Force</span><UnitField unit={region.forceUnit}><LazyInput label="Force" value={load.value} onCommit={(v) => updLoad({ value: v.trim() || '0' })} /></UnitField></label>
              <label className="field"><span>Direction</span>
                <select value={DIRECTIONS.some(([a]) => a === load.angle) ? load.angle : 'custom'} onChange={(e) => e.target.value !== 'custom' && updLoad({ angle: Number(e.target.value) })}>
                  {DIRECTIONS.map(([a, l]) => <option key={a} value={a}>{l}</option>)}
                  <option value="custom">Angle…</option>
                </select>
              </label>
              <label className="field" title="Direction the force points, degrees from +x, counter-clockwise (−90 = down)"><span>Angle</span>
                <QtyInput label="Angle" value={load.angle} unit="deg" show="°" onCommit={(v) => updLoad({ angle: v })} />
              </label>
            </>
          )}
          {load.type === 'moment' && (
            <label className="field" title={`Counter-clockwise positive; a bare number is ${region.forceUnit}·${region.lengthUnit}; or with a unit (12 kN·m)`}><span>Moment (↺ +)</span><UnitField unit={`${region.forceUnit}·${region.lengthUnit}`}><LazyInput label="Moment" value={load.value} onCommit={(v) => updLoad({ value: v.trim() || '0' })} /></UnitField></label>
          )}
          {load.type === 'line' && (
            <>
              <div className="row2">
                <label className="field" title={`A bare number is ${region.forceUnit}/${region.lengthUnit}; or with a unit (7.5 kN/m, q_k)`}><span>q start</span><UnitField unit={`${region.forceUnit}/${region.lengthUnit}`}><LazyInput label="q at the start" value={load.q1} onCommit={(v) => updLoad({ q1: v.trim() || '0' })} /></UnitField></label>
                <label className="field" title="Empty: uniform"><span>q end</span><UnitField unit={`${region.forceUnit}/${region.lengthUnit}`}><LazyInput label="q at the end" value={load.q2 ?? ''} placeholder="uniform" onCommit={(v) => updLoad({ q2: v.trim() || undefined })} /></UnitField></label>
              </div>
              <label className="field"><span>Acts</span>
                <select value={load.dir} onChange={(e) => updLoad({ dir: e.target.value as 'global' | 'local' })}>
                  <option value="global">Downwards (gravity, per length of member)</option>
                  <option value="local">Perpendicular to the member</option>
                </select>
              </label>
            </>
          )}
          {(() => {
            const m = onMember(load);
            if (!m) return null;
            const L = memberLength(m);
            if (load.type === 'line') {
              return (
                <div className="row2">
                  <label className="field" title="Where the load starts, from the member's start"><span>From</span>
                    <QtyInput label="From" value={(load.t1 ?? 0) * L} unit={region.lengthUnit} onCommit={(v) => updLoad({ t1: Math.min(1, Math.max(0, v / L)) })} />
                  </label>
                  <label className="field" title="Where the load ends, from the member's start"><span>To</span>
                    <QtyInput label="To" value={(load.t2 ?? 1) * L} unit={region.lengthUnit} onCommit={(v) => updLoad({ t2: Math.min(1, Math.max(0, v / L)) })} />
                  </label>
                </div>
              );
            }
            const t = (load.at as { t: number }).t;
            return (
              <label className="field"><span>Distance from the member start</span>
                <QtyInput label="Distance from the member start" value={t * L} unit={region.lengthUnit} onCommit={(v) => updLoad({ at: { member: m.id, t: Math.min(1, Math.max(0, v / L)) } } as Partial<BeamLoad>)} />
              </label>
            );
          })()}
        </>
      )}
      {node && (
        <>
          <h3 className="sub">Node</h3>
          <div className="row2">
            {(['x', 'y'] as const).map((k) => (
              <label key={k} className="field"><span>{k}</span>
                <QtyInput label={k} value={node[k]} unit={region.lengthUnit} onCommit={(v) => set({ nodes: region.nodes.map((q) => (q.id === node.id ? { ...q, [k]: v } : q)) }, `n:${node.id}`)} />
              </label>
            ))}
          </div>
          {sol?.nodes[node.id] && (
            <p className="hint">Moves {u.defl(sol.nodes[node.id].dx)} → , {u.defl(sol.nodes[node.id].dy)} ↑, turns {fmt((sol.nodes[node.id].rz * 180) / Math.PI)}°</p>
          )}
        </>
      )}
      {sel.length > 1 && <h3 className="sub">{sel.length} items selected</h3>}
      {sel.length > 0 && <button className="btn" onClick={remove} title="Delete or Backspace in the drawing does the same"><Trash2 size={13} /> Delete selected{sel.length > 1 ? ` (${sel.length})` : ''}</button>}

      {!member && !support && !load && !node && (
        <>
          <h3 className="sub">Section (all members)</h3>
          {err('section')}
          <SectionFields s={region.section} shear={!!region.analysis?.shear} si={result?.section} onChange={(s) => set({ section: s }, 'section')} />
          <h3 className="sub">Load cases</h3>
          <LoadCases lc={region.loadCases} loads={region.loads} moving={region.traffic?.loads} onChange={(lc) => set({ loadCases: lc }, 'cases')} />
          <h3 className="sub">Analysis</h3>
          <AnalysisOptions region={region} onChange={(patch) => set(patch, 'analysis')} />
          <TrafficProps region={region} result={result} onChange={(patch) => set(patch, 'traffic')} />
        </>
      )}

      {result?.error && <div className="region-error">{result.error}</div>}
      {sol && (
        <>
          <h3 className="sub">Results{result?.view ? ` · ${result.view === 'envelope' ? 'envelope (max of |min|, |max|)' : [...(result.combos ?? []), ...(result.cases ?? []), ...(result.traffic?.moving ?? [])].find((c) => c.id === result.view)?.name ?? ''}` : ''}</h3>
          <p className="hint">{sol.indeterminacy === 0 ? 'Statically determinate.' : sol.indeterminacy > 0 ? `Statically indeterminate, degree ${sol.indeterminacy} (solved by stiffness).` : 'Solved.'}</p>
          <table className="props-table">
            <tbody>
              {sol.reactions.map((q) => (
                <tr key={q.id}>
                  <td>{q.label}</td>
                  <td>
                    R<sub>x</sub> {u.force(q.Rx)}, R<sub>y</sub> {u.force(q.Ry)}
                    {region.supports.find((s) => s.id === q.id)?.type === 'fixed' ? <>, M {u.moment(q.M)}</> : null}
                  </td>
                </tr>
              ))}
              {sol.max.M && <tr><td>M<sub>max</sub></td><td>{u.moment(sol.max.M.value)}</td></tr>}
              {sol.max.V && <tr><td>V<sub>max</sub></td><td>{u.force(sol.max.V.value)}</td></tr>}
              {sol.max.N && Math.abs(sol.max.N.value) > 1e-6 && <tr><td>N<sub>max</sub></td><td>{u.force(sol.max.N.value)} {sol.max.N.value < 0 ? '(compression)' : '(tension)'}</td></tr>}
              {sol.max.w && <tr><td>δ<sub>max</sub></td><td>{u.defl(sol.max.w.value)}</td></tr>}
              {sol.max.sigma && <tr><td>σ<sub>max</sub></td><td>{u.stress(sol.max.sigma.value)}</td></tr>}
            </tbody>
          </table>
          <p className="hint">
            Linear elastic, {region.analysis?.secondOrder ? 'second order (equilibrium on the deformed structure)' : 'first order, small deflections'},
            {' '}{region.analysis?.shear ? 'Timoshenko members (with shear deformation)' : 'Euler–Bernoulli members (no shear deformation)'}.
            {' '}Self-weight is not included unless you add it as a line load.
          </p>
        </>
      )}
      {result && <StabilityResults region={region} result={result} />}
    </div>
  );
}
