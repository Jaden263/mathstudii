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

  it('above the critical load there is no second-order equilibrium', () => {
    const L = 4, Pcr = (Math.PI ** 2 * E * Iz) / (2 * L) ** 2;
    expect(() => solveFrame3(column(L, FIXED, null, 1.2 * Pcr, [0, 1e3]), { secondOrder: true })).toThrow(InstabilityError);
    expect(() => solveFrame3(column(L, FIXED, null, 0.9 * Pcr, [0, 1e3]), { secondOrder: true })).not.toThrow();
  });
});
