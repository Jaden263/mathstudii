import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type Frame3DResult, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type Frame3DRegion } from '../model/types';
import { sectionProps } from '../engine/sections';
import { framePreset, type Frame3DData, type F3Load } from './model';

const ipe300 = sectionProps('IPE 300'), heb200 = sectionProps('HEB 200');
const E = 210e9;

function cantilever(loads: F3Load[], extra: Partial<Frame3DData> = {}): Frame3DData {
  return {
    nodes: [{ id: 'a', name: 'N1', x: '0', y: '0', z: '0' }, { id: 'b', name: 'N2', x: 'L', y: '0', z: '0' }],
    members: [{ id: 'm', name: 'M1', a: 'a', b: 'b', section: 's' }],
    sections: [{ id: 's', name: 'S1', profile: 'IPE 300', material: 'S355' }],
    supports: [{ id: 'p', node: 'a', dofs: ['fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed'] }],
    loads,
    ...extra,
  };
}

function run(data: Frame3DData, lines: string[], extra: Partial<Frame3DRegion> = {}) {
  const ws = emptyWorksheet();
  ws.settings.precision = 12;
  const pre = ['L := 3 m', 'P := 10 kN', 'q := 4 kN/m'].map((s, i) => createRegion('math', 20, 20 + 20 * i, { source: s }));
  const frame = createRegion('frame3d', 20, 100, { name: 'f', ...data, ...extra }) as Frame3DRegion;
  const maths = lines.map((s, i) => createRegion('math', 20, 600 + 20 * i, { source: s }));
  ws.regions = [...pre, frame, ...maths];
  const out = evaluateWorksheet(ws);
  const num = (i: number) => {
    const m = out.results.get(maths[i].id) as MathResult;
    expect(m.error, lines[i]).toBeUndefined();
    return Number(/(-?[\d.]+(?:e[-+]?\d+)?)/.exec((m.text ?? m.tex).replace(/\\cdot 10\^\{(-?\d+)\}/, 'e$1'))![1]);
  };
  return { res: out.results.get(frame.id) as Frame3DResult, num, out, maths };
}

describe('3-D frame region in a worksheet', () => {
  it('reads the frame from the worksheet and exports reactions, displacements and forces', () => {
    const { res, num } = run(cantilever([{ id: 'P', type: 'node', node: 'b', Fz: '-P' }]), [
      'f.N2.uz = mm', 'f.N1.Rz = kN', 'f.N1.My = kN*m', 'f.M1.My(0 m) = kN*m', 'f.M1.My_min = kN*m', 'f.M1.Vz(1 m) = kN', 'f.u_max = mm', 'f.M1.L = m',
    ]);
    expect(res.error).toBeUndefined();
    // δ = P L³ / 3EI_y with the library's I_y of an IPE 300
    expect(num(0)).toBeCloseTo((-10e3 * 27) / (3 * E * ipe300.I_y * 1e-12) * 1000, 3);
    expect(num(1)).toBeCloseTo(10, 6);
    // the clamp's moment about global Y: r × F = (L, 0, 0) × (0, 0, −P) = (0, P L, 0); the reaction is its opposite
    expect(num(2)).toBeCloseTo(-30, 6);
    // member axes (z down): hogging at the clamp, M_y = −P L
    expect(num(3)).toBeCloseTo(-30, 6);
    expect(num(4)).toBeCloseTo(-30, 6);
    expect(num(5)).toBeCloseTo(10, 6);
    expect(num(6)).toBeCloseTo(-num(0), 6);
    expect(num(7)).toBeCloseTo(3, 9);
    // the page gets the shown solution only
    expect(res.solution?.members[0].pieces.length).toBeGreaterThan(0);
  });

  it('self-weight is ρ g A along each member', () => {
    const { num } = run(cantilever([{ id: 'g', type: 'self' }]), ['f.N1.Rz = kN', 'f.N1.My = kN*m']);
    const w = 7850 * 9.80665 * ipe300.A * 1e-6;
    expect(num(0)).toBeCloseTo((w * 3) / 1000, 6);
    expect(num(1)).toBeCloseTo((-w * 9) / 2 / 1000, 6);
  });

  it('point and partial line loads at distances, in member axes, and β in degrees', () => {
    const d = cantilever([
      { id: 'p', type: 'point', member: 'm', at: '1 m', dir: 'y', value: 'P' },
      { id: 'l', type: 'line', member: 'm', dir: 'Z', q1: '-q', from: '1', to: '2.5' },
    ]);
    const { num } = run(d, ['f.N1.Ry = kN', 'f.N1.Rz = kN', 'f.N1.Mz = kN*m', 'f.N1.My = kN*m']);
    // P along local y, which is −Y for a beam along X: R_y = +P; the load's moment about the
    // clamp is (1 m, 0, 0) × (0, −P, 0) = (0, 0, −P · 1 m), the reaction's its opposite
    expect(num(0)).toBeCloseTo(10, 6);
    expect(num(2)).toBeCloseTo(10, 6);
    // q over 1 … 2.5 m: R_z = 1.5 q, the moment about Y −(1.5 q)(1.75 m)
    expect(num(1)).toBeCloseTo(6, 6);
    expect(num(3)).toBeCloseTo(-6 * 1.75, 6);
    // β = 90°: the vertical load goes to the weak axis
    const tip = (beta: string) => {
      const t = run(cantilever([{ id: 'P', type: 'node', node: 'b', Fz: '-P' }]), ['f.N2.uz = mm'], { members: [{ id: 'm', name: 'M1', a: 'a', b: 'b', section: 's', beta }] });
      expect(t.res.error, beta).toBeUndefined();
      return t.num(0);
    };
    expect(tip('90') / tip('0')).toBeCloseTo(ipe300.I_y / ipe300.I_z, 6);
    expect(tip('(pi/2) rad') / tip('0')).toBeCloseTo(ipe300.I_y / ipe300.I_z, 6);
    expect(tip('90 deg') / tip('0')).toBeCloseTo(ipe300.I_y / ipe300.I_z, 6);
  });

  it('a projected load on a slope is per plan length', () => {
    // a 30° rafter on two pins: snow s per plan metre over 4 m gives 4 s in all
    const d: Frame3DData = {
      nodes: [{ id: 'a', name: 'A', x: '0', y: '0', z: '0' }, { id: 'b', name: 'B', x: '4', y: '0', z: '4 * tan(30 deg)' }],
      members: [{ id: 'm', name: 'R', a: 'a', b: 'b', section: 's' }],
      sections: [{ id: 's', name: 'S', profile: 'IPE 200', material: 'S235' }],
      supports: [{ id: 'p', node: 'a', dofs: ['fixed', 'fixed', 'fixed', 'fixed', 'free', 'free'] }, { id: 'r', node: 'b', dofs: ['free', 'fixed', 'fixed', 'free', 'free', 'free'] }],
      loads: [{ id: 's', type: 'line', member: 'm', dir: 'Z', q1: '-2', projected: true }],
    };
    const { num } = run(d, ['f.A.Rz + f.B.Rz = kN']);
    expect(num(0)).toBeCloseTo(8, 6);
  });

  it('load cases and combinations: each on its own, governing values at the top', () => {
    const d = cantilever([
      { id: 'g', type: 'node', node: 'b', Fz: '-P', case: 'G' },
      { id: 'q', type: 'node', node: 'b', Fz: '-2*P', case: 'Q' },
    ]);
    const { num } = run(d, ['f.cases.G.N1.Rz = kN', 'f.combos.ULS.N1.Rz = kN', 'f.combos.SLS.N2.uz = mm', 'f.N1.Rz = kN', 'f.M1.My_min = kN*m', 'f.N2.uz = mm'], {
      loadCases: {
        cases: [{ id: 'G', name: 'G' }, { id: 'Q', name: 'Q' }],
        combos: [{ id: 'u', name: 'ULS', kind: 'ULS', factors: { G: '1.35', Q: '1.5' } }, { id: 's', name: 'SLS', kind: 'SLS', factors: { G: '1', Q: '1' } }],
      },
    });
    expect(num(0)).toBeCloseTo(10, 6);
    expect(num(1)).toBeCloseTo(43.5, 6);
    const d30 = (-30e3 * 27) / (3 * E * ipe300.I_y * 1e-12) * 1000;
    expect(num(2)).toBeCloseTo(d30, 4);
    expect(num(3)).toBeCloseTo(43.5, 6);
    expect(num(4)).toBeCloseTo(-43.5 * 3, 6);
    // displacements from the SLS combination
    expect(num(5)).toBeCloseTo(d30, 4);
  });

  it('α_cr of a column with second order: Euler about the weak axis', () => {
    const d: Frame3DData = {
      nodes: [{ id: 'a', name: 'B', x: '0', y: '0', z: '0' }, { id: 'b', name: 'T', x: '0', y: '0', z: '5' }],
      members: [{ id: 'm', name: 'C', a: 'a', b: 'b', section: 's' }],
      sections: [{ id: 's', name: 'S', profile: 'HEB 200', material: 'S355' }],
      supports: [{ id: 'p', node: 'a', dofs: ['fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed'] }],
      loads: [{ id: 'P', type: 'node', node: 'b', Fz: '-200 kN', Fy: '5 kN' }],
    };
    const { res, num } = run(d, ['f.α_cr =', 'f.C.L_cr_z = m', 'f.T.uy = mm'], { analysis: { secondOrder: true } });
    expect(res.error).toBeUndefined();
    const Pcr = (Math.PI ** 2 * E * heb200.I_z * 1e-12) / (2 * 5) ** 2;
    expect(num(0) / (Pcr / 200e3)).toBeCloseTo(1, 3);
    expect(num(1)).toBeCloseTo(10, 1);
    const k = Math.sqrt(200e3 / (E * heb200.I_z * 1e-12));
    expect(num(2) / (((5e3 * (Math.tan(5 * k) - 5 * k)) / (200e3 * k)) * 1000)).toBeCloseTo(1, 3);
  }, 20000);

  it('the presets solve, in equilibrium with their loads', () => {
    for (const kind of ['portal', 'truss', 'grillage'] as const) {
      const p = framePreset(kind, { length: 'm', force: 'kN' });
      const { res } = run(p, [], { loadCases: p.loadCases, analysis: { buckling: true } });
      expect(res.error, kind).toBeUndefined();
      expect(Object.keys(res.errors), kind).toEqual([]);
      const sol = res.solution!;
      // vertical: the reactions carry every load (the shown combination's factored loads)
      const Rz = sol.reactions.reduce((s, r) => s + r.F[2], 0);
      expect(Rz, kind).toBeGreaterThan(0);
      // (a grillage carries no axial force: nothing to buckle)
      if (kind === 'grillage') expect(res.buckling?.modes).toEqual([]);
      else expect(res.buckling?.modes.length, kind).toBeGreaterThan(0);
    }
    // the grillage: 10 kN/m on 24 girders of 4 m, plus their weight
    const g = framePreset('grillage', { length: 'm', force: 'kN' });
    const { res } = run(g, []);
    const w = 7850 * 9.80665 * sectionProps('IPE 360').A * 1e-6;
    expect(res.solution!.reactions.reduce((s, r) => s + r.F[2], 0)).toBeCloseTo(24 * 4 * (10e3 + w), 3);
    // in other units the same structure
    const mm = framePreset('grillage', { length: 'mm', force: 'N' });
    const r2 = run(mm, [], { lengthUnit: 'mm', forceUnit: 'N' }).res;
    expect(r2.solution!.reactions.reduce((s, r) => s + r.F[2], 0)).toBeCloseTo(24 * 4 * (10e3 + w), 3);
  }, 30000);

  it('reports problems with the item they belong to', () => {
    const bad = run(cantilever([{ id: 'P', type: 'node', node: 'b', Fz: '5 m' }]), []).res;
    expect(bad.errors.P).toMatch(/units like kN/);
    const coord = run(cantilever([]), [], { nodes: [{ id: 'a', name: 'N1', x: '0', y: '0', z: '0' }, { id: 'b', name: 'N2', x: '3 kg', y: '0', z: '0' }] }).res;
    expect(coord.errors.b).toMatch(/units like m/);
    expect(coord.error).toBeTruthy();
    const mech = run(cantilever([{ id: 'P', type: 'node', node: 'b', Fz: '-P' }], { supports: [{ id: 'p', node: 'a', dofs: ['fixed', 'fixed', 'fixed', 'free', 'free', 'free'] }] }), []).res;
    expect(mech.error).toMatch(/mechanism\) at node N\d, (along|about) [XYZ]/);
    const names = run(cantilever([]), [], { nodes: [{ id: 'a', name: 'N1', x: '0', y: '0', z: '0' }, { id: 'b', name: 'N1', x: '3', y: '0', z: '0' }] }).res;
    expect(names.errors.names).toMatch(/named N1/);
  });
});
