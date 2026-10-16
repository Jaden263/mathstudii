// Side panel blocks for the analysis options of a beam region: shear deformation,
// second order and buckling; the shear data of a section; and the stability results
// (α_cr per combination with the EN 1993-1-1 5.2.1(3) verdict, amplification, L_cr).
import type { BeamRegion } from '../../model/types';
import type { BeamResult, CaseResult } from '../../beam/evaluate';
import type { BeamAnalysis, BeamPanel, BeamSection, BeamShearArea } from '../../beam/model';
import { profileShearArea, shearAreaRule } from '../../beam/shear';
import { CONCRETE_GRADES, TIMBER_GRADES, concreteGrade, timberGrade } from '../../engine/materials';
import { LazyInput } from '../sketch/SketchProps';
import { LENGTH_M, fmt, fmtAlpha, units } from './beamDraw';

/** First-order or second-order analysis, Timoshenko members, buckling. */
export function AnalysisOptions({ region, onChange }: { region: BeamRegion; onChange: (patch: Partial<BeamRegion>) => void }) {
  const an = region.analysis ?? {};
  const set = (patch: Partial<BeamAnalysis>) => {
    const next = { ...an, ...patch };
    const extra: Partial<BeamRegion> = {};
    // a chosen set of diagrams gains (or loses) the buckling mode with the option
    const modes = !!(next.buckling || next.secondOrder);
    if (region.panels && modes !== region.panels.includes('mode')) {
      extra.panels = modes ? [...region.panels, 'mode' as BeamPanel] : region.panels.filter((p) => p !== 'mode');
    }
    onChange({ analysis: next, ...extra });
  };
  return (
    <>
      <label className="field"><span>Analysis</span>
        <select value={an.secondOrder ? '2' : '1'} onChange={(e) => set({ secondOrder: e.target.value === '2' || undefined })}>
          <option value="1">First order (linear)</option>
          <option value="2">Second order (P-Δ and P-δ)</option>
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={!!an.shear} onChange={(e) => set({ shear: e.target.checked || undefined })} /> Shear deformation (Timoshenko members)</label>
      <label className="check" title={an.secondOrder ? 'Second order always finds α_cr first' : undefined}>
        <input type="checkbox" checked={!!an.buckling || !!an.secondOrder} disabled={!!an.secondOrder} onChange={(e) => set({ buckling: e.target.checked || undefined })} /> <span>Buckling: α<sub>cr</sub> and modes</span>
      </label>
      <p className="hint">
        Second order solves every combination on the deformed structure, the members cut into short elements (P-δ along them as well as sway P-Δ).
        Buckling finds the load factors α<sub>cr</sub> of the three lowest modes from the axial forces of each combination (EN 1993-1-1 5.2.1).
        Shear deformation uses G and the shear area A<sub>v</sub> of each section.
      </p>
    </>
  );
}

const MATERIALS: { value: string; label: string }[] = [
  { value: 'steel', label: 'Steel (ν = 0.3)' },
  { value: 'concrete', label: 'Concrete (ν = 0.2)' },
  ...CONCRETE_GRADES.map((g) => ({ value: `concrete:${g}`, label: `Concrete ${g}` })),
  { value: 'timber', label: 'Timber (G = E/16)' },
  ...TIMBER_GRADES.map((g) => ({ value: `timber:${g}`, label: `Timber ${g}` })),
];

/** The material of a section: steel, or a concrete / timber class that also sets E. */
export function MaterialField({ s, onChange }: { s: BeamSection; onChange: (s: BeamSection) => void }) {
  const value = `${s.material ?? 'steel'}${s.grade ? `:${s.grade}` : ''}`;
  return (
    <label className="field" title="Sets E for a concrete or timber class; the shear modulus follows the material">
      <span>Material</span>
      <select value={MATERIALS.some((m) => m.value === value) ? value : s.material ?? 'steel'} onChange={(e) => {
        const [material, grade] = e.target.value.split(':') as [BeamSection['material'], string | undefined];
        const next: BeamSection = { ...s, material: material === 'steel' ? undefined : material, grade };
        if (grade && material === 'concrete') next.E = `${+concreteGrade(grade).E_cm.toPrecision(4)} GPa`;
        else if (grade && material === 'timber') next.E = `${timberGrade(grade).E_0_mean} GPa`;
        else if (material === 'steel' && s.material) next.E = '210 GPa';
        onChange(next);
      }}>
        {MATERIALS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
    </label>
  );
}

type RuleKind = BeamShearArea['kind'] | 'auto';

/** Shear modulus and shear area of a section (shown with shear deformation on). */
export function ShearFields({ s, onChange, si }: {
  s: BeamSection; onChange: (s: BeamSection) => void;
  /** Values in SI the analysis used (the default section only). */
  si?: { G?: number; Av?: number };
}) {
  const profile = profileShearArea(s.label) !== null;
  const kind: RuleKind = s.shear?.kind ?? 'auto';
  const setKind = (k: RuleKind) => {
    const rules: Record<RuleKind, BeamShearArea | undefined> = {
      auto: undefined, rect: { kind: 'rect' }, circle: { kind: 'circle' }, chs: { kind: 'chs' },
      rhs: { kind: 'rhs', h: '200', b: '100' }, welded: { kind: 'welded', hw: '400', tw: '10' },
      value: { kind: 'value', Av: si?.Av ? `${+(si.Av * 1e4).toPrecision(4)} cm^2` : '' },
    };
    onChange({ ...s, shear: rules[k] });
  };
  const rule = s.shear;
  return (
    <>
      <div className="row2">
        <label className="field" title="Shear modulus; empty = E / 2(1 + ν), or G_mean of the timber class. A bare number is GPa">
          <span>G</span>
          <LazyInput label="Shear modulus" value={s.G ?? ''} placeholder={si?.G ? `${fmt(si.G / 1e9)} GPa` : 'from E'} onCommit={(v) => onChange({ ...s, G: v.trim() || undefined })} />
        </label>
        <label className="field" title="How the shear area A_v follows from the section">
          <span>Shear area A<sub>v</sub></span>
          <select value={kind} onChange={(e) => setKind(e.target.value as RuleKind)}>
            <option value="auto">{profile ? `${s.label} (6.2.6(3))` : 'Rectangle 5/6 A (default)'}</option>
            <option value="rect">Rectangle, 5/6 A</option>
            <option value="circle">Solid circle, 0.9 A</option>
            <option value="chs">Circular hollow, 2A/π</option>
            <option value="rhs">Rect. hollow, A h/(b + h)</option>
            <option value="welded">Welded I, h_w t_w</option>
            <option value="value">Value…</option>
          </select>
        </label>
      </div>
      {rule?.kind === 'rhs' && (
        <div className="row2">
          <label className="field" title="Depth along the load; a bare number is mm"><span>h</span><LazyInput label="Depth h" value={rule.h} onCommit={(v) => onChange({ ...s, shear: { ...rule, h: v.trim() || '0' } })} /></label>
          <label className="field" title="Width; a bare number is mm"><span>b</span><LazyInput label="Width b" value={rule.b} onCommit={(v) => onChange({ ...s, shear: { ...rule, b: v.trim() || '0' } })} /></label>
        </div>
      )}
      {rule?.kind === 'welded' && (
        <div className="row2">
          <label className="field" title="Web depth between the flanges; a bare number is mm"><span>h<sub>w</sub></span><LazyInput label="Web depth" value={rule.hw} onCommit={(v) => onChange({ ...s, shear: { ...rule, hw: v.trim() || '0' } })} /></label>
          <label className="field" title="Web thickness; a bare number is mm"><span>t<sub>w</sub></span><LazyInput label="Web thickness" value={rule.tw} onCommit={(v) => onChange({ ...s, shear: { ...rule, tw: v.trim() || '0' } })} /></label>
        </div>
      )}
      {rule?.kind === 'value' && (
        <label className="field" title="A bare number is cm²"><span>A<sub>v</sub></span><LazyInput label="Shear area" value={rule.Av} onCommit={(v) => onChange({ ...s, shear: { kind: 'value', Av: v.trim() } })} /></label>
      )}
      {si?.G !== undefined && si.Av !== undefined && (
        <p className="hint">G = {fmt(si.G / 1e9)} GPa, A<sub>v</sub> = {fmt(si.Av * 1e4)} cm² ({shearAreaRule(s)}).</p>
      )}
    </>
  );
}

/** EN 1993-1-1 5.2.1(3) and 5.2.2(5)B for an elastic global analysis. */
export function alphaVerdict(a: number): { text: string; cls: 'ok' | 'warn' | 'bad' } {
  if (!Number.isFinite(a)) return { text: 'nothing in compression', cls: 'ok' };
  if (a >= 10) return { text: 'α_cr ≥ 10: first-order analysis is enough', cls: 'ok' };
  if (a >= 3) return { text: `second-order effects count; sway effects × 1/(1 − 1/α_cr) = ${(1 / (1 - 1 / a)).toFixed(2)} (5.2.2(5)B), or second order`, cls: 'warn' };
  if (a > 1) return { text: 'α_cr < 3: a second-order analysis is required', cls: 'bad' };
  return { text: 'unstable: above the elastic critical load', cls: 'bad' };
}

/** α_cr per combination with the verdict, the second-order amplification, and L_cr per member. */
export function StabilityResults({ region, result }: { region: BeamRegion; result: BeamResult }) {
  const u = units(region);
  const name = region.name.trim() || 'beam';
  const rows: CaseResult[] = result.combos ?? [{ id: '', name: '', solution: result.solution, buckling: result.buckling }];
  const withBuckling = rows.filter((c) => c.buckling);
  if (!withBuckling.length) return null;
  const sol = result.solution, first = sol?.secondOrder?.first;
  const shown = result.buckling;
  const ratio = (a?: number, b?: number) => (a !== undefined && b ? Math.abs(a / b) : undefined);
  const ampM = ratio(sol?.max.M?.value, first?.max.M?.value), ampW = ratio(sol?.max.w?.value, first?.max.w?.value);
  const a1 = shown?.modes[0]?.alpha;
  return (
    <>
      <h3 className="sub">Stability (EN 1993-1-1 5.2.1)</h3>
      <table className="props-table bm-alpha">
        <tbody>
          {rows.map((c) => {
            const a = c.buckling?.modes[0]?.alpha ?? (c.buckling ? Infinity : undefined);
            if (a === undefined) return null;
            const v = alphaVerdict(a);
            return (
              <tr key={c.id}>
                <td>α<sub>cr</sub>{c.name ? ` · ${c.name}` : ''}</td>
                <td><b>{fmtAlpha(a)}</b> <span className={`bm-verdict ${v.cls}`}>{v.text}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shown && shown.modes.length > 1 && <p className="hint">Higher modes{result.view === 'envelope' ? ' (lowest combination)' : ''}: α<sub>cr</sub> = {shown.modes.slice(1).map((m) => fmtAlpha(m.alpha)).join(', ')}.</p>}
      {first && ampM !== undefined && (
        <p className="hint">
          Second order{sol?.secondOrder ? ` (${sol.secondOrder.iterations} iterations)` : ''}: M<sub>max</sub> ×{ampM.toFixed(3)}
          {ampW !== undefined ? <>, δ<sub>max</sub> ×{ampW.toFixed(3)}</> : null} against first order
          {a1 && Number.isFinite(a1) && a1 > 1 ? <>; the estimate 1/(1 − 1/α<sub>cr</sub>) = {(1 / (1 - 1 / a1)).toFixed(3)}</> : null}.
        </p>
      )}
      {shown && a1 !== undefined && Object.keys(shown.Lcr).length > 0 && (
        <>
          <table className="props-table">
            <tbody>
              {region.members.map((m, i) => (shown.Lcr[m.id] !== undefined ? (
                <tr key={m.id}><td>L<sub>cr</sub> member {i + 1}</td><td>{u.length(shown.Lcr[m.id] / (LENGTH_M[region.lengthUnit] ?? 1))}</td></tr>
              ) : null))}
            </tbody>
          </table>
          <p className="hint">
            L<sub>cr</sub> = π √(EI / (α<sub>cr</sub> |N|)) in the lowest mode, N the member's largest compression. The worksheet gets <code>{name}.alpha_cr</code>,
            {' '}<code>{name}.alpha_cr_modes</code> and <code>{name}.L_cr</code> (members in order, ∞ in tension)
            {region.loadCases ? <>, per combination as <code>{name}.combos.ULS.alpha_cr</code></> : null}
            {sol?.secondOrder ? <>; first-order values as <code>{name}.first.M_max</code></> : null}.
          </p>
        </>
      )}
    </>
  );
}
