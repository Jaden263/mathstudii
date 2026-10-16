import { describe, it, expect } from 'vitest';
import { memberAt3, memberAxes, solveFrame3, type NumFrame, type NumLoad3, type NumMember3, type NumSupport3, type Vec3 } from './solve';
import { solveStructure, memberAt } from '../beam/solve';

// IPE 300, S235: E = 210 GPa, G = 81 GPa
const E = 210e9, G = 81e9, A = 53.8e-4, Iy = 8356e-8, Iz = 603.8e-8, It = 20.12e-8;
const mem = (id: string, a: string, b: string, extra: Partial<NumMember3> = {}): NumMember3 => ({ id, a, b, E, G, A, Iy, Iz, It, ...extra });
const node = (id: string, x: number, y: number, z: number) => ({ id, x, y, z });
const FIXED = [true, true, true, true, true, true];
const PINNED = [true, true, true, false, false, false];
const sup = (node: string, dofs: (boolean | number)[] = FIXED): NumSupport3 => ({ id: `s${node}`, node, dofs });
const atNode = (id: string, n: string, F: Vec3, M: Vec3 = [0, 0, 0]): NumLoad3 => ({ id, type: 'node', node: n, F, M });
/** A pin-jointed bar: no bending moments at either end, torsion released at one (else it could spin). */
const PIN_A = [false, false, false, true, true, true], PIN_B = [false, false, false, false, true, true];

/** Σ reactions + Σ loads = 0, forces and moments about the origin (point and line loads on members included). */
function equilibrium(st: NumFrame, sol: ReturnType<typeof solveFrame3>) {
  const pos = new Map(st.nodes.map((q) => [q.id, [q.x, q.y, q.z] as Vec3]));
  const F: Vec3 = [0, 0, 0], M: Vec3 = [0, 0, 0];
  const add = (p: Vec3, f: Vec3, m: Vec3 = [0, 0, 0]) => {
    for (let c = 0; c < 3; c++) F[c] += f[c];
    const r = [p[1] * f[2] - p[2] * f[1], p[2] * f[0] - p[0] * f[2], p[0] * f[1] - p[1] * f[0]];
    for (let c = 0; c < 3; c++) M[c] += r[c] + m[c];
  };
  for (const r of sol.reactions) add(pos.get(r.node)!, r.F, r.M);
  for (const l of st.loads) {
    if (l.type === 'node') add(pos.get(l.node)!, l.F, l.M);
    else {
      const m = st.members.find((q) => q.id === l.member)!;
      const a = pos.get(m.a)!, b = pos.get(m.b)!;
      const { L, R } = memberAxes(a, b, m.beta, m.ref);
      const g = (v: Vec3, local: boolean): Vec3 => (local ? [0, 1, 2].map((c) => R[0][c] * v[0] + R[1][c] * v[1] + R[2][c] * v[2]) as Vec3 : v);
      const at = (t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (l.type === 'point') add(at(l.t), g(l.F, l.local), g(l.M, l.local));
      else {
        // Simpson on each linear component is exact for the force and its moment
        for (const [t, w] of [[l.t1, 1 / 6], [(l.t1 + l.t2) / 2, 4 / 6], [l.t2, 1 / 6]] as const) {
          const f = (l.t2 - l.t1) * L * w, s = (t - l.t1) / (l.t2 - l.t1);
          const q = g([0, 1, 2].map((c) => (l.q1[c] + (l.q2[c] - l.q1[c]) * s) * f) as Vec3, l.local);
          add(at(t), q);
        }
      }
    }
  }
  return { F, M };
}

describe('space frame: closed forms', () => {
  it('cantilever along x with tip loads F_y and F_z', () => {
    const L = 3, Fy = 2e3, Fz = -5e3;
    const st: NumFrame = { nodes: [node('a', 0, 0, 0), node('b', L, 0, 0)], members: [mem('m', 'a', 'b')], supports: [sup('a')], loads: [atNode('P', 'b', [0, Fy, Fz])] };
    const sol = solveFrame3(st);
    // δ_y = F_y L³ / 3EI_z (the weak axis), δ_z = F_z L³ / 3EI_y
    expect(sol.nodes.b[1]).toBeCloseTo((Fy * L ** 3) / (3 * E * Iz), 12);
    expect(sol.nodes.b[2]).toBeCloseTo((Fz * L ** 3) / (3 * E * Iy), 12);
    // tip rotations F L² / 2EI: about Z (from F_y) and about Y (−, from F_z)
    expect(sol.nodes.b[5]).toBeCloseTo((Fy * L * L) / (2 * E * Iz), 12);
    expect(sol.nodes.b[4]).toBeCloseTo((-Fz * L * L) / (2 * E * Iy), 12);
    // the clamp: R = −F, M = −(r × F) with r = (L, 0, 0): (0, L F_z, −L F_y)
    const R = sol.reactions[0];
    expect(R.F[1]).toBeCloseTo(-Fy, 6);
    expect(R.F[2]).toBeCloseTo(-Fz, 6);
    expect(R.M[1]).toBeCloseTo(L * Fz, 6);
    expect(R.M[2]).toBeCloseTo(-L * Fy, 6);
    // member axes of a beam along X: y = −Y, z = −Z (down), so the load is (0, −F_y, −F_z)
    // there; the moment at the clamp is L e_x × F = L (0, −F_z,loc, F_y,loc) = (0, L F_z, −L F_y)
    // (M_y < 0: hogging under a downward load)
    const r = sol.members[0], root = memberAt3(r, 0);
    expect(r.axes[2]).toEqual([0, 0, -1].map((v) => expect.closeTo(v, 12)));
    expect(root.My).toBeCloseTo(L * Fz, 6);
    expect(root.Mz).toBeCloseTo(-L * Fy, 6);
    expect(root.Vz).toBeCloseTo(-Fz, 6);
    expect(root.Vy).toBeCloseTo(-Fy, 6);
    expect(memberAt3(r, L / 2).My).toBeCloseTo((L / 2) * Fz, 6);
    // deflection along the member: F x² (3L − x) / 6EI
    expect(memberAt3(r, 1).uz).toBeCloseTo((Fz * (3 * L - 1)) / (6 * E * Iy), 12);
  });

  it('torsion: θ = T L / G I_t', () => {
    const L = 4, T = 1.5e3;
    const sol = solveFrame3({ nodes: [node('a', 0, 0, 0), node('b', L, 0, 0)], members: [mem('m', 'a', 'b')], supports: [sup('a')], loads: [atNode('T', 'b', [0, 0, 0], [T, 0, 0])] });
    expect(sol.nodes.b[3]).toBeCloseTo((T * L) / (G * It), 12);
    expect(sol.reactions[0].M[0]).toBeCloseTo(-T, 6);
    expect(memberAt3(sol.members[0], 2).T).toBeCloseTo(T, 6);
    expect(memberAt3(sol.members[0], 2).phi).toBeCloseTo((T * 2) / (G * It), 12);
  });

  it('L-shaped grillage: δ = P a³/3EI + P b³/3EI + P a² b/G I_t', () => {
    // leg b runs from the clamp along Y to the corner, leg a from there along X to the tip;
    // P at the tip bends both legs, and the leg at the clamp (b) twists under P·a, which
    // turns leg a about Y: θ = P a b / G I_t, so the tip drops a further θ a
    const a = 2, b = 3, P = 4e3;
    const st: NumFrame = {
      nodes: [node('o', 0, 0, 0), node('c', 0, b, 0), node('e', a, b, 0)],
      members: [mem('b', 'o', 'c'), mem('a', 'c', 'e')],
      supports: [sup('o')],
      loads: [atNode('P', 'e', [0, 0, -P])],
    };
    const sol = solveFrame3(st);
    const delta = (P * a ** 3) / (3 * E * Iy) + (P * b ** 3) / (3 * E * Iy) + (P * a * a * b) / (G * It);
    expect(-sol.nodes.e[2] / delta).toBeCloseTo(1, 10);
    // the twist of leg b: T = P a along it
    expect(Math.abs(memberAt3(sol.members[0], 1).T)).toBeCloseTo(P * a, 6);
    expect(sol.reactions[0].M[1]).toBeCloseTo(-P * a, 6);
    expect(sol.reactions[0].M[0]).toBeCloseTo(P * b, 6);
  });

  it('β = 90° swaps the strong and the weak axis', () => {
    const L = 3, P = 1e3;
    const tip = (beta: number) => solveFrame3({
      nodes: [node('a', 0, 0, 0), node('b', L, 0, 0)], members: [mem('m', 'a', 'b', { beta })], supports: [sup('a')], loads: [atNode('P', 'b', [0, 0, -P])],
    }).nodes.b;
    expect(tip(0)[2]).toBeCloseTo((-P * L ** 3) / (3 * E * Iy), 12);
    expect(tip(Math.PI / 2)[2]).toBeCloseTo((-P * L ** 3) / (3 * E * Iz), 12);
    expect(tip(Math.PI / 2)[1]).toBeCloseTo(0, 12);
    // a reference direction along global Y turns local z the same way as β = 90°: y′ = −Z
    const ref = solveFrame3({
      nodes: [node('a', 0, 0, 0), node('b', L, 0, 0)], members: [mem('m', 'a', 'b', { ref: [0, 1, 0] })], supports: [sup('a')], loads: [atNode('P', 'b', [0, 0, -P])],
    });
    expect(ref.nodes.b[2]).toBeCloseTo((-P * L ** 3) / (3 * E * Iz), 12);
  });

  it('a vertical member has y along global Y, z = x × y', () => {
    const { R } = memberAxes([0, 0, 0], [0, 0, 4]);
    expect(R[1]).toEqual([0, 1, 0].map((v) => expect.closeTo(v, 12)));
    expect(R[2]).toEqual([-1, 0, 0].map((v) => expect.closeTo(v, 12)));
    // an inclined rafter: z in its vertical plane, pointing down; y horizontal
    const r = memberAxes([0, 0, 0], [4, 0, 3]).R;
    expect(r[2][2]).toBeLessThan(0);
    expect(r[1][2]).toBeCloseTo(0, 12);
    expect(r[2][0] * 4 + r[2][2] * 3).toBeCloseTo(0, 12);
  });

  it('Timoshenko cantilever: δ = P L³/3EI + P L / G A_v in both planes', () => {
    const L = 2, P = 10e3, Avy = 36e-4, Avz = 25.7e-4;
    const sol = solveFrame3({
      nodes: [node('a', 0, 0, 0), node('b', L, 0, 0)], members: [mem('m', 'a', 'b', { Avy, Avz })], supports: [sup('a')], loads: [atNode('P', 'b', [0, P, -P])],
    });
    expect(sol.nodes.b[1]).toBeCloseTo((P * L ** 3) / (3 * E * Iz) + (P * L) / (G * Avy), 12);
    expect(sol.nodes.b[2]).toBeCloseTo((-P * L ** 3) / (3 * E * Iy) - (P * L) / (G * Avz), 12);
    // mid-length deflection: P x²(3L − x)/6EI + P x / G A_v
    expect(memberAt3(sol.members[0], 1).uy).toBeCloseTo((P * (3 * L - 1)) / (6 * E * Iz) + P / (G * Avy), 12);
  });

  it('a planar portal analysed in 3-D gives the plane solver’s results', () => {
    // portal in the X-Z plane: fixed feet, a horizontal load at the top, a uniform load and
    // a point load on the beam; the plane solver with I = I_y in (x, y) = (X, Z)
    const h = 4, L = 6, H = 12e3, q = 15e3, P = 30e3;
    const st: NumFrame = {
      nodes: [node('a', 0, 0, 0), node('b', 0, 0, h), node('c', L, 0, h), node('d', L, 0, 0)],
      members: [mem('c1', 'a', 'b'), mem('bm', 'b', 'c'), mem('c2', 'd', 'c')],
      supports: [sup('a'), sup('d')],
      loads: [
        atNode('H', 'b', [H, 0, 0]),
        { id: 'q', type: 'line', member: 'bm', t1: 0, t2: 1, q1: [0, 0, -q], q2: [0, 0, -q], local: false },
        { id: 'P', type: 'point', member: 'bm', t: 0.3, F: [0, 0, -P], M: [0, 0, 0], local: false },
      ],
    };
    const s3 = solveFrame3(st);
    const s2 = solveStructure({
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: h }, { id: 'c', x: L, y: h }, { id: 'd', x: L, y: 0 }],
      members: ['c1:a:b', 'bm:b:c', 'c2:d:c'].map((t) => {
        const [id, a, b] = t.split(':');
        return { id, a, b, E, A, I: Iy };
      }),
      supports: [{ id: 'sa', node: 'a', type: 'fixed', angle: 0, label: 'A' }, { id: 'sd', node: 'd', type: 'fixed', angle: 0, label: 'D' }],
      loads: [
        { id: 'H', type: 'force', at: { node: 'b' }, Fx: H, Fy: 0 },
        { id: 'q', type: 'line', member: 'bm', t1: 0, t2: 1, q1: q, q2: q, dir: 'global' },
        { id: 'P', type: 'force', at: { member: 'bm', t: 0.3 }, Fx: 0, Fy: -P },
      ],
    });
    s2.reactions.forEach((r2, k) => {
      const r3 = s3.reactions[k];
      expect(r3.F[0]).toBeCloseTo(r2.Rx, 5);
      expect(r3.F[2]).toBeCloseTo(r2.Ry, 5);
      // the plane solver's counter-clockwise moment (about −Y seen from the front) is −M_Y
      expect(r3.M[1]).toBeCloseTo(-r2.M, 5);
      expect(r3.F[1]).toBeCloseTo(0, 6);
    });
    for (const id of ['b', 'c']) {
      expect(s3.nodes[id][0]).toBeCloseTo(s2.nodes[id].dx, 12);
      expect(s3.nodes[id][2]).toBeCloseTo(s2.nodes[id].dy, 12);
      expect(s3.nodes[id][4]).toBeCloseTo(-s2.nodes[id].rz, 12);
    }
    // along the members: the beam's local y is −Y, the columns' +Y, so M_y = M on the beam
    // and −M on the columns; N alike
    s2.members.forEach((m2, k) => {
      const m3 = s3.members[k], sign = m3.id === 'bm' ? 1 : -1;
      for (const x of [0, 0.37 * m2.L, 0.5 * m2.L, m2.L]) {
        const p2 = memberAt(m2, x), p3 = memberAt3(m3, x);
        expect(p3.N).toBeCloseTo(p2.N, 4);
        expect(p3.My).toBeCloseTo(sign * p2.M, 4);
        expect(p3.Vz).toBeCloseTo(sign * p2.V, 4);
        expect(p3.ux).toBeCloseTo(p2.dx, 12);
        expect(p3.uz).toBeCloseTo(p2.dy, 12);
      }
    });
  });

  it('a pin-jointed space truss against the equilibrium of its apex', () => {
    // three legs from a triangle on the ground to the apex; P down and H along X at the
    // apex. Method of joints: Σ N_i e_i + F = 0 at the apex, e_i towards the feet.
    const a = 3, h = 4, P = 60e3, H = 10e3;
    const feet: Vec3[] = [[a, 0, 0], [-a / 2, (a * Math.sqrt(3)) / 2, 0], [-a / 2, (-a * Math.sqrt(3)) / 2, 0]];
    const st: NumFrame = {
      nodes: [...feet.map((p, i) => node(`f${i}`, ...p)), node('t', 0, 0, h)],
      members: feet.map((_, i) => mem(`m${i}`, `f${i}`, 't', { relA: PIN_A, relB: PIN_B })),
      supports: feet.map((_, i) => sup(`f${i}`, PINNED)),
      loads: [atNode('P', 't', [H, 0, -P])],
    };
    const sol = solveFrame3(st);
    // e_i = (foot − apex)/ℓ; tension N_i pulls the apex towards the foot: Σ N_i e_i = −F
    const e = feet.map((p) => {
      const d = [p[0], p[1], p[2] - h], l = Math.hypot(...d);
      return d.map((v) => v / l);
    });
    // Cramer's rule on the 3 × 3 system
    const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const Mx = [0, 1, 2].map((r) => [0, 1, 2].map((c) => e[c][r])), rhs = [-H, 0, P];
    const D0 = det3(Mx);
    const N = [0, 1, 2].map((i) => det3(Mx.map((row, r) => row.map((v, c) => (c === i ? rhs[r] : v)))) / D0);
    sol.members.forEach((m, i) => {
      for (const x of [0, m.L / 2, m.L]) {
        const v = memberAt3(m, x);
        expect(v.N).toBeCloseTo(N[i], 4);
        expect(v.My).toBeCloseTo(0, 6);
        expect(v.Mz).toBeCloseTo(0, 6);
        expect(v.T).toBeCloseTo(0, 6);
      }
    });
    // symmetric part: each leg takes P ℓ / 3h in compression
    expect(N.reduce((s, v) => s + v, 0)).toBeCloseTo((-P * Math.hypot(a, h)) / h, 4);
    // statically determinate: 6m + r − 6j − c + locked rotations = 18 + 9 − 24 − 15 + 12 = 0
    expect(sol.indeterminacy).toBe(0);
    const eq = equilibrium(st, sol);
    eq.F.concat(eq.M).forEach((v) => expect(v).toBeCloseTo(0, 5));
  });

  it('a hinge (released moments) carries no moment: a Gerber beam', () => {
    // A–B cantilever, B–C simply supported on it (released at B) and on a pin at C; q on B–C
    const a = 2, b = 5, q = 8e3;
    const st: NumFrame = {
      nodes: [node('A', 0, 0, 0), node('B', a, 0, 0), node('C', a + b, 0, 0)],
      members: [mem('AB', 'A', 'B'), mem('BC', 'B', 'C', { relA: [false, false, false, false, true, true] })],
      supports: [sup('A'), sup('C', PINNED)],
      loads: [{ id: 'q', type: 'line', member: 'BC', t1: 0, t2: 1, q1: [0, 0, -q], q2: [0, 0, -q], local: false }],
    };
    const sol = solveFrame3(st);
    expect(memberAt3(sol.members[1], 0).My).toBeCloseTo(0, 6);
    expect(memberAt3(sol.members[0], a).My).toBeCloseTo(0, 6);
    expect(memberAt3(sol.members[1], b / 2).My).toBeCloseTo((q * b * b) / 8, 4);
    // R_C = q b / 2; the clamp takes the other half with the lever arm a: M = q b a / 2
    expect(sol.reactions[1].F[2]).toBeCloseTo((q * b) / 2, 6);
    expect(sol.reactions[0].F[2]).toBeCloseTo((q * b) / 2, 6);
    expect(Math.abs(sol.reactions[0].M[1])).toBeCloseTo((q * b * a) / 2, 4);
    expect(sol.members[1].ends[0][4]).toBe(0);
  });

  it('a load next to a node, partial line loads and local loads stay in equilibrium', () => {
    const st: NumFrame = {
      nodes: [node('a', 0, 0, 0), node('b', 0, 0, 3.5), node('c', 6, 1, 4), node('d', 6, 1, 0), node('e', 6, 6, 4), node('f', 6, 6, 0)],
      members: [mem('m1', 'a', 'b'), mem('m2', 'b', 'c', { beta: 0.3 }), mem('m3', 'd', 'c'), mem('m4', 'c', 'e', { relB: [false, false, false, false, true, true] }), mem('m5', 'f', 'e', { Avy: 30e-4, Avz: 25e-4 })],
      // (f held about Z: else the column f–e could spin, as m4 is released there)
      supports: [sup('a'), sup('d', [true, true, true, 2e7, false, 1e7]), sup('f', [true, true, true, false, false, true])],
      loads: [
        { id: 'p', type: 'point', member: 'm2', t: 0.0001, F: [3e3, -2e3, -40e3], M: [0, 5e3, 0], local: false },
        { id: 'l', type: 'line', member: 'm2', t1: 0.2, t2: 0.7, q1: [0, 1e3, -5e3], q2: [0, 0, -12e3], local: true },
        { id: 'w', type: 'line', member: 'm5', t1: 0, t2: 1, q1: [2e3, 1e3, 0], q2: [4e3, 1e3, 0], local: false },
        atNode('n', 'e', [1e3, 5e3, -10e3], [2e3, 0, 1e3]),
      ],
    };
    const sol = solveFrame3(st);
    const eq = equilibrium(st, sol);
    eq.F.concat(eq.M).forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-5));
  });

  it('reports a mechanism and where it is', () => {
    // a beam on two pins can spin about its own axis
    const st: NumFrame = {
      nodes: [node('a', 0, 0, 0), node('b', 5, 0, 0)], members: [mem('m', 'a', 'b')],
      supports: [sup('a', PINNED), sup('b', PINNED)], loads: [atNode('P', 'b', [0, 0, -1e3])],
    };
    expect(() => solveFrame3(st)).toThrow(/mechanism.*about X/);
    // held about X at one end it is a simple beam
    expect(solveFrame3({ ...st, supports: [sup('a', [true, true, true, true, false, false]), sup('b', PINNED)] }).reactions[1].F[2]).toBeCloseTo(1e3, 6);
  });
});

describe('space frame: size', () => {
  it('a 10 × 10 bay, 6-storey frame (4356 unknowns) solves in well under a second', () => {
    const nx = 10, ny = 10, nz = 6, id = (i: number, j: number, k: number) => `n${i}_${j}_${k}`;
    const st: NumFrame = { nodes: [], members: [], supports: [], loads: [] };
    for (let k = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      st.nodes.push(node(id(i, j, k), 6 * i, 5 * j, 3.5 * k));
      if (k === 0) st.supports.push(sup(id(i, j, k)));
      else {
        st.members.push(mem(`c${i}_${j}_${k}`, id(i, j, k - 1), id(i, j, k)));
        if (i > 0) st.members.push(mem(`x${i}_${j}_${k}`, id(i - 1, j, k), id(i, j, k)));
        if (j > 0) st.members.push(mem(`y${i}_${j}_${k}`, id(i, j - 1, k), id(i, j, k)));
      }
    }
    for (const m of st.members) if (m.id[0] !== 'c') st.loads.push({ id: `q${m.id}`, type: 'line', member: m.id, t1: 0, t2: 1, q1: [0, 0, -20e3], q2: [0, 0, -20e3], local: false });
    for (let j = 0; j <= ny; j++) for (let k = 1; k <= nz; k++) st.loads.push(atNode(`w${j}_${k}`, id(0, j, k), [10e3, 0, 0]));
    solveFrame3(st);
    const t = performance.now();
    const sol = solveFrame3(st);
    const ms = performance.now() - t;
    expect(sol.unknowns).toBe(4356);
    // (about 0.4 s here; the bound leaves room for a slow machine)
    expect(ms).toBeLessThan(2000);
    const eq = equilibrium(st, sol);
    eq.F.forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-3));
  }, 30000);
});
