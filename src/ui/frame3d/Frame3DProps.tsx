// Side panel of a 3-D frame region: the worksheet name and units, a preset to start
// from, the analysis options, load cases and combinations, the selected node or
// member, and α_cr per combination with the EN 1993-1-1 5.2.1(3) verdict.
import type { Dispatch } from 'react';
import type { Frame3DRegion } from '../../model/types';
import type { Frame3DResult } from '../../frame3d/evaluate';
import { BEAM_FORCE_UNITS, BEAM_LENGTH_UNITS } from '../../beam/model';
import { framePreset, windCases, type Frame3DAnalysis, type Frame3DPreset } from '../../frame3d/model';
import type { Action } from '../store';
import { useSketchUI } from '../sketch/context';
import { LazyInput } from '../sketch/SketchProps';
import { LoadCases } from '../beam/BeamProps';
import { LENGTH_M, fmt, fmtAlpha, units } from '../beam/beamDraw';

const PRESETS: { id: Frame3DPreset; label: string; title: string }[] = [
  { id: 'portal', label: '3-D portal frame', title: 'Steel frame 2 × 1 bays (6 m × 5 m), 4.5 m high, fixed feet; roof loads G and Q, wind W, three combinations' },
  { id: 'truss', label: 'Space truss tower', title: 'Lattice tower 2 m × 2 m × 6 m, pin-jointed tubes, load and a horizontal pull at the top' },
  { id: 'grillage', label: 'Grillage', title: 'Floor grid of 3 × 3 bays of 4 m, simply supported round its edge, uniformly loaded' },
];

/** EN 1993-1-1 5.2.1(3): first order is enough for α_cr ≥ 10 (elastic analysis). */
function verdict(a: number): string {
  if (!Number.isFinite(a)) return 'no compression';
  if (a >= 10) return 'first order enough (≥ 10)';
  if (a >= 3) return 'second-order effects count (3 – 10)';
  if (a > 1) return 'second order required (< 3)';
  return 'above the critical load';
}

export function Frame3DProps({ region, result, dispatch }: { region: Frame3DRegion; result?: Frame3DResult; dispatch: Dispatch<Action> }) {
  const { ui } = useSketchUI();
  const set = (patch: Partial<Frame3DRegion>, key = 'frame3d') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const name = region.name.trim() || 'f';
  const an = region.analysis ?? {};
  const setAn = (patch: Partial<Frame3DAnalysis>) => set({ analysis: { ...an, ...patch } });
  const u = units(region), Lm = LENGTH_M[region.lengthUnit] ?? 1;
  const one = ui.regionId === region.id && ui.selected.length === 1 ? ui.selected[0] : null;
  const member = region.members.find((m) => m.id === one);
  const node = region.nodes.find((n) => n.id === one);
  const sol = result?.solution;
  const first = region.nodes[0]?.name ?? 'N1', firstM = region.members[0]?.name ?? 'M1';

  const applyPreset = (id: Frame3DPreset) => {
    if (region.members.length && !window.confirm('Replace the frame with the preset?')) return;
    const p = framePreset(id, { length: region.lengthUnit, force: region.forceUnit });
    const { loadCases, ...data } = p;
    dispatch({ type: 'update', id: region.id, patch: { ...data, loadCases, camera: { ...region.camera, zoom: 1, panX: 0, panY: 0 } } });
  };

  return (
    <div className="props">
      <h3 className="sub">3-D frame</h3>
      <label className="field">
        <span>Variable for the results</span>
        <LazyInput label="Variable name" value={region.name} placeholder="e.g. f" onCommit={(v) => set({ name: v.trim() }, 'name')} />
      </label>
      <p className="hint">
        With a name the math below can use <code>{name}.{first}.Rz</code> (reactions and <code>.ux</code> … <code>.uz</code> per node),{' '}
        <code>{name}.{firstM}.My_max</code>, <code>{name}.{firstM}.N_min</code> (extremes per member), <code>{name}.{firstM}.My(x)</code> (along it),{' '}
        <code>{name}.My_max</code>, <code>{name}.u_max</code>{an.buckling || an.secondOrder ? <>, <code>{name}.alpha_cr</code></> : null}
        {region.loadCases ? <>, and each case and combination: <code>{name}.combos.{region.loadCases.combos[0]?.name ?? 'ULS'}.{first}.Rz</code></> : null}.
      </p>
      <div className="row2">
        <label className="field"><span>Lengths</span>
          <select value={region.lengthUnit} onChange={(e) => set({ lengthUnit: e.target.value as Frame3DRegion['lengthUnit'] })}>
            {BEAM_LENGTH_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="field"><span>Forces</span>
          <select value={region.forceUnit} onChange={(e) => set({ forceUnit: e.target.value as Frame3DRegion['forceUnit'] })}>
            {BEAM_FORCE_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      </div>
      <p className="hint">Bare numbers take these units (coordinates and positions {region.lengthUnit}, forces {region.forceUnit}); sections cm², cm⁴; E and G GPa; β degrees. Every value can be a worksheet expression.</p>

      <h3 className="sub">Start from</h3>
      <div className="f3-presets">
        {PRESETS.map((p) => <button key={p.id} className="btn" title={p.title} onClick={() => applyPreset(p.id)}>{p.label}</button>)}
      </div>

      <h3 className="sub">Analysis</h3>
      <label className="field"><span>Order</span>
        <select value={an.secondOrder ? '2' : '1'} onChange={(e) => setAn({ secondOrder: e.target.value === '2' || undefined })}>
          <option value="1">First order (linear)</option>
          <option value="2">Second order (P-Δ and P-δ)</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={!!an.shear} onChange={(e) => setAn({ shear: e.target.checked || undefined })} /> Shear deformation (Timoshenko members)</label>
      <label className="check" title={an.secondOrder ? 'Second order always finds α_cr first' : undefined}>
        <input type="checkbox" checked={!!an.buckling || !!an.secondOrder} disabled={!!an.secondOrder} onChange={(e) => setAn({ buckling: e.target.checked || undefined })} /> <span>Buckling: α<sub>cr</sub> and modes</span>
      </label>
      <p className="hint">
        Second order cuts members into short elements with the geometric stiffness of their axial force in both bending planes. Buckling covers flexural
        buckling and sway (EN 1993-1-1 5.2.1), not lateral-torsional buckling. Shear deformation uses the sections’ shear areas A<sub>vy</sub>, A<sub>vz</sub>.
      </p>
      {result?.combos?.some((c) => c.alpha !== undefined) || (result?.buckling && !region.loadCases) ? (
        <table className="props-table">
          <tbody>
            {(result?.combos?.length ? result.combos : [{ id: 'all', name: 'Loads', alpha: result?.buckling?.modes[0]?.alpha }]).map((c) => (
              <tr key={c.id}><td>{c.name}</td><td className="num">α<sub>cr</sub> {fmtAlpha(c.alpha ?? Infinity)}</td><td>{verdict(c.alpha ?? Infinity)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <h3 className="sub">Load cases</h3>
      <LoadCases lc={region.loadCases} loads={region.loads} start={windCases} onChange={(lc) => set({ loadCases: lc })} />

      {member && (
        <>
          <h3 className="sub">Member {member.name}</h3>
          {result?.errors[member.id] && <div className="region-error">{result.errors[member.id]}</div>}
          {(() => {
            const geo = result?.geometry[member.id];
            if (!geo) return null;
            const ax = (v: number[]) => `(${v.map((c) => fmt(Math.abs(c) < 1e-12 ? 0 : c)).join(', ')})`;
            const L = result?.buckling?.Lcr[member.id];
            return (
              <table className="props-table">
                <tbody>
                  <tr><td>Length</td><td>{u.length(geo.L / Lm)}</td></tr>
                  <tr><td>x axis</td><td className="mono">{ax(geo.axes[0])}</td></tr>
                  <tr><td>y axis</td><td className="mono">{ax(geo.axes[1])}</td></tr>
                  <tr><td>z axis</td><td className="mono">{ax(geo.axes[2])}</td></tr>
                  {L && <tr><td>L<sub>cr</sub></td><td>y {u.length(L.y / Lm)} · z {u.length(L.z / Lm)}</td></tr>}
                </tbody>
              </table>
            );
          })()}
          <label className="field" title='Local z leans towards this direction (global "x, y, z" or X, −Y …); empty: down for a beam, −X for a column'>
            <span>Reference direction for z</span>
            <LazyInput label="Reference direction" value={member.ref ?? ''} placeholder="default" onCommit={(v) => set({ members: region.members.map((m) => (m.id === member.id ? { ...m, ref: v.trim() || undefined } : m)) })} />
          </label>
          <p className="hint">Local axes: x from the start to the end; for a beam z points down (gravity loads along +z, sagging M<sub>y</sub> &gt; 0) and y = z × x; for a column y is global Y. β turns y and z about x.</p>
        </>
      )}
      {node && sol?.nodes[node.id] && (
        <>
          <h3 className="sub">Node {node.name}</h3>
          <table className="props-table">
            <tbody>
              {['ux', 'uy', 'uz'].map((k, i) => <tr key={k}><td>{k}</td><td>{u.defl(sol.nodes[node.id][i])}</td></tr>)}
              {['φx', 'φy', 'φz'].map((k, i) => <tr key={k}><td>{k}</td><td>{fmt(sol.nodes[node.id][3 + i] * 1000)} mrad</td></tr>)}
            </tbody>
          </table>
        </>
      )}
      {sol && (
        <p className="hint">
          {sol.unknowns} unknowns · degree of indeterminacy {sol.indeterminacy}{result?.millis !== undefined ? ` · ${fmt(result.millis)} ms` : ''}.
        </p>
      )}
    </div>
  );
}
