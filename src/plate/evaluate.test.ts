import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type MathResult, type PlateResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, parseWorksheet, type PlateRegion } from '../model/types';
import { concreteGrade } from '../engine/materials';
import { rectangle, platePreset, type PlateData, type PlateLoad } from './model';
import { rebarProps, steelArea } from './design';

function run(data: Partial<PlateRegion>, lines: string[], pre: string[] = ['a := 6 m', 'q := 10 kN/m^2']) {
  const ws = emptyWorksheet();
  ws.settings.precision = 10;
  const defs = pre.map((s, i) => createRegion('math', 20, 20 + 20 * i, { source: s }));
  const plate = createRegion('plate', 20, 200, { name: 'p', ...data }) as PlateRegion;
  const maths = lines.map((s, i) => createRegion('math', 20, 700 + 20 * i, { source: s }));
  ws.regions = [...defs, plate, ...maths];
  const out = evaluateWorksheet(ws);
  const num = (i: number) => {
    const m = out.results.get(maths[i].id) as MathResult;
    expect(m.error, lines[i]).toBeUndefined();
    return Number(/(-?[\d.]+(?:e[-+]?\d+)?)/.exec((m.text ?? m.tex).replace(/\\cdot 10\^\{(-?\d+)\}/, 'e$1'))![1]);
  };
  return { res: out.results.get(plate.id) as PlateResult, num, out, maths };
}

const ss = (loads: PlateLoad[], extra: Partial<PlateData> = {}): Partial<PlateRegion> => ({
  outline: [{ x: '0', y: '0' }, { x: 'a', y: '0' }, { x: 'a', y: 'a' }, { x: '0', y: 'a' }],
  edges: [0, 1, 2, 3].map(() => ({ support: 'simple' as const })), openings: [], walls: [], columns: [], loads, loadCases: undefined, ...extra,
});

describe('plate region in a worksheet', () => {
  // E = 30 GPa, ν = 0.3, t = 60 mm: D = E t³ / 12 (1 − ν²) = 593.4 kN·m
  const custom = { material: 'custom', E: '30', nu: '0.3', thickness: '60', mesh: 'a/32' };
  const D = (30e9 * 0.06 ** 3) / (12 * 0.91);

  it('exports Timoshenko’s simply supported square from worksheet values', () => {
    const { res, num } = run({ ...ss([{ id: 'q', type: 'area', q: 'q' }]), ...custom }, [
      'p.w_max = mm', 'p.m_x_max = kN*m/m', 'p.m_y_max = kN*m/m', 'p.w(a/2, a/2) = mm', 'p.m_x(3, 3) = kN*m/m',
      'p.E1.R = kN', 'p.E4.r_max = kN/m', 'p.R_sum = kN', 'p.D = kN*m', 'p.v_x_max = kN/m',
    ]);
    expect(res.error).toBeUndefined();
    expect(res.mesh!.structured).toBe(true);
    const qa4 = (10e3 * 6 ** 4) / D;
    // w_max = 0.00406 q a⁴ / D, M = 0.0479 q a², V_x = 0.420 q a, Q_x = 0.338 q a (Table 8)
    expect(num(0) / (qa4 * 1000)).toBeCloseTo(0.00406, 4);
    expect(num(1) / (10 * 36)).toBeCloseTo(0.0479, 3);
    expect(num(2) / (10 * 36)).toBeCloseTo(0.0479, 3);
    expect(num(3)).toBeCloseTo(num(0), 6);
    expect(num(4)).toBeCloseTo(num(1), 4);
    // each edge carries a quarter of q a² (the corner forces split between them)
    expect(num(5)).toBeCloseTo(10 * 36 / 4, 3);
    expect(num(6) / (10 * 6)).toBeCloseTo(0.42, 2);
    expect(num(7)).toBeCloseTo(360, 6);
    expect(num(8)).toBeCloseTo(D / 1e3, 3);
    expect(num(9) / 60).toBeCloseTo(0.338, 2);
  });

  it('load cases add up: combinations are sums of cases, the governing values ULS (forces) and SLS (deflection)', () => {
    const loads: PlateLoad[] = [{ id: 'g', type: 'area', q: '5', case: 'G' }, { id: 'q', type: 'area', q: '3', case: 'Q' }, { id: 'P', type: 'point', F: '20', x: '2', y: '4', case: 'Q' }];
    const lc = { cases: [{ id: 'G', name: 'G' }, { id: 'Q', name: 'Q' }], combos: [
      { id: 'u', name: 'ULS', kind: 'ULS' as const, factors: { G: '1.35', Q: '1.5' } }, { id: 's', name: 'SLS', kind: 'SLS' as const, factors: { G: '1', Q: '1' } },
    ] };
    const { num } = run({ ...ss(loads), ...custom, loadCases: lc }, [
      'p.cases.G.m_x(2, 4) = kN*m/m', 'p.cases.Q.m_x(2, 4) = kN*m/m', 'p.combos.ULS.m_x(2, 4) = kN*m/m',
      'p.cases.G.w_max = mm', 'p.combos.SLS.w_max = mm', 'p.w_max = mm', 'p.m_x_max = kN*m/m', 'p.combos.ULS.m_x_max = kN*m/m',
      'p.combos.ULS.R_sum = kN', 'p.max.m_x(2, 4) = kN*m/m',
    ]);
    expect(num(2)).toBeCloseTo(1.35 * num(0) + 1.5 * num(1), 6);
    expect(num(5)).toBeCloseTo(num(4), 9);
    expect(num(6)).toBeCloseTo(num(7), 9);
    expect(num(8)).toBeCloseTo(1.35 * 5 * 36 + 1.5 * (3 * 36 + 20), 6);
    expect(num(9)).toBeCloseTo(num(2), 6);
  });

  it('self-weight ρ g t of a concrete slab, and EN 1992 reinforcement from the Wood–Armer moments', () => {
    const { res, num } = run({
      ...ss([{ id: 's', type: 'self' }]), material: 'C30/37', thickness: '250', mesh: '0.25',
      rebar: { steel: 'B500B', cover: '30', bar: '12' },
    }, ['p.R_sum = kN', 'p.m_x_bot_max = kN*m/m', 'p.a_s_x_bot_max = cm^2/m', 'p.a_s_min_x = cm^2/m', 'p.d_y = mm', 'p.a_s_x_bot(a/2, a/2) = cm^2/m', 'p.m_x(a/2, a/2) = kN*m/m']);
    expect(res.error).toBeUndefined();
    // 25 kN/m³ × 0.25 m × 36 m²
    expect(num(0)).toBeCloseTo(25 * 0.25 * 36, 6);
    expect(num(3)).toBeCloseTo(3.223, 3);
    expect(num(4)).toBeCloseTo(202, 9);
    // at the centre m_xy = 0: m*_x = m_x, a_s = m / (0.9 d f_yd)
    const p = rebarProps({ concrete: 'C30/37', steel: 'B500B', t: 0.25, cover: 0.03, bar: 0.012 });
    expect(num(5)).toBeCloseTo(steelArea(num(6) * 1e3, p.dx, p).as * 1e4, 4);
    // the largest bottom moment and a_s belong together
    expect(num(2)).toBeCloseTo(steelArea(num(1) * 1e3, p.dx, p).as * 1e4, 4);
    expect(concreteGrade('C30/37').E_cm * 1e9).toBeCloseTo(res.material!.E, 3);
  });

  it('columns and walls report their reactions; the results go to the page in single precision', () => {
    const { res, num } = run({
      ...ss([{ id: 'q', type: 'area', q: 'q' }], {
        edges: [{ support: 'free' }, { support: 'free' }, { support: 'free' }, { support: 'free' }],
        columns: [{ id: 'c1', name: 'C1', x: '0.2', y: '0.2' }, { id: 'c2', name: 'C2', x: '5.8', y: '0.2' }, { id: 'c3', name: 'C3', x: '5.8', y: '5.8', b: '300', h: '300' }, { id: 'c4', name: 'C4', x: '0.2', y: '5.8', b: '300' }],
        walls: [{ id: 'w', name: 'W1', a: { x: '3', y: '0' }, b: { x: '3', y: '6' } }],
      }), material: 'C30/37', thickness: '200', mesh: '0.2',
    }, ['p.C1.R + p.C2.R + p.C3.R + p.C4.R + p.W1.R = kN', 'p.W1.r_max = kN/m', 'p.C1.R = kN', 'p.C2.R = kN']);
    expect(res.error).toBeUndefined();
    expect(num(0)).toBeCloseTo(360, 4);
    // symmetric about x = 3
    expect(num(2)).toBeCloseTo(num(3), 4);
    expect(num(1)).toBeGreaterThan(0);
    expect(res.fields!.mx).toBeInstanceOf(Float32Array);
    expect(res.solution).toBeUndefined();
    // the page's result is plain data
    expect(() => structuredClone(res)).not.toThrow();
  });

  it('a steel plate gets its surface stress, not reinforcement', () => {
    const steel = platePreset('steel', { length: 'm', force: 'kN' });
    const { res, num } = run({ ...steel, name: 'p' } as Partial<PlateRegion>, ['p.σ_max = MPa', 'p.sigma_max = MPa', 'p.m_x_min = kN*m/m']);
    expect(res.error).toBeUndefined();
    // σ_v at a clamped edge ≥ 6 |m| / t² there (with ν m besides)
    expect(num(0)).toBeCloseTo(num(1), 9);
    expect(num(0)).toBeGreaterThan((6 * Math.abs(num(2)) * 1e3) / 0.02 ** 2 / 1e6 * 0.85);
  });

  it('reports problems on their items and keeps the rest of the sheet going', () => {
    const { res } = run({ ...ss([{ id: 'q', type: 'area', q: '3 kN' }]), material: 'C24' }, []);
    expect(res.errors.material).toMatch(/isotropic/);
    expect(res.errors.q).toMatch(/expected units/);
    const nosup = run({ ...ss([{ id: 'q', type: 'area', q: 'q' }]), edges: [] }, []);
    expect(nosup.res.error).toMatch(/supports/);
    const outside = run({ ...ss([{ id: 'q', type: 'area', q: 'q' }]), ...custom }, ['p.w(7 m, 1 m) = mm']);
    const m = outside.out.results.get(outside.maths[0].id) as MathResult;
    expect(m.error).toMatch(/not on the plate/);
  });

  it('a second evaluation reuses the solution; a worksheet saved before plates still opens', () => {
    const data = { ...ss([{ id: 'q', type: 'area', q: 'q' }]), ...custom };
    expect(run(data, []).res.cached).toBeDefined();
    expect(run(data, []).res.cached).toBe(true);
    const old = parseWorksheet(JSON.stringify({ format: 'mathstudii', version: 1, title: 'Old', settings: {}, regions: [{ id: 'm', kind: 'math', x: 0, y: 0, source: 'x := 2' }] }));
    expect(evaluateWorksheet(old).errorCount).toBe(0);
  });

  it('presets solve', () => {
    for (const kind of ['simple', 'flat', 'circle', 'lshape'] as const) {
      const p = platePreset(kind, { length: 'm', force: 'kN' });
      const { res } = run({ ...p } as Partial<PlateRegion>, [], []);
      expect(res.error, kind).toBeUndefined();
      expect(res.fields!.w.length).toBeGreaterThan(50);
    }
    expect(rectangle(2, 1)).toEqual([{ x: '0', y: '0' }, { x: '2', y: '0' }, { x: '2', y: '1' }, { x: '0', y: '1' }]);
  });
});
