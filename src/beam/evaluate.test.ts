import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type BeamResult, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type BeamRegion } from '../model/types';
import { splitMember, removeItems, type BeamData } from './model';
import type { BeamSolution } from './solve';

function simpleBeam(): BeamData {
  return {
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 6, y: 0 }],
    members: [{ id: 'm', a: 'a', b: 'b' }],
    supports: [{ id: 's1', node: 'a', type: 'pin', angle: 0, label: 'A' }, { id: 's2', node: 'b', type: 'roller', angle: 0, label: 'B' }],
    loads: [
      { id: 'q', type: 'line', member: 'm', q1: 'q', dir: 'global' },
      { id: 'P', type: 'force', at: { member: 'm', t: 0.5 }, value: 'P', angle: -90 },
    ],
  };
}

function run(data: BeamData, lines: string[], extra: Partial<BeamRegion> = {}) {
  const ws = emptyWorksheet();
  const pre = ['q := 10 kN/m', 'P := 20 kN'].map((s, i) => createRegion('math', 20, 20 + 20 * i, { source: s }));
  const beam = createRegion('beam', 20, 100, { name: 'b', ...data, ...extra }) as BeamRegion;
  const maths = lines.map((s, i) => createRegion('math', 20, 500 + 20 * i, { source: s }));
  ws.regions = [...pre, beam, ...maths];
  const out = evaluateWorksheet(ws);
  const tex = (i: number) => {
    const m = out.results.get(maths[i].id) as MathResult;
    expect(m.error, lines[i]).toBeUndefined();
    return m.tex;
  };
  return { res: out.results.get(beam.id) as BeamResult, tex };
}

describe('beam region in a worksheet', () => {
  it('reads loads from the worksheet and exports reactions, extremes and functions', () => {
    const { res, tex } = run(simpleBeam(), ['b.A.Ry = kN', 'b.M_max = kN*m', 'b.M(3 m) = kN*m', 'b.V(1 m) = kN', 'b.w(3 m) = mm', 'b.σ_max = MPa', 'b.L = m']);
    expect(res.error).toBeUndefined();
    // 10 kN/m over 6 m plus 20 kN at midspan: R = 40 kN, M = 45 + 30 = 75 kN·m
    expect(tex(0)).toContain('40');
    expect(tex(1)).toContain('75');
    expect(tex(2)).toContain('75');
    expect(tex(3)).toContain('30'); // 40 − 10·1
    const EI = 210e9 * 8356e-8;
    const w = (5 * 10e3 * 6 ** 4) / (384 * EI) + (20e3 * 6 ** 3) / (48 * EI);
    expect(tex(4)).toContain((-w * 1000).toFixed(4));
    expect(tex(5)).toContain('134.6');
    expect(tex(6)).toContain('6');
  });

  it('reports bad expressions and unstable structures', () => {
    const d = simpleBeam();
    d.loads[1] = { ...d.loads[1], value: '5 m' } as BeamData['loads'][number];
    const bad = run(d, []).res;
    expect(bad.errors.P).toMatch(/units like kN/);
    const mech = simpleBeam();
    mech.supports[0].type = 'roller';
    expect(run(mech, []).res.error).toMatch(/mechanism/);
  });

  it('splits members and keeps loads on the right piece', () => {
    const d = simpleBeam();
    const { data, node } = splitMember(d, 'm', 0.25);
    expect(data.members).toHaveLength(2);
    expect(data.nodes.find((q) => q.id === node)).toMatchObject({ x: 1.5, y: 0 });
    // the line load is split in two, the point load moves to the second piece at the same spot
    expect(data.loads.filter((l) => l.type === 'line')).toHaveLength(2);
    const P = data.loads.find((l) => l.id === 'P')!;
    expect(P.type === 'force' && 'member' in P.at && P.at.t).toBeCloseTo((0.5 - 0.25) / 0.75, 12);
    // same answer after the split
    const a = run(simpleBeam(), ['b.M_max = kN*m']).tex(0);
    const b = run(data, ['b.M_max = kN*m']).tex(0);
    expect(b).toBe(a);
    // removing a node takes its members, supports and loads with it
    const r = removeItems(data, new Set([node]));
    expect(r.members).toHaveLength(0);
    expect(r.loads).toHaveLength(0);
  });
});

describe('load cases and combinations', () => {
  const cases = () => ({
    cases: [{ id: 'G', name: 'G' }, { id: 'Q', name: 'Q' }],
    combos: [
      { id: 'uls', name: 'ULS', kind: 'ULS' as const, factors: { G: '1.35', Q: '1.5' } },
      { id: 'sls', name: 'SLS', kind: 'SLS' as const, factors: { G: '1', Q: '1' } },
    ],
  });

  it('solves each combination with factored loads and exports governing values', () => {
    const data = simpleBeam();
    data.loads = [
      { id: 'g', type: 'line', member: 'm', q1: 'q', dir: 'global', case: 'G' },
      { id: 'p', type: 'force', at: { member: 'm', t: 0.5 }, value: 'P', angle: -90, case: 'Q' },
    ];
    const { res, tex } = run(data, ['b.M_max = kN*m', 'b.combos.SLS.M_max = kN*m', 'b.cases.Q.A.Ry = kN', 'b.A.Ry = kN', 'b.w_max = mm', 'b.combos.SLS.w_max = mm'], { loadCases: cases() });
    expect(res.error).toBeUndefined();
    // ULS: 1.35 · 45 + 1.5 · 30 = 105.75 kN·m; SLS: 75 kN·m
    expect(tex(0)).toContain('105.75');
    expect(tex(1)).toContain('75');
    expect(tex(2)).toContain('10');
    // ULS reaction 1.35 · 30 + 1.5 · 10 = 55.5 kN
    expect(tex(3)).toContain('55.5');
    // deflection over the SLS combination
    expect(tex(4).split('=')[1]).toBe(tex(5).split('=')[1]);
    expect(res.view).toBe('uls');
    expect(res.combos?.map((c) => c.name)).toEqual(['ULS', 'SLS']);
  });

  it('builds envelopes over pattern loads', () => {
    // two spans; imposed load on either span is its own case
    const data: BeamData = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 5, y: 0 }, { id: 'c', x: 10, y: 0 }],
      members: [{ id: 'm1', a: 'a', b: 'b' }, { id: 'm2', a: 'b', b: 'c' }],
      supports: [
        { id: 's1', node: 'a', type: 'pin', angle: 0, label: 'A' },
        { id: 's2', node: 'b', type: 'roller', angle: 0, label: 'B' },
        { id: 's3', node: 'c', type: 'roller', angle: 0, label: 'C' },
      ],
      loads: [
        { id: 'q1', type: 'line', member: 'm1', q1: 'q', dir: 'global', case: 'Q1' },
        { id: 'q2', type: 'line', member: 'm2', q1: 'q', dir: 'global', case: 'Q2' },
      ],
    };
    const lc = {
      cases: [{ id: 'Q1', name: 'Q1' }, { id: 'Q2', name: 'Q2' }],
      combos: [
        { id: 'a', name: 'span1', kind: 'ULS' as const, factors: { Q1: '1', Q2: '0' } },
        { id: 'b', name: 'span2', kind: 'ULS' as const, factors: { Q1: '0', Q2: '1' } },
        { id: 'c', name: 'both', kind: 'ULS' as const, factors: { Q1: '1', Q2: '1' } },
      ],
      view: 'envelope',
    };
    const { res } = run(data, [], { loadCases: lc });
    expect(res.error).toBeUndefined();
    const env = res.envelope!;
    const m1max = env.max.members[0], m1min = env.min.members[0];
    // largest span moment: span 1 loaded alone, 0.0957 q L² = 23.9 kN·m (exact 49/512 q L²)
    expect(Math.max(...m1max.M) / 1e3).toBeCloseTo((49 / 512) * 10 * 25, 1);
    // support moment: both spans, −q L²/8 = −31.25 kN·m
    expect(Math.min(...m1min.M) / 1e3).toBeCloseTo(-31.25, 1);
    expect(res.solution).toBe(env.max);
    expect(env.max.max.M!.value / 1e3).toBeCloseTo(-31.25, 1);
  });
});

describe('shear deformation, second order and buckling in a worksheet', () => {
  // a 4 m column, fixed foot, pushed down by P at the head (default section IPE 300)
  const columnData = (): BeamData => ({
    nodes: [{ id: 'f', x: 0, y: 0 }, { id: 'h', x: 0, y: 4 }],
    members: [{ id: 'c', a: 'f', b: 'h' }],
    supports: [{ id: 's', node: 'f', type: 'fixed', angle: 0, label: 'A' }],
    loads: [
      { id: 'N', type: 'force', at: { node: 'h' }, value: '200', angle: -90, case: 'G' },
      { id: 'H', type: 'force', at: { node: 'h' }, value: '5', angle: 0, case: 'Q' },
    ],
  });
  const EI = 210e9 * 8356e-8;
  // the number after "=" in the result's TeX ("… = 8\\ \\mathrm{m}")
  const num = (tex: string) => Number(/[-−]?\d+(?:\.\d+)?(?:e[-+]?\d+)?/.exec(tex.split('=').at(-1)!)![0].replace('−', '-'));

  it('Timoshenko cantilever: δ = P L³/3EI + P L/(G A_v), G from ν = 0.3, A_v of the IPE 300', () => {
    const d: BeamData = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1.5, y: 0 }],
      members: [{ id: 'm', a: 'a', b: 'b' }],
      supports: [{ id: 's', node: 'a', type: 'fixed', angle: 0, label: 'A' }],
      loads: [{ id: 'P', type: 'force', at: { node: 'b' }, value: '100', angle: -90 }],
    };
    const G = 210e9 / 2.6, Av = 25.68e-4, P = 100e3, L = 1.5;
    const { res, tex } = run(d, ['b.w_max = mm'], { analysis: { shear: true } });
    expect(res.section?.G).toBeCloseTo(G, 0);
    expect(res.section!.Av! * 1e4).toBeCloseTo(25.68, 1);
    expect(num(tex(0))).toBeCloseTo(((P * L ** 3) / (3 * EI) + (P * L) / (G * Av)) * 1000, 2);
    // without the option: bending only
    expect(num(run(d, ['b.w_max = mm']).tex(0))).toBeCloseTo(((P * L ** 3) / (3 * EI)) * 1000, 2);
  });

  it('α_cr, its modes and the buckling lengths', () => {
    const d = columnData();
    d.loads = d.loads.map((l) => ({ ...l, case: undefined }));
    const { res, tex } = run(d, ['b.alpha_cr =', 'b.L_cr[0] = m', 'b.α_cr_modes[1] / b.α_cr ='], { analysis: { buckling: true } });
    expect(res.error).toBeUndefined();
    // cantilever: P_cr = π² EI / (2L)² = 2706 kN against 200 kN
    const Pcr = (Math.PI ** 2 * EI) / 64;
    expect(num(tex(0)) / (Pcr / 200e3)).toBeCloseTo(1, 3);
    expect(num(tex(1))).toBeCloseTo(8, 2);
    // the second cantilever mode: (3π/2)² / (π/2)² = 9
    expect(num(tex(2))).toBeCloseTo(9, 1);
    expect(res.buckling?.modes).toHaveLength(3);
  });

  it('second order per combination, with the first-order values beside it', () => {
    const lc = {
      cases: [{ id: 'G', name: 'G' }, { id: 'Q', name: 'Q' }],
      combos: [
        { id: 'u', name: 'ULS', kind: 'ULS' as const, factors: { G: '1.35', Q: '1.5' } },
        { id: 'k', name: 'SLS', kind: 'SLS' as const, factors: { G: '1', Q: '1' } },
      ],
    };
    const { res, tex } = run(columnData(), ['b.M_max = kN*m', 'b.first.M_max = kN*m', 'b.combos.ULS.alpha_cr =', 'b.alpha_cr ='], { loadCases: lc, analysis: { secondOrder: true } });
    expect(res.error).toBeUndefined();
    // first order: 1.5 · 5 kN · 4 m = 30 kN·m at the foot (hogging)
    expect(num(tex(1))).toBeCloseTo(-30, 6);
    // second order: H tan(kL)/k with P = 270 kN
    const P = 270e3, k = Math.sqrt(P / EI), H = 7.5e3;
    expect(num(tex(0)) / (-(H * Math.tan(k * 4)) / k / 1e3)).toBeCloseTo(1, 2);
    const Pcr = (Math.PI ** 2 * EI) / 64;
    expect(num(tex(2))).toBeCloseTo(Pcr / P, 1);
    expect(num(tex(3))).toBeCloseTo(Pcr / P, 1);
    expect(res.combos?.every((c) => c.solution?.secondOrder)).toBe(true);
  });

  it('envelopes over second-order combinations', () => {
    const lc = {
      cases: [{ id: 'G', name: 'G' }, { id: 'Q', name: 'Q' }],
      combos: [
        { id: 'u1', name: 'ULS1', kind: 'ULS' as const, factors: { G: '1.35', Q: '1.5' } },
        { id: 'u2', name: 'ULS2', kind: 'ULS' as const, factors: { G: '1.35', Q: '-1.5' } },
      ],
      view: 'envelope',
    };
    const { res } = run(columnData(), [], { loadCases: lc, analysis: { secondOrder: true } });
    expect(res.error).toBeUndefined();
    // wind either way: the envelope holds both foot moments, ± H tan(kL)/k
    const P = 270e3, k = Math.sqrt(P / EI), M = (7.5e3 * Math.tan(k * 4)) / k;
    const foot = (sol: BeamSolution) => sol.members[0].M[0];
    expect(foot(res.envelope!.max) / M).toBeCloseTo(1, 2);
    expect(foot(res.envelope!.min) / -M).toBeCloseTo(1, 2);
    expect(res.solution).toBe(res.envelope!.max);
    // the buckling shown is the lowest combination's (both are the same here)
    expect(res.buckling?.modes[0].alpha).toBeCloseTo((Math.PI ** 2 * EI) / 64 / P, 1);
  });

  it('a combination above the critical load fails on its own', () => {
    const d = columnData();
    d.loads[0] = { ...d.loads[0], value: '3000' } as BeamData['loads'][number];
    const lc = {
      cases: [{ id: 'G', name: 'G' }, { id: 'Q', name: 'Q' }],
      combos: [
        { id: 'u', name: 'ULS', kind: 'ULS' as const, factors: { G: '1.35', Q: '1.5' } },
        { id: 'w', name: 'Wind', kind: 'ULS' as const, factors: { G: '0', Q: '1.5' } },
      ],
    };
    const { res, tex } = run(d, ['b.alpha_cr =', 'b.combos.Wind.M_max = kN*m'], { loadCases: lc, analysis: { secondOrder: true } });
    expect(res.combos![0].error).toMatch(/critical load/);
    expect(res.error).toMatch(/ULS/);
    expect(res.combos![1].solution).toBeDefined();
    expect(num(tex(0))).toBeLessThan(1);
    expect(num(tex(1))).toBeCloseTo(-30, 6);
    // without load cases: the error, and α_cr still in the worksheet
    d.loads = d.loads.map((l) => ({ ...l, case: undefined }));
    const one = run(d, ['b.alpha_cr ='], { analysis: { secondOrder: true } });
    expect(one.res.error).toMatch(/^Above the elastic critical load/);
    expect(num(one.tex(0))).toBeCloseTo((Math.PI ** 2 * EI) / 64 / 3000e3, 3);
  });

  it('two equal columns above the critical load are refused (a repeated α_cr)', () => {
    // both cantilevers pass P_cr = π²EI/(2L)² = 2706 kN together: two stiffnesses turn
    // negative at once, which the determinant's sign does not show; α_cr does (4000 kN: 0.677)
    const d: BeamData = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 4 }, { id: 'c', x: 5, y: 0 }, { id: 'e', x: 5, y: 4 }],
      members: [{ id: 'm1', a: 'a', b: 'b' }, { id: 'm2', a: 'c', b: 'e' }],
      supports: [{ id: 's1', node: 'a', type: 'fixed', angle: 0, label: 'A' }, { id: 's2', node: 'c', type: 'fixed', angle: 0, label: 'C' }],
      loads: [
        { id: 'P1', type: 'force', at: { node: 'b' }, value: '4000', angle: -90 },
        { id: 'P2', type: 'force', at: { node: 'e' }, value: '4000', angle: -90 },
        { id: 'H', type: 'force', at: { node: 'b' }, value: '1', angle: 0 },
      ],
    };
    const { res, tex } = run(d, ['b.alpha_cr ='], { analysis: { secondOrder: true } });
    expect(res.solution).toBeUndefined();
    expect(res.error).toMatch(/critical load/);
    expect(num(tex(0))).toBeCloseTo((Math.PI ** 2 * EI) / 64 / 4000e3, 3);
    expect(res.buckling!.modes[1].alpha / res.buckling!.modes[0].alpha).toBeCloseTo(1, 6);
  });
});
