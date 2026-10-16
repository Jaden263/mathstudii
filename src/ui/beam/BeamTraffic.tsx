// Side panel blocks for influence lines and moving loads: the lines asked for, the
// moving loads (a point load, EN 1991-2 Load Model 1, a crane, an axle train), the load
// path and the step, and each moving load's extremes with where they act.
import { Fragment } from 'react';
import { Trash2 } from 'lucide-react';
import type { BeamRegion } from '../../model/types';
import type { BeamResult } from '../../beam/evaluate';
import { straightBeam } from '../../beam/evaluate';
import { ilPeak, MAX_POSITIONS, MIN_STEPS, type Critical } from '../../beam/influence';
import { beamId, movingLoad, type BeamCombo, type BeamInfluenceLine, type BeamMovingLoad, type BeamTraffic, type InfluenceQuantity } from '../../beam/model';
import { identifierOf } from '../../beam/traffic';
import { LazyInput } from '../sketch/SketchProps';
import { LENGTH_M, fmt, units } from './beamDraw';

const QUANTITIES: { q: InfluenceQuantity; label: string }[] = [
  { q: 'Ry', label: 'Reaction R_y' },
  { q: 'Rx', label: 'Reaction R_x' },
  { q: 'Mr', label: 'Support moment' },
  { q: 'M', label: 'Moment M' },
  { q: 'V', label: 'Shear V' },
  { q: 'N', label: 'Normal force N' },
  { q: 'w', label: 'Deflection δ' },
];
const isReaction = (q: InfluenceQuantity) => q === 'Ry' || q === 'Rx' || q === 'Mr';

const PRESETS: { preset: BeamMovingLoad['preset']; label: string; name: string }[] = [
  { preset: 'lm1', label: 'EN 1991-2 Load Model 1 (one lane)', name: 'LM1' },
  { preset: 'point', label: 'Point load', name: 'P' },
  { preset: 'crane', label: 'Crane: two wheels', name: 'crane' },
  { preset: 'train', label: 'Axle train + uniform load', name: 'train' },
];

/** A name not yet used: base, base2, … (or base1, base2 … when numbered). */
function freeName(base: string, used: string[], numbered = false): string {
  for (let k = numbered ? 1 : 0; ; k++) {
    const n = k ? `${base}${k}` : base;
    if (!used.includes(n)) return n;
  }
}

/** Unit of an influence ordinate: the quantity per unit force (kN·m/kN for a moment, a length; – for a force). */
export function ordinateUnit(r: BeamRegion, q: InfluenceQuantity): string {
  return q === 'M' || q === 'Mr' ? `${r.forceUnit}·${r.lengthUnit}/${r.forceUnit}` : q === 'w' ? `${trainUnit(r, q)}/${r.forceUnit}` : '–';
}

/** Unit of Σ P η, the response to the axles. */
export function trainUnit(r: BeamRegion, q: InfluenceQuantity): string {
  const metric = r.lengthUnit === 'm' || r.lengthUnit === 'cm' || r.lengthUnit === 'mm';
  return q === 'M' || q === 'Mr' ? `${r.forceUnit}·${r.lengthUnit}` : q === 'w' ? (metric ? 'mm' : 'in') : r.forceUnit;
}

/** An ordinate in SI (per newton) in the region's units. */
export function ordinateValue(r: BeamRegion, q: InfluenceQuantity, v: number): number {
  const L = LENGTH_M[r.lengthUnit] ?? 1, F = units(r).forceN;
  const metric = r.lengthUnit === 'm' || r.lengthUnit === 'cm' || r.lengthUnit === 'mm';
  return q === 'M' || q === 'Mr' ? v / L : q === 'w' ? (v * F) / (metric ? 1e-3 : 0.0254) : v;
}

/** What an influence line is of, in words: at x on a beam, on a member of a frame. */
export function lineTitle(r: BeamRegion, l: BeamInfluenceLine): string {
  const what = QUANTITIES.find((q) => q.q === l.quantity)?.label ?? l.quantity;
  if (isReaction(l.quantity)) return `${what} at ${r.supports.find((s) => s.id === l.support)?.label ?? '?'}`;
  const i = r.members.findIndex((m) => m.id === l.member);
  const a = i >= 0 ? r.nodes.find((q) => q.id === r.members[i].a) : undefined;
  if (!straightBeam(r) && a && l.at) return `${what}, member ${i + 1} at ${fmt(Math.hypot(l.at.x - a.x, l.at.y - a.y))} ${r.lengthUnit}`;
  return `${what} at x = ${fmt(l.at?.x ?? 0)} ${r.lengthUnit}${l.left ? ' (left)' : ''}`;
}

/** A default name for a line: R_A, M_A at a support; M1, V2 … at a section. */
function lineName(r: BeamRegion, q: InfluenceQuantity, support: string | undefined, used: string[]): string {
  const label = r.supports.find((s) => s.id === support)?.label ?? '';
  if (q === 'Ry') return freeName(`R_${label}`, used);
  if (q === 'Rx') return freeName(`H_${label}`, used);
  if (q === 'Mr') return freeName(`M_${label}`, used);
  return freeName(q, used, true);
}

/** A new line: the moment at the middle of the first member of the load path. */
function newLine(r: BeamRegion, used: string[]): BeamInfluenceLine {
  const N = new Map(r.nodes.map((q) => [q.id, q]));
  const horizontal = r.members.filter((m) => Math.abs((N.get(m.a)?.y ?? 0) - (N.get(m.b)?.y ?? 1)) < 1e-9);
  const m = r.members.find((q) => q.deck) ?? horizontal[0] ?? r.members[0];
  const a = m && N.get(m.a), b = m && N.get(m.b);
  const at = a && b ? { x: +((a.x + b.x) / 2).toFixed(6), y: +((a.y + b.y) / 2).toFixed(6) } : { x: 0, y: 0 };
  return { id: beamId('i'), name: lineName(r, 'M', undefined, used), quantity: 'M', at, member: m?.id };
}

export function TrafficProps({ region, result, onChange }: { region: BeamRegion; result?: BeamResult; onChange: (patch: Partial<BeamRegion>) => void }) {
  const tr: BeamTraffic = region.traffic ?? { lines: [], loads: [] };
  const res = result?.traffic;
  const u = units(region);
  const Lm = LENGTH_M[region.lengthUnit] ?? 1;
  const name = region.name.trim() || 'beam';
  const straight = straightBeam(region);
  const N = new Map(region.nodes.map((q) => [q.id, q]));
  const set = (patch: Partial<BeamTraffic>) => {
    const next = { ...tr, ...patch };
    onChange({ traffic: next.lines.length || next.loads.length || next.step ? next : undefined });
  };
  const setLine = (id: string, patch: Partial<BeamInfluenceLine>) => set({ lines: tr.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  const setLoad = (id: string, patch: Partial<BeamMovingLoad>) => set({ loads: tr.loads.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  const err = (id: string) => result?.errors[id] && <div className="region-error">{result.errors[id]}</div>;

  const addLoad = (preset: BeamMovingLoad['preset']) => {
    const p = PRESETS.find((q) => q.preset === preset)!;
    const ml = movingLoad(preset, freeName(p.name, [...tr.loads.map((l) => l.name), ...(region.loadCases?.cases.map((c) => c.name) ?? [])]));
    const patch: Partial<BeamRegion> = {};
    // in the combinations as a variable action: γ_Q 1.35 for road traffic (EN 1990 A2) and cranes
    // (EN 1991-3 A.2), else 1.5; 1 at SLS. Not where another moving load already acts: their
    // extremes would add (alternatives, as a rule)
    const lc = region.loadCases;
    const acting = (c: BeamCombo) => tr.loads.some((l) => c.factors[l.id]?.trim() && Number(c.factors[l.id]) !== 0);
    const gammaQ = preset === 'lm1' || preset === 'crane' ? '1.35' : '1.5';
    if (lc) patch.loadCases = { ...lc, combos: lc.combos.map((c) => (acting(c) ? c : { ...c, factors: { ...c.factors, [ml.id]: c.kind === 'SLS' ? '1' : gammaQ } })) };
    onChange({ ...patch, traffic: { ...tr, loads: [...tr.loads, ml] } });
  };

  /** "at x = 9.8 m, first axle at 11 m →" */
  const where = (e?: Critical | { lead?: number; dir?: 1 | -1 }) => {
    if (!e) return '';
    const parts: string[] = [];
    if ('x' in e && e.x !== undefined) parts.push(`at x = ${fmt(e.x / Lm)} ${region.lengthUnit}`);
    if (e.lead !== undefined) parts.push(`first axle at ${fmt(e.lead / Lm)} ${region.lengthUnit} ${e.dir === -1 ? '←' : '→'}`);
    else if ('x' in e) parts.push('lane load only');
    return parts.join(', ');
  };

  return (
    <>
      <h3 className="sub">Influence lines</h3>
      {tr.lines.map((l) => {
        const reaction = isReaction(l.quantity);
        const peak = res?.lines.find((q) => q.id === l.id);
        // the member and distance of a section on a frame
        const m = region.members.find((q) => q.id === l.member) ?? region.members[0];
        const a = m && N.get(m.a), b = m && N.get(m.b);
        const Lmem = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
        const dist = a && l.at ? Math.hypot(l.at.x - a.x, l.at.y - a.y) : 0;
        const atNode = !reaction && straight && region.nodes.some((q) => Math.abs(q.x - (l.at?.x ?? NaN)) < 1e-9) && straight[0].x0 < (l.at?.x ?? 0) && (l.at?.x ?? 0) < straight[straight.length - 1].x1;
        return (
          <div key={l.id} className="bm-il-item">
            <div className="bm-il-head">
              <LazyInput label="Influence line name" value={l.name} onCommit={(v) => v.trim() && setLine(l.id, { name: v.trim() })} />
              <select aria-label="Quantity" value={l.quantity} onChange={(e) => {
                const q = e.target.value as InfluenceQuantity;
                // a name still the default follows the quantity
                const others = tr.lines.filter((x) => x.id !== l.id).map((x) => x.name);
                const auto = l.name === lineName(region, l.quantity, l.support, others);
                const support = isReaction(q) ? l.support ?? region.supports[0]?.id : undefined;
                const name = auto ? lineName(region, q, support, others) : l.name;
                if (isReaction(q) === reaction) setLine(l.id, { quantity: q, name });
                else if (isReaction(q)) setLine(l.id, { quantity: q, name, support, at: undefined, member: undefined, left: undefined });
                else {
                  const d = newLine(region, []);
                  setLine(l.id, { quantity: q, name, support: undefined, at: d.at, member: d.member });
                }
              }}>
                {QUANTITIES.map((q) => <option key={q.q} value={q.q}>{q.label}</option>)}
              </select>
              <button className="icon-btn" aria-label={`Remove ${l.name}`} title="Remove" onClick={() => set({ lines: tr.lines.filter((q) => q.id !== l.id) })}><Trash2 size={12} /></button>
            </div>
            {reaction ? (
              <label className="field"><span>At support</span>
                <select value={l.support ?? ''} onChange={(e) => {
                  const others = tr.lines.filter((x) => x.id !== l.id).map((x) => x.name);
                  const auto = l.name === lineName(region, l.quantity, l.support, others);
                  setLine(l.id, { support: e.target.value, ...(auto ? { name: lineName(region, l.quantity, e.target.value, others) } : {}) });
                }}>
                  {region.supports.map((s) => <option key={s.id} value={s.id}>{s.label}{s.type === 'fixed' ? ' (fixed)' : ''}</option>)}
                </select>
              </label>
            ) : straight ? (
              <div className="row2">
                <label className="field"><span>Section x ({region.lengthUnit})</span>
                  <input type="number" step="any" value={l.at?.x ?? 0} onChange={(e) => setLine(l.id, { at: { x: Number(e.target.value) || 0, y: N.get(region.members[0].a)?.y ?? 0 }, member: undefined })} />
                </label>
                {atNode && (l.quantity === 'V' || l.quantity === 'N') && (
                  <label className="field" title="At a joint: the member just left or just right of it"><span>Side</span>
                    <select value={l.left ? 'left' : 'right'} onChange={(e) => setLine(l.id, { left: e.target.value === 'left' || undefined })}>
                      <option value="right">Just right</option><option value="left">Just left</option>
                    </select>
                  </label>
                )}
              </div>
            ) : (
              <div className="row2">
                <label className="field"><span>Member</span>
                  <select value={m?.id ?? ''} onChange={(e) => {
                    const mm = region.members.find((q) => q.id === e.target.value)!;
                    const p = N.get(mm.a)!, q = N.get(mm.b)!;
                    setLine(l.id, { member: mm.id, at: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } });
                  }}>
                    {region.members.map((q, i) => <option key={q.id} value={q.id}>{i + 1}{q.deck ? ' (deck)' : ''}</option>)}
                  </select>
                </label>
                <label className="field"><span>From its start ({region.lengthUnit})</span>
                  <input type="number" step="any" min={0} max={Lmem} value={+dist.toFixed(6)} onChange={(e) => {
                    if (!a || !b || !(Lmem > 0)) return;
                    const t = Math.min(1, Math.max(0, Number(e.target.value) / Lmem));
                    setLine(l.id, { member: m.id, at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } });
                  }} />
                </label>
              </div>
            )}
            {err(l.id)}
            {peak && (
              <p className="hint">
                η from {fmt(ordinateValue(region, l.quantity, ilPeak(peak, -1).v))} to {fmt(ordinateValue(region, l.quantity, ilPeak(peak, 1).v))}
                {ordinateUnit(region, l.quantity) === '–' ? ' per unit load' : ` ${ordinateUnit(region, l.quantity)}`}; <code>{name}.IL.{identifierOf(l.name)}(x)</code>
              </p>
            )}
          </div>
        );
      })}
      <div className="row2">
        <button className="btn" disabled={!region.members.length} onClick={() => set({ lines: [...tr.lines, newLine(region, tr.lines.map((l) => l.name))] })}>+ Influence line</button>
        {tr.lines.length > 0 && <label className="check"><input type="checkbox" checked={!tr.hideLines} onChange={(e) => set({ hideLines: !e.target.checked || undefined })} /> Draw them</label>}
      </div>

      <h3 className="sub">Moving loads</h3>
      {tr.loads.map((ml) => (
        <div key={ml.id} className="bm-il-item">
          <div className="bm-il-head">
            <LazyInput label="Moving load name" value={ml.name} onCommit={(v) => v.trim() && setLoad(ml.id, { name: v.trim() })} />
            <select aria-label="Kind of moving load" value={ml.preset} onChange={(e) => {
              const fresh = movingLoad(e.target.value as BeamMovingLoad['preset'], ml.name);
              set({ loads: tr.loads.map((q) => (q.id === ml.id ? { ...fresh, id: ml.id, dir: ml.dir } : q)) });
            }}>
              {PRESETS.map((p) => <option key={p.preset} value={p.preset}>{p.label}</option>)}
            </select>
            <button className="icon-btn" aria-label={`Remove ${ml.name}`} title="Remove" onClick={() => set({ loads: tr.loads.filter((q) => q.id !== ml.id), view: tr.view === ml.id ? undefined : tr.view })}><Trash2 size={12} /></button>
          </div>
          {ml.preset === 'point' && (
            <label className="field" title={`A bare number is ${region.forceUnit}`}><span>P ({region.forceUnit})</span><LazyInput label="Point load" value={ml.P ?? ''} onCommit={(v) => setLoad(ml.id, { P: v.trim() })} /></label>
          )}
          {ml.preset === 'crane' && (
            <div className="row2">
              <label className="field" title={`Each wheel; a bare number is ${region.forceUnit}`}><span>Wheel load P</span><LazyInput label="Wheel load" value={ml.P ?? ''} onCommit={(v) => setLoad(ml.id, { P: v.trim() })} /></label>
              <label className="field" title={`A bare number is ${region.lengthUnit}`}><span>Spacing a</span><LazyInput label="Wheel spacing" value={ml.a ?? ''} onCommit={(v) => setLoad(ml.id, { a: v.trim() })} /></label>
            </div>
          )}
          {ml.preset === 'lm1' && (
            <>
              <div className="row2">
                <label className="field" title="Adjustment factor of the tandem system (national annex; 1 by default)"><span>α<sub>Q</sub></span><LazyInput label="alpha Q" value={ml.alphaQ ?? '1'} onCommit={(v) => setLoad(ml.id, { alphaQ: v.trim() })} /></label>
                <label className="field" title="Adjustment factor of the uniform load (national annex; 1 by default)"><span>α<sub>q</sub></span><LazyInput label="alpha q" value={ml.alphaq ?? '1'} onCommit={(v) => setLoad(ml.id, { alphaq: v.trim() })} /></label>
              </div>
              <label className="field" title="Width of the notional lane the girder carries; a bare number is m (3 m for a lane)"><span>Lane width w (m)</span><LazyInput label="Lane width" value={ml.w ?? '3'} onCommit={(v) => setLoad(ml.id, { w: v.trim() })} /></label>
            </>
          )}
          {ml.preset === 'train' && (
            <>
              <table className="props-table bm-axles">
                <thead><tr><th>Axle</th><th>P ({region.forceUnit})</th><th>a ({region.lengthUnit})</th><th /></tr></thead>
                <tbody>
                  {(ml.axles ?? []).map((ax, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td><LazyInput label={`Axle ${i + 1} load`} value={ax.P} onCommit={(v) => setLoad(ml.id, { axles: ml.axles!.map((q, k) => (k === i ? { ...q, P: v.trim() } : q)) })} /></td>
                      <td>{i > 0 ? <LazyInput label={`Spacing before axle ${i + 1}`} value={ax.a} onCommit={(v) => setLoad(ml.id, { axles: ml.axles!.map((q, k) => (k === i ? { ...q, a: v.trim() } : q)) })} /> : <span className="hint">first</span>}</td>
                      <td>{(ml.axles?.length ?? 0) > 1 && <button className="icon-btn" aria-label={`Remove axle ${i + 1}`} onClick={() => setLoad(ml.id, { axles: ml.axles!.filter((_, k) => k !== i) })}><Trash2 size={12} /></button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn" onClick={() => { const last = ml.axles?.at(-1); setLoad(ml.id, { axles: [...(ml.axles ?? []), { P: last?.P ?? '100', a: last && ml.axles!.length > 1 ? last.a : '2' }] }); }}>+ Axle</button>
              <label className="field" title={`Put only on the adverse parts of each influence line; empty = none. A bare number is ${region.forceUnit}/${region.lengthUnit}`}>
                <span>Uniform load q ({region.forceUnit}/{region.lengthUnit})</span>
                <LazyInput label="Uniform load" value={ml.q ?? ''} placeholder="none" onCommit={(v) => setLoad(ml.id, { q: v.trim() })} />
              </label>
            </>
          )}
          <label className="field"><span>Travels</span>
            <select value={ml.dir ?? 'both'} onChange={(e) => setLoad(ml.id, { dir: e.target.value === 'both' ? undefined : (e.target.value as BeamMovingLoad['dir']) })}>
              <option value="both">Both ways</option><option value="forward">Left to right only →</option><option value="backward">Right to left only ←</option>
            </select>
          </label>
          {err(ml.id)}
          {(() => {
            const m = res?.moving.find((q) => q.id === ml.id);
            if (!m) return null;
            const axles = m.P.length ? `${m.P.length === 1 ? '' : `${m.P.length} × `}${m.P.every((p) => p === m.P[0]) ? u.force(m.P[0]) : m.P.map((p) => fmt(p / u.forceN)).join(' + ') + ` ${region.forceUnit}`}${m.P.length > 1 ? ` over ${fmt(m.offsets.at(-1)! / Lm)} ${region.lengthUnit}` : ''}` : '';
            const lane = m.q ? `${u.line(m.q)} where adverse` : '';
            const env = m.env;
            const ex = env?.extremes;
            const rows: [string, number | undefined, (v: number) => string, Critical | undefined][] = [
              ['M max', ex?.M_max?.value, u.moment, ex?.M_max], ['M min', ex?.M_min?.value, u.moment, ex?.M_min],
              ['V max', ex?.V_max?.value, u.force, ex?.V_max], ['V min', ex?.V_min?.value, u.force, ex?.V_min],
              // vertical, like b.moving.….w_max (the δ label on the drawing is the total displacement)
              ['δy max', ex?.w_max?.value, u.defl, ex?.w_max],
            ];
            return (
              <>
                <p className="hint">{[axles, lane].filter(Boolean).join(', plus ')}.</p>
                {env && (
                  <table className="props-table bm-moving">
                    <tbody>
                      {rows.map(([label, v, f, e]) => (v !== undefined && Math.abs(v) > 0 ? (
                        <tr key={label}><td>{label === 'δy max' ? <>δ<sub>y</sub> max</> : label}</td><td><b>{f(v)}</b> <span className="bm-where">{where(e)}</span></td></tr>
                      ) : null))}
                      {region.supports.map((s) => {
                        const rs = env.reactions[s.id];
                        if (!rs) return null;
                        // a fixed support's moment: where the larger of its bounds happens
                        const Mgov = Math.abs(rs.M_min?.value ?? 0) > Math.abs(rs.M_max?.value ?? 0) ? rs.M_min : rs.M_max;
                        return (
                          <Fragment key={s.id}>
                            <tr>
                              <td>R<sub>y</sub> {s.label}</td>
                              <td><b>{u.force(rs.Ry_max?.value ?? 0)}</b> … {u.force(rs.Ry_min?.value ?? 0)} <span className="bm-where">{where(rs.Ry_max)}</span></td>
                            </tr>
                            {s.type === 'fixed' && (
                              <tr>
                                <td>M {s.label}</td>
                                <td><b>{u.moment(rs.M_max?.value ?? 0)}</b> … {u.moment(rs.M_min?.value ?? 0)} <span className="bm-where">{where(Mgov)}</span></td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </>
            );
          })()}
        </div>
      ))}
      <label className="field"><span>Add a moving load</span>
        <select value="" disabled={!region.members.length} onChange={(e) => e.target.value && addLoad(e.target.value as BeamMovingLoad['preset'])}>
          <option value="">Choose…</option>
          {PRESETS.map((p) => <option key={p.preset} value={p.preset}>{p.label}</option>)}
        </select>
      </label>
      {(tr.lines.length > 0 || tr.loads.length > 0) && (
        <>
          <label className="field" title={`Spacing of the load positions; a bare number is ${region.lengthUnit}. Empty: a round step near 1/200 of the path that the axle spacings divide`}>
            <span>Step Δx</span>
            <LazyInput label="Step" value={tr.step ?? ''} placeholder={res?.step ? `auto: ${fmt(res.step / Lm)} ${region.lengthUnit}` : 'auto'} onCommit={(v) => set({ step: v.trim() || undefined })} />
          </label>
          {res?.error && <div className="region-error">{res.error}</div>}
          {res && !res.error && (
            <p className="hint">
              Load path: {res.path.length === region.members.length ? 'the whole beam' : `member${res.path.length > 1 ? 's' : ''} ${res.path.map((p) => region.members.findIndex((m) => m.id === p.member) + 1).join(', ')}`}
              {' '}from x = {fmt(res.path[0].x0 / Lm)} to {fmt(res.path[res.path.length - 1].x1 / Lm)} {region.lengthUnit}, {res.xs.length} load positions.
              {res.adjusted ? ` Δx is ${fmt(res.step / Lm)} ${region.lengthUnit}: ${res.adjusted === 'widened' ? `at most ${MAX_POSITIONS} positions` : `at least ${MIN_STEPS} steps`}.` : ''}
              {!straight && !region.members.some((m) => m.deck) ? ' Mark the deck members (select one → Load path) if the loads travel elsewhere.' : ''}
            </p>
          )}
          <p className="hint">
            A unit load walks along the path; each axle train stops with every axle on every position, both ways, and a uniform load goes only where the influence line is adverse.
            {region.loadCases ? ' In the combinations each moving load has its own factor column.' : ' Use load cases to combine them with the other loads.'}
            {' '}Worksheet: <code>{name}.IL.M1(x)</code>, <code>{name}.moving.{identifierOf(tr.loads[0]?.name ?? 'LM1')}.M_max</code> with <code>x_M_max</code> (section) and <code>pos_M_max</code> (first axle), <code>.A.Ry_max</code>, and the envelope as <code>.max.M(x)</code>, <code>.min.M(x)</code>.
            {region.analysis?.secondOrder ? ' Moving loads are added linearly (first order) to the second-order static part.' : ''}
          </p>
        </>
      )}
    </>
  );
}
