import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type BeamResult, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type BeamRegion } from '../model/types';
import type { Unit } from 'mathjs';
import { math } from '../engine/math';
import { beamValue, lowerBound } from './evaluate';
import { solveStructure } from './solve';
import { autoStep } from './traffic';
import type { BeamCases, BeamData, BeamTraffic } from './model';

/** A simple span of L metres, IPE 300 (the default section). */
function span(L: number): BeamData {
  return {
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: L, y: 0 }],
    members: [{ id: 'm', a: 'a', b: 'b' }],
    supports: [{ id: 'sA', node: 'a', type: 'pin', angle: 0, label: 'A' }, { id: 'sB', node: 'b', type: 'roller', angle: 0, label: 'B' }],
    loads: [],
  };
}

const lm1 = (extra: Partial<BeamTraffic['loads'][number]> = {}): BeamTraffic['loads'][number] => ({ id: 'lm', name: 'LM1', preset: 'lm1', alphaQ: '1', alphaq: '1', w: '3', ...extra });

function run(data: BeamData, traffic: BeamTraffic, lines: string[], extra: Partial<BeamRegion> = {}) {
  const ws = emptyWorksheet();
  const beam = createRegion('beam', 20, 100, { name: 'b', ...data, traffic, ...extra }) as BeamRegion;
  const maths = lines.map((s, i) => createRegion('math', 20, 500 + 20 * i, { source: s }));
  ws.regions = [createRegion('math', 20, 20, { source: 'g_k := 10 kN/m' }), beam, ...maths];
  const out = evaluateWorksheet(ws);
  const res = out.results.get(beam.id) as BeamResult;
  /** The worksheet's text for line i. */
  const text = (i: number) => {
    const m = out.results.get(maths[i].id) as MathResult;
    expect(m.error, lines[i]).toBeUndefined();
    return m.text ?? '';
  };
  /** A value of b (a function is called with `arg`), as a number in `unit`. */
  const value = beamValue(beam, res);
  const num = (path: string, unit?: string, arg?: string) => {
    let v: unknown = value;
    for (const k of path.split('.')) v = (v as Record<string, unknown>)[k];
    if (typeof v === 'function') v = v(math.evaluate(arg!));
    return unit ? ((v as Unit).toNumeric(unit) as number) : (v as number);
  };
  return { res, text, num };
}

describe('moving loads in a beam region', () => {
  it('EN 1991-2 LM1 on a 20 m span: tandem 2 × 300 kN at 1.2 m plus 9 kN/m² × 3 m', () => {
    const { res, text, num } = run(span(20), { lines: [], loads: [lm1()] }, ['b.moving.LM1.max.M(10 m) = kN*m', 'b.moving.LM1.A.Ry_max = kN']);
    expect(res.error).toBeUndefined();
    // at midspan: axles at 10 and 11.2 m, M = 300·10·10/20 + 300·10·8.8/20 = 2820, plus q L²/8 = 27·400/8 = 1350
    expect(num('moving.LM1.max.M', 'kN m', '10 m')).toBeCloseTo(4170, 6);
    expect(text(0)).toBe('4170 kN m');
    // anywhere: M(x) = 300 x (2L − 2x − 1.2)/L + 13.5 x (L − x) = 852 x − 43.5 x², largest at x = 9.793 (9.8 on the 0.1 m grid)
    expect(num('moving.LM1.M_max', 'kN m')).toBeCloseTo(852 * 9.8 - 43.5 * 9.8 ** 2, 6);
    expect(Math.abs(num('moving.LM1.x_M_max', 'm') - 10)).toBeCloseTo(0.2, 9);
    // the tandem's first axle over the section, or 1.2 m past it (travelling back)
    expect([9.8, 11, 10.2, 9].map((x) => Math.abs(num('moving.LM1.pos_M_max', 'm') - x) < 1e-9)).toContain(true);
    // R_A: both axles at A's end, 300 + 300·18.8/20 = 582, plus 27·20/2 = 270
    expect(num('moving.LM1.A.Ry_max', 'kN')).toBeCloseTo(852, 6);
    expect(text(1)).toBe('852 kN');
    expect(num('moving.LM1.V_max', 'kN')).toBeCloseTo(852, 6);
  });

  it('a crane: two wheels P at a, absolute M_max = P(2L − a)²/(8L) at L/2 − a/4', () => {
    const { num } = run(span(10), { lines: [], loads: [{ id: 'c', name: 'crane', preset: 'crane', P: '80', a: '3.5' }], step: '0.025' }, []);
    expect(num('moving.crane.M_max', 'kN m')).toBeCloseTo((80 * (20 - 3.5) ** 2) / 80, 6);
    expect(Math.abs(num('moving.crane.x_M_max', 'm') - 5)).toBeCloseTo(3.5 / 4, 9);
  });

  it('in a combination: static part plus the factored moving extreme', () => {
    const data = span(20);
    data.loads = [{ id: 'g', type: 'line', member: 'm', q1: 'g_k', dir: 'global', case: 'G' }];
    const lc: BeamCases = {
      cases: [{ id: 'G', name: 'G' }],
      combos: [
        { id: 'u', name: 'ULS', kind: 'ULS', factors: { G: '1.35', lm: '1.35' } },
        { id: 's', name: 'SLS', kind: 'SLS', factors: { G: '1', lm: '1' } },
      ],
    };
    const { res, text, num } = run(data, { lines: [], loads: [lm1()] }, ['b.combos.ULS.M(10 m) = kN*m'], { loadCases: lc });
    expect(res.error).toBeUndefined();
    // 1.35 (10·400/8 + 4170) = 6304.5 at midspan
    expect(num('combos.ULS.M', 'kN m', '10 m')).toBeCloseTo(1.35 * (500 + 4170), 6);
    expect(text(0)).toBe('6304.5 kN m');
    // governing: 1.35 (952 x − 48.5 x²) at x = 9.8
    expect(num('M_max', 'kN m')).toBeCloseTo(1.35 * (952 * 9.8 - 48.5 * 9.8 ** 2), 5);
    // the lower bound: LM1 away, only 1.35 G
    expect(num('combos.ULS.min.M', 'kN m', '10 m')).toBeCloseTo(1.35 * 500, 6);
    // the reaction: 1.35 (100 + 852)
    expect(num('A.Ry', 'kN')).toBeCloseTo(1.35 * 952, 6);
    // SLS: G + LM1 at midspan, 5 g L⁴/384 EI plus LM1's; δ_LM1 ≥ its UDL's 5 q L⁴/384 EI
    const EI = 210e9 * 8356e-8;
    expect(num('w_max', 'mm')).toBeGreaterThan(((5 * (10e3 + 27e3) * 20 ** 4) / (384 * EI)) * 1000);
    const uls = res.combos!.find((c) => c.id === 'u')!;
    expect(uls.range).toBeDefined();
    // the envelope over the combinations includes both bounds
    expect(Math.max(...res.envelope!.max.members[0].M) / 1e3).toBeCloseTo(1.35 * (952 * 9.8 - 48.5 * 9.8 ** 2), 5);
  });

  it('shows a moving load without changing the worksheet values of the loads', () => {
    const data = span(20);
    data.loads = [{ id: 'g', type: 'line', member: 'm', q1: 'g_k', dir: 'global' }];
    const { res, num } = run(data, { lines: [], loads: [lm1()], view: 'lm' }, []);
    expect(res.view).toBe('lm');
    expect(res.solution).toBe(res.traffic!.moving[0].env!.max);
    expect(lowerBound(res)).toBe(res.traffic!.moving[0].env!.min);
    expect(num('M_max', 'kN m')).toBeCloseTo(500, 6);
    // a moving load does not hog a simple span
    expect(Math.abs(num('moving.LM1.M_min', 'kN m'))).toBeLessThan(1e-6);
  });

  it('showing a moving load keeps α_cr in the worksheet, and lends nothing when the loads fail', () => {
    // a 10 m strut on a pin and a roller, pushed at the roller: P_cr = π²EI/L² = 1732 kN
    const strut = (P: string): BeamData => ({ ...span(10), loads: [{ id: 'P', type: 'force', at: { node: 'b' }, value: P, angle: 180 }] });
    const Pcr = (Math.PI ** 2 * 210e9 * 8356e-8) / 100;
    const tr = (view?: string): BeamTraffic => ({ lines: [], loads: [{ id: 'p', name: 'P', preset: 'point', P: '10' }], view });
    for (const view of [undefined, 'p']) {
      const { res, num } = run(strut('100'), tr(view), [], { analysis: { buckling: true } });
      expect(res.view).toBe(view);
      expect(num('alpha_cr')).toBeCloseTo(Pcr / 100e3, 2);
      expect(num('M_max', 'kN m')).toBeCloseTo(0, 9);
    }
    // above the critical load in second order the loads have no solution: α_cr only, not
    // the moving load's envelope in its place
    const { res, num } = run(strut('2000'), tr('p'), [], { analysis: { secondOrder: true } });
    expect(res.solution).toBe(res.traffic!.moving[0].env!.max);
    expect(num('alpha_cr')).toBeCloseTo(Pcr / 2000e3, 2);
    expect(num('M_max')).toBeUndefined();
    // the moving load itself still reports: PL/4
    expect(num('moving.P.M_max', 'kN m')).toBeCloseTo(25, 6);
  });

  it('exports influence lines as functions with units', () => {
    const traffic: BeamTraffic = {
      lines: [
        { id: 'i1', name: 'M1', quantity: 'M', at: { x: 10, y: 0 } },
        { id: 'i2', name: 'RA', quantity: 'Ry', support: 'sA' },
        { id: 'i3', name: 'V1', quantity: 'V', at: { x: 5, y: 0 } },
        { id: 'i4', name: 'w1', quantity: 'w', at: { x: 10, y: 0 } },
      ],
      loads: [],
    };
    const { res, text, num } = run(span(20), traffic, ['b.IL.M1(5 m) = m', 'b.IL.RA(15 m) =']);
    expect(res.errors).toEqual({});
    expect(num('IL.M1', 'm', '5 m')).toBeCloseTo(2.5, 9);
    expect(text(0)).toBe('2.5 m');
    expect(text(1)).toBe('0.25');
    expect(num('IL.M1_max', 'm')).toBeCloseTo(5, 9);
    expect(num('IL.RA', undefined, '5 m')).toBeCloseTo(0.75, 9);
    // at the section the right-hand side of the jump: 1 − x/L
    expect(num('IL.V1', undefined, '5 m')).toBeCloseTo(0.75, 9);
    expect(num('IL.V1', undefined, '4 m')).toBeCloseTo(-0.2, 9);
    // Maxwell: L³/48EI per kN
    expect(num('IL.w1', 'mm/kN', '10 m')).toBeCloseTo((-(20 ** 3) / (48 * 210e9 * 8356e-8)) * 1e6, 6);
    expect(res.traffic!.lines[0].v.length).toBe(res.traffic!.xs.length);
  });

  it('a frame: the deck carries the loads; errors stay with their item', () => {
    // portal frame, deck 0 … 8 m on columns 5 m high
    const data: BeamData = {
      nodes: [{ id: 'f1', x: 0, y: 0 }, { id: 'c1', x: 0, y: 5 }, { id: 'c2', x: 8, y: 5 }, { id: 'f2', x: 8, y: 0 }],
      members: [{ id: 'k1', a: 'f1', b: 'c1' }, { id: 'd', a: 'c1', b: 'c2', deck: true }, { id: 'k2', a: 'f2', b: 'c2' }],
      supports: [{ id: 'sA', node: 'f1', type: 'fixed', angle: 0, label: 'A' }, { id: 'sD', node: 'f2', type: 'fixed', angle: 0, label: 'D' }],
      loads: [],
    };
    const { res, num } = run(data, {
      lines: [{ id: 'i', name: 'HA', quantity: 'Rx', support: 'sA' }, { id: 'j', name: 'bad', quantity: 'M', at: { x: 3, y: 2 } }],
      loads: [{ id: 'p', name: 'P', preset: 'point', P: '100' }, { id: 'q', name: 'Q', preset: 'point', P: '5 m' }],
    }, []);
    expect(res.traffic!.error).toBeUndefined();
    expect(res.errors.j).toMatch(/not on a member/);
    expect(res.errors.q).toMatch(/units like kN/);
    // over a column the load goes nearly all down it (the column shortens a little, so the
    // deck bends and the far column takes 0.04 %): as the direct solver finds
    const direct = solveStructure({ ...res.traffic!.structure, loads: [{ id: 'P', type: 'force', at: { node: 'c1' }, Fx: 0, Fy: -100e3 }] });
    expect(num('moving.P.A.Ry_max', 'kN')).toBeCloseTo(direct.reactions[0].Ry / 1e3, 9);
    expect(num('moving.P.A.Ry_max', 'kN')).toBeGreaterThan(99.9);
    // A is never lifted (each load position solved directly): its lower bound is the load away
    let least = Infinity;
    for (const x of res.traffic!.xs) {
      const s = solveStructure({ ...res.traffic!.structure, loads: [{ id: 'P', type: 'force', at: { member: 'd', t: x / 8 }, Fx: 0, Fy: -100e3 }] });
      least = Math.min(least, s.reactions[0].Ry);
    }
    expect(least).toBeGreaterThan(0);
    expect(least).toBeLessThan(0.001 * 100e3);
    expect(num('moving.P.A.Ry_min', 'kN')).toBe(0);
    // horizontal thrust line: zero with the load over a column
    const H = res.traffic!.lines[0];
    expect(H.v[0]).toBeCloseTo(0, 9);
    expect(H.v[H.v.length - 1]).toBeCloseTo(0, 9);
  });

  it('chooses a step that the axle spacings divide', () => {
    expect(autoStep(20, [0, 1.2])).toBe(0.1);
    expect(autoStep(100, [0, 1.2])).toBe(0.2);
    expect(autoStep(18, [0, 1.2])).toBe(0.05);
    expect(autoStep(30, [0, 3.5])).toBe(0.1);
  });
});
