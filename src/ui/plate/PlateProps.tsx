// Side panel of a plate region: the worksheet name and units, a preset to start from, the
// thickness and material, the element size, the reinforcement to design, load cases and
// combinations, the mesh's figures and what the worksheet can read.
import type { Dispatch } from 'react';
import type { PlateRegion } from '../../model/types';
import type { PlateResult } from '../../plate/evaluate';
import { autoSize } from '../../plate/evaluate';
import { BEAM_FORCE_UNITS, BEAM_LENGTH_UNITS, defaultCases } from '../../beam/model';
import { platePreset, type PlatePreset, type PlateRebar } from '../../plate/model';
import { CONCRETE_GRADES, STEEL_GRADES } from '../../engine/materials';
import type { Action } from '../store';
import { LazyInput } from '../sketch/SketchProps';
import { LoadCases } from '../beam/BeamProps';
import { FORCE_N, LENGTH_M, fmt } from '../beam/beamDraw';

const PRESETS: { id: PlatePreset; label: string; title: string }[] = [
  { id: 'simple', label: 'Slab on walls', title: '6 m × 4 m, 200 mm, simply supported all round; self-weight, finishes G and imposed Q' },
  { id: 'flat', label: 'Flat slab', title: '2 × 2 bays of 6 m × 4.5 m on nine columns 400 × 400, 250 mm, free edges' },
  { id: 'circle', label: 'Circular slab', title: 'Radius 3 m, simply supported, 200 mm' },
  { id: 'lshape', label: 'L-shaped slab', title: 'An L of 8 m × 7 m on walls, clamped along the inner corner, with an inner wall' },
  { id: 'steel', label: 'Steel plate', title: '1.2 m × 0.8 m, 20 mm S355, clamped all round, 50 kN/m²' },
];

/** Reinforcement grades by f_yk and ductility class (EN 1992-1-1 Annex C): B500B, or B450C as in some national annexes. */
const REBAR = ['B400B', 'B450A', 'B450C', 'B500A', 'B500B', 'B500C', 'B550B'];

export function PlateProps({ region, result, dispatch }: { region: PlateRegion; result?: PlateResult; dispatch: Dispatch<Action> }) {
  const set = (patch: Partial<PlateRegion>, key = 'plate') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const name = region.name.trim() || 'p';
  const concrete = /^C\d+\/\d+$/.test(region.material);
  const steel = STEEL_GRADES.includes(region.material);
  const Lm = LENGTH_M[region.lengthUnit] ?? 1, FN = FORCE_N[region.forceUnit] ?? 1e3;
  const rebar = region.rebar;
  const setRebar = (patch: Partial<PlateRebar>) => set({ rebar: { ...(rebar ?? { steel: 'B500B', cover: '30', bar: '12' }), ...patch } });
  const err = (id: string) => result?.errors[id] && <div className="region-error">{result.errors[id]}</div>;
  const m = result?.mesh, mat = result?.material;
  const auto = (() => {
    const o = result?.outline;
    if (!o?.length) return null;
    let A = 0;
    o.forEach((p, i) => (A += p[0] * o[(i + 1) % o.length][1] - o[(i + 1) % o.length][0] * p[1]));
    return autoSize(Math.abs(A) / 2) / Lm;
  })();

  const applyPreset = (id: PlatePreset) => {
    if (region.outline.length && !window.confirm('Replace the plate with the preset?')) return;
    const p = platePreset(id, { length: region.lengthUnit, force: region.forceUnit });
    const { loadCases, thickness, material, ...data } = p;
    dispatch({ type: 'update', id: region.id, patch: { ...data, loadCases, thickness: thickness ?? region.thickness, material: material ?? region.material, rebar: STEEL_GRADES.includes(material ?? '') ? undefined : region.rebar, view: undefined, cut: undefined } });
  };

  return (
    <div className="props">
      <h3 className="sub">Plate / slab</h3>
      <label className="field">
        <span>Variable for the results</span>
        <LazyInput label="Variable name" value={region.name} placeholder="e.g. p" onCommit={(v) => set({ name: v.trim() }, 'name')} />
      </label>
      <p className="hint">
        With a name the math below can use <code>{name}.w_max</code>, <code>{name}.m_x_max</code>, <code>{name}.m_y_min</code>, <code>{name}.v_max</code>,
        the reactions <code>{name}.E1.R</code>, <code>{name}.E1.r_max</code> (per length), <code>{name}.C1.R</code>, and any field at a point: <code>{name}.m_x(x, y)</code>, <code>{name}.w(x, y)</code>
        {rebar && concrete ? <>; reinforcement <code>{name}.a_s_x_bot_max</code>, <code>{name}.a_s_y_top_max</code>, <code>{name}.a_s_min_x</code></> : null}
        {steel ? <>; <code>{name}.σ_max</code></> : null}
        {region.loadCases ? <>; each case and combination: <code>{name}.combos.{region.loadCases.combos[0]?.name ?? 'ULS'}.w_max</code></> : null}.
      </p>
      <div className="row2">
        <label className="field"><span>Lengths</span>
          <select value={region.lengthUnit} onChange={(e) => set({ lengthUnit: e.target.value as PlateRegion['lengthUnit'] })}>
            {BEAM_LENGTH_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="field"><span>Forces</span>
          <select value={region.forceUnit} onChange={(e) => set({ forceUnit: e.target.value as PlateRegion['forceUnit'] })}>
            {BEAM_FORCE_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
      </div>
      <p className="hint">Bare numbers take these units (corners {region.lengthUnit}, area loads {region.forceUnit}/{region.lengthUnit}², line loads {region.forceUnit}/{region.lengthUnit}); the thickness, column sizes, cover and bars mm; E GPa. Every value can be a worksheet expression.</p>

      <h3 className="sub">Start from</h3>
      <div className="f3-presets">
        {PRESETS.map((p) => <button key={p.id} className="btn" title={p.title} onClick={() => applyPreset(p.id)}>{p.label}</button>)}
      </div>

      <h3 className="sub">Plate</h3>
      <div className="row2">
        <label className="field"><span>Thickness t (mm)</span>
          <LazyInput label="Thickness" value={region.thickness} onCommit={(v) => set({ thickness: v.trim() || '200' })} />
        </label>
        <label className="field"><span>Material</span>
          <select value={region.material} onChange={(e) => set({ material: e.target.value, ...(STEEL_GRADES.includes(e.target.value) ? { rebar: undefined } : {}) })}>
            {!CONCRETE_GRADES.includes(region.material) && !STEEL_GRADES.includes(region.material) && region.material !== 'custom' && <option value={region.material}>{region.material}</option>}
            <optgroup label="Concrete">{CONCRETE_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}</optgroup>
            <optgroup label="Steel">{STEEL_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}</optgroup>
            <option value="custom">Custom E, ν, ρ</option>
          </select>
        </label>
      </div>
      {err('t')}{err('material')}
      {region.material === 'custom' && (
        <div className="row2">
          <label className="field"><span>E (GPa)</span><LazyInput label="E" value={region.E ?? ''} onCommit={(v) => set({ E: v.trim() || undefined })} /></label>
          <label className="field"><span>ν</span><LazyInput label="Poisson's ratio" value={region.nu ?? ''} placeholder="0.2" onCommit={(v) => set({ nu: v.trim() || undefined })} /></label>
          <label className="field"><span>ρ (kg/m³)</span><LazyInput label="Density" value={region.rho ?? ''} placeholder="0" onCommit={(v) => set({ rho: v.trim() || undefined })} /></label>
        </div>
      )}
      {mat && (
        <p className="hint">
          E = {fmt(mat.E / 1e9)} GPa, ν = {fmt(mat.nu)}, D = E t³/12(1 − ν²) = {fmt(mat.D / (FN * Lm))} {region.forceUnit}·{region.lengthUnit}{mat.g ? `, self-weight ρ g t = ${fmt(mat.g / (FN / (Lm * Lm)))} ${region.forceUnit}/${region.lengthUnit}²` : ''}.
          {concrete ? ' Concrete: E_cm and ν = 0.2 (EN 1992-1-1 3.1.3), uncracked: long-term deflections need creep and cracking on top.' : ''}
        </p>
      )}
      <label className="field"><span>Element size ({region.lengthUnit})</span>
        <LazyInput label="Element size" value={region.mesh ?? ''} placeholder={auto ? `auto (${fmt(auto)})` : 'auto'} onCommit={(v) => set({ mesh: v.trim() || undefined })} />
      </label>
      {err('mesh')}
      {result?.size !== undefined && region.mesh?.trim() && result.size < Number.parseFloat(region.mesh) * Lm * (1 - 1e-9) && (
        <p className="hint">The element size is held to a quarter of the plate’s narrower side: {fmt(result.size / Lm)} {region.lengthUnit}.</p>
      )}
      {m && (
        <p className="hint">
          {m.quads.length / 4} elements, {m.x.length} nodes, {result?.unknowns} unknowns: {m.structured ? 'a grid through every edge, wall and column' : 'triangles refined to near-equilateral shape, each split into three quads'}; corners {fmt(m.minAngle)}° – {fmt(m.maxAngle)}°.
          {result?.millis !== undefined && !result.cached ? ` Meshed and solved in ${fmt(result.millis)} ms.` : ''}
        </p>
      )}

      {concrete && (
        <>
          <h3 className="sub">Reinforcement (EN 1992-1-1)</h3>
          <label className="check"><input type="checkbox" checked={!!rebar} onChange={(e) => set({ rebar: e.target.checked ? { steel: 'B500B', cover: '30', bar: '12' } : undefined })} /> Design the bending reinforcement</label>
          {rebar && (
            <>
              <div className="row2">
                <label className="field"><span>Steel</span>
                  <select value={rebar.steel} onChange={(e) => setRebar({ steel: e.target.value })}>
                    {!REBAR.includes(rebar.steel) && <option value={rebar.steel}>{rebar.steel}</option>}
                    {REBAR.map((g) => <option key={g} value={g}>{g} (f_yk {g.slice(1, 4)} MPa)</option>)}
                  </select>
                </label>
                <label className="field"><span>Outer layer</span>
                  <select value={rebar.outer ?? 'x'} onChange={(e) => setRebar({ outer: e.target.value === 'y' ? 'y' : undefined })}>
                    <option value="x">bars along x</option><option value="y">bars along y</option>
                  </select>
                </label>
              </div>
              <div className="row2">
                <label className="field"><span>Cover c (mm)</span><LazyInput label="Cover" value={rebar.cover} onCommit={(v) => setRebar({ cover: v.trim() || '30' })} /></label>
                <label className="field"><span>Bars Ø (mm)</span><LazyInput label="Bar diameter" value={rebar.bar} onCommit={(v) => setRebar({ bar: v.trim() || '12' })} /></label>
              </div>
              {err('rebar')}
              {result?.design && (
                <p className="hint">
                  d<sub>x</sub> = {fmt(result.design.dx * 1000)} mm, d<sub>y</sub> = {fmt(result.design.dy * 1000)} mm; a<sub>s,min</sub> = {fmt(result.design.asMinX * 1e4)} / {fmt(result.design.asMinY * 1e4)} cm²/m (9.3.1.1, 9.2.1.1).
                </p>
              )}
              <p className="hint">Wood–Armer moments for bars along x and y at both faces; a<sub>s</sub> = m<sub>Ed</sub> / (z f<sub>yd</sub>) with z = 0.9 d (shorter where the compression zone is deeper), γ<sub>s</sub> = 1.15, γ<sub>c</sub> = 1.5. Shear, punching, crack widths and detailing are not checked.</p>
            </>
          )}
        </>
      )}

      <h3 className="sub">Load cases</h3>
      <LoadCases lc={region.loadCases} loads={region.loads} start={defaultCases} onChange={(lc) => set({ loadCases: lc })} />
      <p className="hint">Loads act downwards. A simple support holds w and the rotation along the edge (as Kirchhoff’s w = 0 does), so reactions come out as V = q + ∂m<sub>xy</sub>/∂s with the corner forces that hold the corners down.</p>
    </div>
  );
}
