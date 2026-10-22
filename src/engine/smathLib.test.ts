import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type MathResult } from './evaluator';
import { createRegion, emptyWorksheet } from '../model/types';

/** Evaluate lines as an SMath-like worksheet (ORIGIN 1); the TeX (or error) of the last line. */
function last(lines: string[]): string {
  const ws = emptyWorksheet();
  ws.settings.origin = 1;
  ws.regions = lines.map((s, i) => createRegion('math', 20, 20 + i * 30, { source: s }));
  const out = evaluateWorksheet(ws);
  const res = out.results.get(ws.regions[ws.regions.length - 1].id) as MathResult;
  return res.error ? `ERR ${res.error}` : res.tex;
}
const nums = (tex: string) => (tex.split(' = ').pop()!.match(/-?\d+(\.\d+)?(e[+-]?\d+)?/g) ?? []).map(Number);

describe('SMath built-ins', () => {
  it('roots(f, x, x₀) from an initial value, an equation as its difference, units kept', () => {
    expect(nums(last(['f(x) := x^2 - 2', 'roots(f(x), x, 1) =']))[0]).toBeCloseTo(Math.SQRT2, 3);
    expect(nums(last(['f(x) := x^2 - 2', 'roots(f(x), x, -1) =']))[0]).toBeCloseTo(-Math.SQRT2, 3);
    expect(nums(last(['roots(x^3 == 8, x, 1) =']))[0]).toBeCloseTo(2, 10);
    expect(last(['r := roots(x^2 == 2, x, 1)', 'abs(r - sqrt(2)) < 1e-12'])).toMatch(/OK/);
    // σ(φ) = 0 in MPa: 0 has any unit
    expect(nums(last(['σ(φ) := 10 MPa + 30 MPa*cos(2*φ)', 'roots(σ(φ) == 0, φ, 1) =']))[0]).toBeCloseTo(0.5 * Math.acos(-1 / 3), 3);
    expect(last(['L := roots(x^2 == 4 m^2, x, 1 m)', 'L = m'])).toMatch(/= 2\\ \\mathrm\{m\}/);
    expect(last(['roots(x^2 - 2, x) ='])).toMatch(/ERR roots: give an initial value/);
    // SMath saved V_BE = 1.231 V: f takes a number x (x·V in it), the initial value v_x is in V
    const diode = ['I_s := 0.05 pA', 'V_T := 25.865 mV', 'f(x) := I_s/(A*76)*(e^(x*V/(1.8*V_T)) - 1) - (15 - x)/68000', 'v_x := 1.2355 V'];
    expect(nums(last([...diode, 'roots(f(x), x, v_x) =']))[0]).toBeCloseTo(1.2312, 3);
    expect(last(['roots(x - 1 s, x, 1 m) ='])).toMatch(/ERR/);
  });

  it('roots(f, x, a, b) gives every root between a and b (SMath solve(f, x, a, b))', () => {
    // SMath saved φ₀ = [-54.7; 54.7] deg for σ_x = 40, σ_y = -20 MPa
    const r = nums(last(['σ(φ) := 10 MPa + 30 MPa*cos(2*φ)', 'roots(σ(φ) == 0, φ, -(π/2), π/2) =']));
    expect(r.map((x) => (x * 180) / Math.PI)).toEqual([expect.closeTo(-54.7356, 1), expect.closeTo(54.7356, 1)]);
    expect(nums(last(['roots(x - 3, x, 0, 10) =']))).toEqual([3]);
    // a pole is no root
    expect(last(['roots(1/(x - 1), x, 0, 3) ='])).toMatch(/ERR roots: no root/);
  });

  it('subs(f, x = a) substitutes (SMath at)', () => {
    expect(nums(last(['subs(x^2 + y, x == 3, y == 1) =']))).toEqual([10]);
    expect(last(['σ(φ) := 10 MPa*cos(φ)', 'subs([σ(φ); 2*σ(φ)], φ == 0) = MPa'])).toMatch(/10.*20/);
    expect(last(['subs(x^2, 3) ='])).toMatch(/ERR subs: the values are given as x = value/);
    // "at" stays a unit
    expect(last(['p := 2 at', 'p = kg'])).toMatch(/= 2 \\cdot 10\^\{-15\}/);
  });

  it('xy2pol and pol2xy: SMath saved [71.7096; 0.6938] for 55.13 + 45.86i ohm', () => {
    const r = nums(last(['xy2pol(55.130265 ohm, 45.857466 ohm) =']));
    expect(r[0]).toBeCloseTo(71.7096, 3);
    expect(r[1]).toBeCloseTo(0.6938, 4);
    expect(nums(last(['pol2xy(2 m, 90 deg)[2] = m']))).toEqual([2]);
    expect(nums(last(['pol2xy(2 m, π/3)[1] = m']))).toEqual([1]);
    expect(last(['xy2pol(1 m, 1 s) ='])).toMatch(/ERR xy2pol: x and y need the same unit/);
  });

  it('minor(M, i, j): the determinant without row i and column j', () => {
    // the cofactors of C = [1, -3, 0; -1, 4, 0; 0, 0, 1] SMath saved as its inverse
    expect(nums(last(['C := [1, -3, 0; -1, 4, 0; 0, 0, 1]', 'minor(C, 1, 1) =']))).toEqual([4]);
    expect(nums(last(['C := [1, -3, 0; -1, 4, 0; 0, 0, 1]', 'minor(C, 1, 2) =']))).toEqual([-1]);
    expect(nums(last(['C := [1, -3, 0; -1, 4, 0; 0, 0, 1]', 'minor(C, 3, 3) =']))).toEqual([1]);
    expect(last(['minor([1, 2, 3], 1, 1) ='])).toMatch(/ERR minor: the matrix must be square/);
  });

  it('Clear(x, …) removes definitions: x[1] := … then starts a fresh vector', () => {
    expect(last(['a := 5', 'Clear(a) ='])).toMatch(/= 1$/);
    expect(last(['a := 5', 'Clear(a) =', 'a ='])).toMatch(/ERR "a" is not defined/);
    expect(last(['t[1] := 3', 't[2] := 4', 'Clear(t) =', 't[1] := 7', 'length(t) ='])).toMatch(/= 1$/);
    expect(last(['Clear(2) ='])).toMatch(/ERR Clear\(x, y, …\) takes variable names/);
  });

  it('a worksheet variable may have the name of one', () => {
    expect(nums(last(['minor := 4', 'minor + 1 =']))).toEqual([5]);
  });
});
