import { describe, it, expect } from 'vitest';
import { InstabilityError, memberAt3, solveFrame3, type NumFrame, type NumMember3 } from './solve';
import { buckling3 } from './buckling';

// HEB 200: I_y = 5696 cm⁴, I_z = 2003 cm⁴
const E = 210e9, G = 81e9, A = 78.1e-4, Iy = 5696e-8, Iz = 2003e-8, It = 59.3e-8;
const mem = (id: string, a: string, b: string, extra: Partial<NumMember3> = {}): NumMember3 => ({ id, a, b, E, G, A, Iy, Iz, It, ...extra });
const node = (id: string, x: number, y: number, z: number) => ({ id, x, y, z });

/** A column along Z from 0 to L with P down at its top; `top` holds the top's translations in X and Y. */
function column(L: number, base: (boolean | number)[], top: (boolean | number)[] | null, P: number, H: [number, number] = [0, 0]): NumFrame {
  return {
    nodes: [node('a', 0, 0, 0), node('b', 0, 0, L)],
    members: [mem('c', 'a', 'b')],
    supports: [{ id: 'A', node: 'a', dofs: base }, ...(top ? [{ id: 'B', node: 'b', dofs: top }] : [])],
    loads: [{ id: 'P', type: 'node', node: 'b', F: [H[0], H[1], -P], M: [0, 0, 0] }],
  };
}

const FIXED = [true, true, true, true, true, true];

describe('space frame stability', () => {
  it('α_cr of a column is Euler about its weak axis', () => {
    const L = 5, P = 500e3;
    // cantilever: L_cr = 2L; a vertical member's z axis is −X, so I_z bends it along Y
    const cant = buckling3(column(L, FIXED, null, P), solveFrame3(column(L, FIXED, null, P)));
    const euler = (I: number, Lcr: number) => (Math.PI ** 2 * E * I) / (Lcr * Lcr) / P;
    expect(cant.modes[0].alpha / euler(Iz, 2 * L)).toBeCloseTo(1, 3);
    // the second mode is the strong axis
    expect(cant.modes[1].alpha / euler(Iy, 2 * L)).toBeCloseTo(1, 3);
    // its shape: the top moves along Y, by 1
    const top = cant.modes[0].members[0].d.at(-1)!;
    expect(Math.abs(top[1])).toBeCloseTo(1, 6);
    expect(cant.Lcr.c.z).toBeCloseTo(2 * L, 2);
    // pinned at both ends (the base also held against twisting): L_cr = L
    const pin = column(L, [true, true, true, false, false, true], [true, true, false, false, false, false], P);
    expect(buckling3(pin, solveFrame3(pin)).modes[0].alpha / euler(Iz, L)).toBeCloseTo(1, 3);
  });

  it('a pin-jointed bar (released ends) buckles as an Euler strut', () => {
    // released in bending at both ends: each end turns on its own
    const L = 4, P = 100e3;
    const st: NumFrame = {
      nodes: [node('a', 0, 0, 0), node('b', L, 0, 0)],
      members: [mem('m', 'a', 'b', { relA: [false, false, false, true, true, true], relB: [false, false, false, false, true, true] })],
      supports: [{ id: 'A', node: 'a', dofs: [true, true, true, false, false, false] }, { id: 'B', node: 'b', dofs: [false, true, true, false, false, false] }],
      loads: [{ id: 'P', type: 'node', node: 'b', F: [-P, 0, 0], M: [0, 0, 0] }],
    };
    const b = buckling3(st, solveFrame3(st));
    expect(b.modes[0].alpha / ((Math.PI ** 2 * E * Iz) / (L * L) / P)).toBeCloseTo(1, 3);
    expect(b.modes[1].alpha / ((Math.PI ** 2 * E * Iy) / (L * L) / P)).toBeCloseTo(1, 3);
  });

  it('second order: a cantilever column, δ = H (tan kL − kL) / (P k) about the weak axis', () => {
    const L = 4, P = 300e3, H = 5e3, k = Math.sqrt(P / (E * Iz));
    const st = column(L, FIXED, null, P, [0, H]);
    const s = solveFrame3(st, { secondOrder: true });
    expect(s.nodes.b[1] / ((H * (Math.tan(k * L) - k * L)) / (P * k))).toBeCloseTo(1, 3);
    // the clamp's moment: H L + P δ
    expect(Math.abs(s.reactions[0].M[0]) / (H * L + P * s.nodes.b[1])).toBeCloseTo(1, 4);
    // and along the column, M(x) = H sin(k(L − x)) / (k cos kL) (x from the base)
    const m = s.members[0];
    for (const x of [0, 1.3, 2.9]) expect(Math.abs(memberAt3(m, x).Mz) / ((H * Math.sin(k * (L - x))) / (k * Math.cos(k * L)))).toBeCloseTo(1, 3);
    // and in both planes at once
    const both = solveFrame3(column(L, FIXED, null, P, [H, H]), { secondOrder: true });
    const ky = Math.sqrt(P / (E * Iy));
    expect(both.nodes.b[0] / ((H * (Math.tan(ky * L) - ky * L)) / (P * ky))).toBeCloseTo(1, 3);
    expect(both.nodes.b[1] / ((H * (Math.tan(k * L) - k * L)) / (P * k))).toBeCloseTo(1, 3);
  });

  it('second order: beam-columns with loads along them (Timoshenko & Gere)', () => {
    // pin-ended, held against twisting at one end, compression P along x
    const L = 6, P = 400e3;
    const pinned = (loads: NumFrame['loads']): NumFrame => ({
      nodes: [node('a', 0, 0, 0), node('b', L, 0, 0)],
      members: [mem('m', 'a', 'b')],
      supports: [{ id: 'A', node: 'a', dofs: [true, true, true, true, false, false] }, { id: 'B', node: 'b', dofs: [false, true, true, false, false, false] }],
      loads: [{ id: 'P', type: 'node', node: 'b', F: [-P, 0, 0], M: [0, 0, 0] }, ...loads],
    });
    // uniform q down (local +z): M_mid = (q L²/8) · 2 (1 − cos u) / (u² cos u), u = kL/2, about the strong axis
    const q = 20e3, k = Math.sqrt(P / (E * Iy)), u = (k * L) / 2;
    const s1 = solveFrame3(pinned([{ id: 'q', type: 'line', member: 'm', t1: 0, t2: 1, q1: [0, 0, -q], q2: [0, 0, -q], local: false }]), { secondOrder: true });
    expect(memberAt3(s1.members[0], L / 2).My / (((q * L * L) / 8) * (2 * (1 - Math.cos(u))) / (u * u * Math.cos(u)))).toBeCloseTo(1, 3);
    // and its deflection: w = 5qL⁴/384EI · 24 (sec u − 1 − u²/2) / (5 u⁴)
    const w = ((5 * q * L ** 4) / (384 * E * Iy)) * ((24 * (1 / Math.cos(u) - 1 - (u * u) / 2)) / (5 * u ** 4));
    expect(-memberAt3(s1.members[0], L / 2).uz / w).toBeCloseTo(1, 3);
    // a point load Q at 0.3 L along y (weak axis), inside an element: M(a) = Q sin(k(L − a)) sin(ka) / (k sin kL)
    const Q = 8e3, kz = Math.sqrt(P / (E * Iz)), a = 0.3 * L;
    const s2 = solveFrame3(pinned([{ id: 'Q', type: 'point', member: 'm', t: 0.3, F: [0, Q, 0], M: [0, 0, 0], local: false }]), { secondOrder: true });
    const exact = (Q * Math.sin(kz * (L - a)) * Math.sin(kz * a)) / (kz * Math.sin(kz * L));
    expect(Math.abs(memberAt3(s2.members[0], a).Mz) / exact).toBeCloseTo(1, 3);
  });

  it('second order and buckling of a pin-jointed tower', () => {
    // a square lattice tower (legs, rings, one diagonal per face), every bar pin-jointed
    const w = 2, levels = [0, 2, 4, 6], P = 200e3;
    const nodes = levels.flatMap((z, k) => [[0, 0], [w, 0], [w, w], [0, w]].map(([x, y], c) => node(`n${k}${c}`, x, y, z)));
    const pin = { relA: [false, false, false, true, true, true], relB: [false, false, false, false, true, true] };
    const members: NumMember3[] = [];
    for (let k = 0; k + 1 < levels.length; k++) {
      for (let c = 0; c < 4; c++) {
        const c2 = (c + 1) % 4;
        members.push(mem(`l${k}${c}`, `n${k}${c}`, `n${k + 1}${c}`, pin), mem(`r${k}${c}`, `n${k + 1}${c}`, `n${k + 1}${c2}`, pin), mem(`d${k}${c}`, `n${k}${c}`, `n${k + 1}${c2}`, pin));
      }
      members.push(mem(`p${k}`, `n${k + 1}0`, `n${k + 1}2`, pin));
    }
    const st: NumFrame = {
      nodes, members,
      supports: [0, 1, 2, 3].map((c) => ({ id: `s${c}`, node: `n0${c}`, dofs: [true, true, true, false, false, false] })),
      loads: [0, 1, 2, 3].map((c) => ({ id: `P${c}`, type: 'node' as const, node: `n3${c}`, F: [5e3, 0, -P / 4] as [number, number, number], M: [0, 0, 0] as [number, number, number] })),
    };
    const first = solveFrame3(st);
    const b = buckling3(st, first);
    expect(b.modes[0].alpha).toBeGreaterThan(1);
    // a truss member that buckles alone does so as a pin-ended strut: no α below the weakest leg's
    const legN = Math.min(...first.members.filter((m) => m.id[0] === 'l').map((m) => Math.min(...m.N)));
    expect(b.modes[0].alpha).toBeLessThanOrEqual((Math.PI ** 2 * E * Iz) / (2 * 2) / -legN * (1 + 1e-3));
    // second order converges and stays near first order well below α_cr
    const second = solveFrame3(st, { secondOrder: true });
    const top = (s: typeof first) => s.nodes.n30[0];
    expect(top(second) / top(first)).toBeGreaterThan(1);
    expect(top(second) / top(first)).toBeLessThan(1 / (1 - 1 / b.modes[0].alpha) * 1.05);
    for (const m of second.members) expect(Math.abs(memberAt3(m, 0).My)).toBeLessThan(1e-6 * P);
  });

  it('shear deformation: Engesser’s critical load and the second-order cantilever column', () => {
    // a column with a small shear area A_v (so P_e / G A_v ≈ 5 %), about the weak axis
    const L = 3, Av = 10e-4, GA = G * Av;
    const pinned: NumFrame = {
      ...column(L, [true, true, true, false, false, true], [true, true, false, false, false, false], 100e3),
      members: [mem('c', 'a', 'b', { Avy: Av, Avz: Av })],
    };
    // Timoshenko & Gere §2.17: P_cr = P_e / (1 + P_e / G A_v) (Engesser); Haringx's
    // (√(1 + 4P_e/GA) − 1) GA / 2 is 0.3 % higher. The consistent Timoshenko element lies
    // between the two, within 0.1 % of Engesser's.
    const Pe = (Math.PI ** 2 * E * Iz) / (L * L), engesser = Pe / (1 + Pe / GA);
    const alpha = buckling3(pinned, solveFrame3(pinned)).modes[0].alpha;
    expect(Math.abs((alpha * 100e3) / engesser - 1)).toBeLessThan(1e-3);
    // second order, the clamped column with H at its top: v″ = M/EI − M″/GA and M″ = −P v″
    // give v″ = M / (EI (1 − P/GA)), so k² = P / (EI (1 − P/GA)); at the clamp θ = 0 but
    // v′ = γ = H / (GA − P). With M = H (L − x) + P (v_L − v):
    // v_L = H / (P k) · (tan kL / (1 − P/GA) − kL)
    const P = 300e3, H = 5e3, Av2 = 15e-4, GA2 = G * Av2, k = Math.sqrt(P / (E * Iz * (1 - P / GA2)));
    const cant: NumFrame = { ...column(4, FIXED, null, P, [0, H]), members: [mem('c', 'a', 'b', { Avy: Av2, Avz: 30e-4 })] };
    const top = solveFrame3(cant, { secondOrder: true }).nodes.b[1];
    expect(top / ((H / (P * k)) * (Math.tan(4 * k) / (1 - P / GA2) - 4 * k))).toBeCloseTo(1, 4);
  });

  it('above the critical load there is no second-order equilibrium', () => {
    const L = 4, Pcr = (Math.PI ** 2 * E * Iz) / (2 * L) ** 2;
    expect(() => solveFrame3(column(L, FIXED, null, 1.2 * Pcr, [0, 1e3]), { secondOrder: true })).toThrow(InstabilityError);
    expect(() => solveFrame3(column(L, FIXED, null, 0.9 * Pcr, [0, 1e3]), { secondOrder: true })).not.toThrow();
  });
});
