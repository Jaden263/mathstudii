import { describe, it, expect } from 'vitest';
import { solveStructure, type NumLoad, type NumMember, type NumStructure, type NumSupport } from './solve';

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

  it('a point load right next to a support acts there', () => {
    // two spans of 25 m, a stiff girder, 300 kN at d from the middle support
    const P = 300e3, L = 25;
    for (const d of [1e-3, 1e-9]) {
      const st = beam([0, L, 2 * L], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller'), sup('C', 'n2', 'roller')],
        [{ id: 'P', type: 'force', at: { member: 'm0', t: 1 - d / L }, Fx: 0, Fy: -P }], () => ({ E: 210e9, A: 0.06, I: 0.08 }));
      const [RA, RB, RC] = solveStructure(st).reactions.map((q) => q.Ry);
      // as if it stood on B, to within P·d/L
      expect(Math.abs(RA)).toBeLessThan((P * d) / L);
      expect(Math.abs(RB - P)).toBeLessThan((P * d) / L);
      expect(Math.abs(RC)).toBeLessThan((P * d) / L);
      // and exactly: three-moment equation with the load at a = L − d
      const a = L - d, MB = (-P * a * d * (2 * L - d)) / (4 * L * L);
      expect(RC).toBeCloseTo(MB / L, 6);
      expect(RA).toBeCloseTo((MB + P * d) / L, 6);
    }
  });

  it('loads close to each other or to a node need no sliver piece', () => {
    const P = 10e3, L = 10, q = 5e3;
    // two forces 1 µm apart at midspan
    const r = solveStructure(beam([0, L], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller')], [
      { id: 'P1', type: 'force', at: { member: 'm0', t: 0.5 }, Fx: 0, Fy: -P },
      { id: 'P2', type: 'force', at: { member: 'm0', t: 0.5 + 1e-7 }, Fx: 0, Fy: -P },
    ]));
    expect(r.reactions[0].Ry).toBeCloseTo(P * (1 - 1e-7), 6);
    expect(r.max.M!.value).toBeCloseTo(P * (1 - 1e-7) * L / 2, 6);
    const rotA = (b: number) => (-P * b * (L * L - b * b)) / (6 * E * I * L); // end rotation for P at b from B
    expect(r.nodes.n0.rz).toBeCloseTo(rotA(L / 2) + rotA(L / 2 - 1e-6), 12);
    // a uniform load stopping 1 µm short of the support
    const u = solveStructure(beam([0, L], [sup('A', 'n0', 'pin'), sup('B', 'n1', 'roller')], [{ id: 'q', type: 'line', member: 'm0', t1: 0, t2: 1 - 1e-7, q1: q, q2: q, dir: 'global' }]));
    expect(u.reactions[0].Ry + u.reactions[1].Ry).toBeCloseTo(q * L * (1 - 1e-7), 6);
    expect(u.max.M!.value).toBeCloseTo((q * L * L) / 8, 6);
  });

  it('a moment next to a hinge stays on its member', () => {
    // Gerber beam: A fixed, hinge at 3 m, roller at 6 m; the moment sits on the cantilever side
    const M0 = 20e3;
    const r = solveStructure(beam([0, 3, 6], [sup('A', 'n0', 'fixed'), sup('C', 'n2', 'roller')],
      [{ id: 'M', type: 'moment', at: { member: 'm0', t: 1 - 1e-9 }, M: M0 }], (_, i) => (i === 0 ? { hingeB: true } : {})));
    expect(r.reactions[0].M).toBeCloseTo(-M0, 6);
    expect(r.reactions[1].Ry).toBeCloseTo(0, 6);
  });

  it('reports mechanisms and missing supports', () => {
    expect(() => solveStructure(beam([0, 4], [sup('A', 'n0', 'roller'), sup('B', 'n1', 'roller')], []))).toThrow(/mechanism/);
    expect(() => solveStructure(beam([0, 4], [], []))).toThrow(/supports/);
    // a hinge with a simple support on each side: the beam folds
    const fold = (loads: NumLoad[]) => beam([0, 2, 4], [sup('A', 'n0', 'pin'), sup('B', 'n2', 'roller')], loads, (_, i) => (i === 0 ? { hingeB: true } : {}));
    expect(() => solveStructure(fold([]))).toThrow(/mechanism/);
    // still so with loads right next to the nodes
    expect(() => solveStructure(fold([{ id: 'P', type: 'force', at: { member: 'm0', t: 1 - 1e-9 }, Fx: 0, Fy: -1e3 }]))).toThrow(/mechanism/);
    expect(() => solveStructure(beam([0, 4], [sup('A', 'n0', 'roller'), sup('B', 'n1', 'roller')], [{ id: 'P', type: 'force', at: { member: 'm0', t: 1e-9 }, Fx: 0, Fy: -1e3 }]))).toThrow(/mechanism/);
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
