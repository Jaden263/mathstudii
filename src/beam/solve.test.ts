import { describe, it, expect } from 'vitest';
import { memberAt, solveStructure, type NumLoad, type NumMember, type NumStructure, type NumSupport } from './solve';

const E = 210e9, I = 8356e-8, A = 53.8e-4;
const mem = (id: string, a: string, b: string, extra: Partial<NumMember> = {}): NumMember => ({ id, a, b, E, A, I, ...extra });
const sup = (id: string, node: string, type: NumSupport['type'], angle = 0): NumSupport => ({ id, node, type, angle, label: id });

/** Horizontal beam with nodes at the given x positions. */
function beam(xs: number[], supports: NumSupport[], loads: NumLoad[], extra: (m: NumMember, i: number) => Partial<NumMember> = () => ({})): NumStructure {
  return {
    nodes: xs.map((x, i) => ({ id: `n${i}`, x, y: 0 })),
    members: xs.slice(1).map((_, i) => mem(`m${i}`, `n${i}`, `n${i + 1}`, extra(mem('', '', ''), i))),
    supports,
    loads,
  };
}

const sumReactions = (r: ReturnType<typeof solveStructure>) => r.reactions.reduce((s, q) => ({ x: s.x + q.Rx, y: s.y + q.Ry }), { x: 0, y: 0 });

describe('beam and frame solver', () => {
  it('simply supported beam under a uniform load', () => {
    const q = 10e3, L = 6;
    const r = solveStructure(beam([0, L], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller')], [{ id: 'q', type: 'line', member: 'm0', t1: 0, t2: 1, q1: q, q2: q, dir: 'global' }]));
    expect(r.reactions[0].Ry).toBeCloseTo(q * L / 2, 6);
    expect(r.reactions[1].Ry).toBeCloseTo(q * L / 2, 6);
    expect(r.max.M!.value).toBeCloseTo(q * L * L / 8, 6);
    expect(r.max.M!.s).toBeCloseTo(L / 2, 9);
    expect(r.max.V!.value).toBeCloseTo(q * L / 2, 6);
    expect(r.max.w!.value).toBeCloseTo((5 * q * L ** 4) / (384 * E * I), 12);
    expect(r.indeterminacy).toBe(0);
  });

  it('cantilever with a point load at the tip', () => {
    const P = 10e3, L = 3;
    const r = solveStructure(beam([0, L], [sup('A', 'n0', 'fixed')], [{ id: 'P', type: 'force', at: { node: 'n1' }, Fx: 0, Fy: -P }]));
    expect(r.reactions[0].Ry).toBeCloseTo(P, 6);
    expect(r.reactions[0].M).toBeCloseTo(P * L, 6);
    expect(r.max.M!.value).toBeCloseTo(-P * L, 6); // hogging
    expect(r.nodes.n1.dy).toBeCloseTo((-P * L ** 3) / (3 * E * I), 12);
    expect(r.nodes.n1.rz).toBeCloseTo((-P * L * L) / (2 * E * I), 12);
  });

  it('propped cantilever (indeterminate) and a point load mid-member', () => {
    const q = 8e3, L = 5;
    const r = solveStructure(beam([0, L], [sup('A', 'n0', 'fixed'), sup('B', 'n1', 'roller')], [{ id: 'q', type: 'line', member: 'm0', t1: 0, t2: 1, q1: q, q2: q, dir: 'global' }]));
    expect(r.reactions[1].Ry).toBeCloseTo((3 * q * L) / 8, 6);
    expect(r.reactions[0].M).toBeCloseTo((q * L * L) / 8, 6);
    expect(r.indeterminacy).toBe(1);
    const P = 20e3;
    const s = solveStructure(beam([0, 4], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller')], [{ id: 'P', type: 'force', at: { member: 'm0', t: 0.25 }, Fx: 0, Fy: -P }]));
    expect(s.reactions[0].Ry).toBeCloseTo(0.75 * P, 6);
    expect(s.max.M!.value).toBeCloseTo(0.75 * P * 1, 6);
    // shear jumps by P at the load
    const m = s.members[0];
    const at = m.s.map((x, i) => [x, m.V[i]]).filter(([x]) => Math.abs(x - 1) < 1e-12).map(([, v]) => v);
    expect(at).toEqual([expect.closeTo(0.75 * P, 6), expect.closeTo(-0.25 * P, 6)]);
  });

  it('two equal spans: the middle support takes 5/4 qL', () => {
    const q = 10e3, L = 4;
    const ld = (m: string): NumLoad => ({ id: m, type: 'line', member: m, t1: 0, t2: 1, q1: q, q2: q, dir: 'global' });
    const r = solveStructure(beam([0, L, 2 * L], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller'), sup('C', 'n2', 'roller')], [ld('m0'), ld('m1')]));
    expect(r.reactions[1].Ry).toBeCloseTo(1.25 * q * L, 5);
    expect(r.reactions[0].Ry).toBeCloseTo(0.375 * q * L, 5);
    expect(r.max.M!.value).toBeCloseTo((-q * L * L) / 8, 5);
  });

  it('triangular load on a simple beam', () => {
    const q = 12e3, L = 6;
    const r = solveStructure(beam([0, L], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller')], [{ id: 'q', type: 'line', member: 'm0', t1: 0, t2: 1, q1: 0, q2: q, dir: 'global' }]));
    expect(r.reactions[0].Ry).toBeCloseTo((q * L) / 6, 6);
    expect(r.reactions[1].Ry).toBeCloseTo((q * L) / 3, 6);
    expect(r.max.M!.value).toBeCloseTo((q * L * L) / (9 * Math.sqrt(3)), 6);
    expect(r.max.M!.s).toBeCloseTo(L / Math.sqrt(3), 9);
  });

  it('Gerber beam: a hinge makes a determinate two-span beam', () => {
    // A fixed, hinge at 3 m, roller at 6 m; UDL on the right span only
    const q = 10e3;
    const r = solveStructure(beam([0, 3, 6], [sup('A', 'n0', 'fixed'), sup('C', 'n2', 'roller')],
      [{ id: 'q', type: 'line', member: 'm1', t1: 0, t2: 1, q1: q, q2: q, dir: 'global' }], (_, i) => (i === 0 ? { hingeB: true } : {})));
    expect(r.reactions[1].Ry).toBeCloseTo(15e3, 6);
    expect(r.reactions[0].Ry).toBeCloseTo(15e3, 6);
    expect(r.reactions[0].M).toBeCloseTo(45e3, 6);
    expect(r.indeterminacy).toBe(0);
  });

  it('truss: pin-ended members carry axial force only', () => {
    // triangle 4 m wide, 3 m high, 10 kN down at the apex
    const st: NumStructure = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 4, y: 0 }, { id: 'c', x: 2, y: 3 }],
      members: [mem('ab', 'a', 'b', { hingeA: true, hingeB: true }), mem('ac', 'a', 'c', { hingeA: true, hingeB: true }), mem('bc', 'b', 'c', { hingeA: true, hingeB: true })],
      supports: [sup('A', 'a', 'pin'), sup('B', 'b', 'roller')],
      loads: [{ id: 'P', type: 'force', at: { node: 'c' }, Fx: 0, Fy: -10e3 }],
    };
    const r = solveStructure(st);
    const Lac = Math.hypot(2, 3);
    const Nac = -5e3 * Lac / 3; // compression
    const ac = r.members[1];
    expect(ac.N[0]).toBeCloseTo(Nac, 5);
    expect(Math.max(...ac.M.map(Math.abs))).toBeLessThan(1e-6);
    expect(r.members[0].N[0]).toBeCloseTo(5e3 * 2 / 3, 5); // tie in tension
    expect(r.indeterminacy).toBe(0);
  });

  it('portal frame: equilibrium under a horizontal load, inclined roller', () => {
    const st: NumStructure = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 4 }, { id: 'c', x: 6, y: 4 }, { id: 'd', x: 6, y: 0 }],
      members: [mem('ab', 'a', 'b'), mem('bc', 'b', 'c'), mem('cd', 'c', 'd')],
      supports: [sup('A', 'a', 'fixed'), sup('D', 'd', 'pin')],
      loads: [{ id: 'H', type: 'force', at: { node: 'b' }, Fx: 20e3, Fy: 0 }, { id: 'q', type: 'line', member: 'bc', t1: 0, t2: 1, q1: 5e3, q2: 5e3, dir: 'global' }],
    };
    const r = solveStructure(st);
    const s = sumReactions(r);
    expect(s.x).toBeCloseTo(-20e3, 5);
    expect(s.y).toBeCloseTo(30e3, 5);
    expect(r.indeterminacy).toBe(2);
    // a roller on a 30° slope pushes along its normal
    const inc = solveStructure(beam([0, 5], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller', Math.PI / 6)], [{ id: 'P', type: 'force', at: { member: 'm0', t: 0.5 }, Fx: 0, Fy: -10e3 }]));
    const B = inc.reactions[1];
    expect(B.Rx / B.Ry).toBeCloseTo(-Math.tan(Math.PI / 6), 9);
    expect(inc.reactions[0].Ry + B.Ry).toBeCloseTo(10e3, 6);
  });

  it('reports mechanisms and missing supports', () => {
    expect(() => solveStructure(beam([0, 4], [sup('A', 'n0', 'roller'), sup('B', 'n1', 'roller')], []))).toThrow(/mechanism/);
    expect(() => solveStructure(beam([0, 4], [], []))).toThrow(/supports/);
    // a hinge with a simple support on each side: the beam folds
    expect(() => solveStructure(beam([0, 2, 4], [sup('A', 'n0', 'pin'), sup('B', 'n2', 'roller')], [], (_, i) => (i === 0 ? { hingeB: true } : {})))).toThrow(/mechanism/);
  });
});

describe('springs and settlements', () => {
  const EI = 210e9 * 8356e-8;
  const base = (supports: NumStructure['supports'], loads: NumStructure['loads'], L = 6): NumStructure => ({
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: L, y: 0 }, { id: 'c', x: 2 * L, y: 0 }],
    members: [{ id: 'm1', a: 'a', b: 'b', E: 210e9, A: 53.8e-4, I: 8356e-8 }, { id: 'm2', a: 'b', b: 'c', E: 210e9, A: 53.8e-4, I: 8356e-8 }],
    supports, loads,
  });

  it('adds the spring compression to the deflection', () => {
    const P = 20e3, k = 5e6, L = 12;
    const sol = solveStructure(base(
      [{ id: 'A', node: 'a', type: 'pin', angle: 0, label: 'A', k }, { id: 'C', node: 'c', type: 'roller', angle: 0, label: 'C', k }],
      [{ id: 'P', type: 'force', at: { node: 'b' }, Fx: 0, Fy: -P }],
    ));
    expect(-sol.nodes.b.dy).toBeCloseTo((P * L ** 3) / (48 * EI) + P / (2 * k), 8);
    expect(sol.reactions[0].Ry).toBeCloseTo(P / 2, 6);
    expect(sol.nodes.a.dy).toBeCloseTo(-P / 2 / k, 10);
  });

  it('settlement of the middle support of two spans', () => {
    const d = 0.01, L = 6;
    const sol = solveStructure(base(
      [
        { id: 'A', node: 'a', type: 'pin', angle: 0, label: 'A' },
        { id: 'B', node: 'b', type: 'roller', angle: 0, label: 'B', settle: d },
        { id: 'C', node: 'c', type: 'roller', angle: 0, label: 'C' },
      ],
      [],
    ));
    expect(sol.nodes.b.dy).toBeCloseTo(-d, 12);
    expect(sol.reactions[1].Ry).toBeCloseTo((-6 * EI * d) / L ** 3, 3);
    expect(sol.reactions[0].Ry).toBeCloseTo((3 * EI * d) / L ** 3, 3);
  });

  it('a rotational spring makes a semi-rigid foot', () => {
    // cantilever with a rotational spring at the root: tip deflection P L³/3EI + P L² / kr
    const P = 1e3, L = 3, kr = 1e7;
    const sol = solveStructure({
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: L, y: 0 }],
      members: [{ id: 'm', a: 'a', b: 'b', E: 210e9, A: 53.8e-4, I: 8356e-8 }],
      supports: [{ id: 'A', node: 'a', type: 'fixed', angle: 0, label: 'A', kr }],
      loads: [{ id: 'P', type: 'force', at: { node: 'b' }, Fx: 0, Fy: -P }],
    });
    expect(-sol.nodes.b.dy).toBeCloseTo((P * L ** 3) / (3 * EI) + (P * L * L) / kr, 9);
    expect(sol.reactions[0].M).toBeCloseTo(P * L, 6);
  });
});

describe('loads anywhere along a member', () => {
  const EI = E * I;

  it('a point load 1 mm from a node on a long member is no mechanism', () => {
    // it used to split the member there: a 1 mm piece (L/h)³ = 1e12 times stiffer in
    // bending than the 10 m one, which the solver took for a mechanism (and lost 12 digits)
    const P = 10e3, L = 10, a = 0.001;
    const ss = solveStructure(beam([0, L], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller')], [{ id: 'P', type: 'force', at: { member: 'm0', t: a / L }, Fx: 0, Fy: -P }]));
    // R_A = P (L − a)/L, R_B = P a/L, M under the load P a (L − a)/L
    expect(ss.reactions[0].Ry).toBeCloseTo((P * (L - a)) / L, 9);
    expect(ss.reactions[1].Ry).toBeCloseTo((P * a) / L, 9);
    expect(memberAt(ss.members[0], a).M).toBeCloseTo((P * a * (L - a)) / L, 9);
    // cantilever, the load a from the clamp: δ_tip = P a² (3L − a)/6EI, M_A = P a
    const c = solveStructure(beam([0, L], [sup('A', 'n0', 'fixed')], [{ id: 'P', type: 'force', at: { member: 'm0', t: a / L }, Fx: 0, Fy: -P }]));
    // (the tip moves 3e-9 m, 1e-7 of what a load at the tip would do: round-off sits at 1e-8 of it)
    expect(c.nodes.n1.dy / ((-P * a * a * (3 * L - a)) / (6 * EI))).toBeCloseTo(1, 6);
    expect(c.reactions[0].M).toBeCloseTo(P * a, 9);
    // a portal with the load next to a corner, in first and second order
    const portal: NumStructure = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 4 }, { id: 'c', x: L, y: 4 }, { id: 'd', x: L, y: 0 }],
      members: [mem('m1', 'a', 'b'), mem('m2', 'b', 'c'), mem('m3', 'd', 'c')],
      supports: [sup('A', 'a', 'pin'), sup('D', 'd', 'pin')],
      loads: [{ id: 'P', type: 'force', at: { member: 'm2', t: 1 - 1e-5 }, Fx: 0, Fy: -P }],
    };
    const r = solveStructure(portal);
    expect(r.reactions[0].Ry).toBeCloseTo(P * 1e-5, 9);
    expect(r.reactions[1].Ry).toBeCloseTo(P * (1 - 1e-5), 9);
    // second order: the lever arms grow by the sway (a few hundredths of a newton here)
    const r2 = solveStructure(portal, { secondOrder: true });
    expect(r2.reactions[0].Ry + r2.reactions[1].Ry).toBeCloseTo(P, 6);
    expect(Math.abs(r2.reactions[0].Ry - P * 1e-5)).toBeLessThan(0.05);
  });

  // the same load on a member, and on a node put where it sits: fixed-end forces against
  // the stiffness method itself, with and without shear deformation
  const pair = (loadOn: (m: string, t: number) => NumLoad[], loadAt: (n: string) => NumLoad[], shear: boolean) => {
    const extra = shear ? { G: 81e9, Av: 25.7e-4 } : {};
    const whole: NumStructure = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 3, y: 4 }],
      members: [mem('m', 'a', 'b', extra)],
      supports: [sup('A', 'a', 'fixed'), sup('B', 'b', 'pin')],
      loads: loadOn('m', 0.3),
    };
    const split: NumStructure = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'k', x: 0.9, y: 1.2 }, { id: 'b', x: 3, y: 4 }],
      members: [mem('m1', 'a', 'k', extra), mem('m2', 'k', 'b', extra)],
      supports: whole.supports,
      loads: loadAt('k'),
    };
    return [solveStructure(whole), solveStructure(split)];
  };

  for (const shear of [false, true]) {
    it(`point force and concentrated moment along a member${shear ? ' (Timoshenko)' : ''}`, () => {
      for (const [on, at] of [
        [(m: string, t: number): NumLoad[] => [{ id: 'P', type: 'force', at: { member: m, t }, Fx: 3e3, Fy: -8e3 }], (n: string): NumLoad[] => [{ id: 'P', type: 'force', at: { node: n }, Fx: 3e3, Fy: -8e3 }]],
        [(m: string, t: number): NumLoad[] => [{ id: 'C', type: 'moment', at: { member: m, t }, M: 12e3 }], (n: string): NumLoad[] => [{ id: 'C', type: 'moment', at: { node: n }, M: 12e3 }]],
      ] as const) {
        const [w, s] = pair(on, at, shear);
        for (const k of [0, 1]) {
          expect(w.reactions[k].Rx).toBeCloseTo(s.reactions[k].Rx, 6);
          expect(w.reactions[k].Ry).toBeCloseTo(s.reactions[k].Ry, 6);
          expect(w.reactions[k].M).toBeCloseTo(s.reactions[k].M, 6);
        }
        // along the member: just before and after the load, and the deflection
        for (const x of [0.4, 1.5 - 1e-9, 1.5 + 1e-9, 3.7]) {
          const p = memberAt(w.members[0], x), q = x < 1.5 ? memberAt(s.members[0], x) : memberAt(s.members[1], x - 1.5);
          expect(p.M).toBeCloseTo(q.M, 4);
          expect(p.V).toBeCloseTo(q.V, 4);
          expect(p.N).toBeCloseTo(q.N, 4);
          expect(p.dy).toBeCloseTo(q.dy, 12);
        }
      }
    });
  }

  it('a moment on a simple beam: R = C/L, and M jumps by C (−C (L − a)/L after it)', () => {
    const C = 10e3, L = 5, a = 2;
    const r = solveStructure(beam([0, L], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller')], [{ id: 'C', type: 'moment', at: { member: 'm0', t: a / L }, M: C }]));
    expect(r.reactions[0].Ry).toBeCloseTo(C / L, 8);
    expect(r.reactions[1].Ry).toBeCloseTo(-C / L, 8);
    expect(memberAt(r.members[0], a - 1e-9).M).toBeCloseTo((C * a) / L, 4);
    expect(memberAt(r.members[0], a).M).toBeCloseTo((-C * (L - a)) / L, 4);
    // fixed at both ends with C at midspan: C/4 at each end, 3C/2L across
    const f = solveStructure(beam([0, L], [sup('A', 'n0', 'fixed'), sup('B', 'n1', 'fixed')], [{ id: 'C', type: 'moment', at: { member: 'm0', t: 0.5 }, M: C }]));
    expect(Math.abs(f.reactions[0].M)).toBeCloseTo(C / 4, 6);
    expect(Math.abs(f.reactions[0].Ry)).toBeCloseTo((3 * C) / (2 * L), 6);
  });

  it('a partial trapezoidal line load against nodes at its ends', () => {
    // q from 2 kN/m at 1.2 m to 6 kN/m at 4.2 m on a 6 m simple beam: R_B = Σ q·x / L
    const L = 6, t1 = 0.2, t2 = 0.7, q1 = 2e3, q2 = 6e3;
    const r = solveStructure(beam([0, L], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller')], [{ id: 'q', type: 'line', member: 'm0', t1, t2, q1, q2, dir: 'global' }]));
    const a = t1 * L, len = (t2 - t1) * L, Q = (len * (q1 + q2)) / 2, xc = a + (len * (q1 + 2 * q2)) / (3 * (q1 + q2));
    expect(r.reactions[1].Ry).toBeCloseTo((Q * xc) / L, 6);
    expect(r.reactions[0].Ry).toBeCloseTo(Q - (Q * xc) / L, 6);
    // the same with nodes at 1.2 and 4.2 m: equal deflection everywhere
    const s = solveStructure({
      nodes: [0, a, a + len, L].map((x, i) => ({ id: `k${i}`, x, y: 0 })),
      members: [mem('p0', 'k0', 'k1'), mem('p1', 'k1', 'k2'), mem('p2', 'k2', 'k3')],
      supports: [sup('A', 'k0', 'pin'), sup('B', 'k3', 'roller')],
      loads: [{ id: 'q', type: 'line', member: 'p1', t1: 0, t2: 1, q1, q2, dir: 'global' }],
    });
    for (const x of [0.7, 2, 3.3, 5]) {
      const seg = x < a ? 0 : x < a + len ? 1 : 2, x0 = [0, a, a + len][seg];
      expect(memberAt(r.members[0], x).dy).toBeCloseTo(memberAt(s.members[seg], x - x0).dy, 12);
      expect(memberAt(r.members[0], x).M).toBeCloseTo(memberAt(s.members[seg], x - x0).M, 5);
    }
  });
});
