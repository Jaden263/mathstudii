import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type MathResult } from './evaluator';
import { createRegion, emptyWorksheet } from '../model/types';

/** Evaluate lines as a worksheet; the TeX (or error) of each line. */
function run(lines: string[]): string[] {
  const ws = emptyWorksheet();
  ws.regions = lines.map((s, i) => createRegion('math', 20, 20 + i * 30, { source: s }));
  const out = evaluateWorksheet(ws);
  return ws.regions.map((r) => {
    const res = out.results.get(r.id) as MathResult;
    return res.error ? `ERR ${res.error}` : res.tex;
  });
}
const last = (lines: string[]) => run(lines).pop()!;
/** The numbers in a result's TeX, after the = sign. */
const nums = (tex: string) => (tex.split(' = ').pop()!.match(/-?\d+(\.\d+)?(e[+-]?\d+)?/g) ?? []).map(Number);

describe('names that are units and functions', () => {
  it('min, sec and pF written as values are the units', () => {
    expect(last(['t := 5 min', 't = s'])).toMatch(/= 300\\ \\mathrm\{s\}$/);
    expect(last(['T := 1800 sec', 'T = min'])).toMatch(/= 30\\ \\mathrm\{min\}$/);
    expect(last(['C := 10 pF', 'C = nF'])).toMatch(/= 0.01\\ \\mathrm\{nF\}$/);
    // called, they are the functions; a worksheet variable of the name wins
    expect(last(['min(3, 4) ='])).toMatch(/= 3$/);
    expect(last(['min := 7', 'min + 1 ='])).toMatch(/= 8$/);
  });
});

describe('Mathcad built-ins', () => {
  it('table lookup', () => {
    const W = 'W := ["X", 1; "Y", 2; "Z", 3; "Y", 4]';
    expect(nums(last([W, 'vlookup("Y", W, 1) =']))).toEqual([2, 4]);
    expect(nums(last(['V := [1; 3; 5; 3]', 'match(3, V) =']))).toEqual([1, 3]);
    expect(nums(last(['A := [1; 2; 3]', 'B := [10; 20; 30]', 'lookup(2, A, B) =']))).toEqual([20]);
    expect(nums(last(['H := ["a", "b"; 7, 8]', 'hlookup("b", H, 1) =']))).toEqual([8]);
    expect(last(['vlookup("Q", ["X", 1], 1) ='])).toMatch(/ERR vlookup: "Q" not found/);
    expect(nums(last(['trim([1; 2; 3; 4], [0, 2]) =']))).toEqual([2, 4]);
  });

  it('statistics: percentile at p(n + 1) (Mathcad Prime saved 9.8), skew and excess kurtosis', () => {
    expect(nums(last(['percentile([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) =']))[0]).toBeCloseTo(9.8, 12);
    // hand: n/((n−1)(n−2)) Σz³ with z from the sample deviation: 1.76364 for 1, 2, 3, 10
    expect(nums(last(['skew([1, 2, 3, 10]) =']))[0]).toBeCloseTo(1.7636, 4);
    // n(n+1)/((n−1)(n−2)(n−3)) Σz⁴ − 3(n−1)²/((n−2)(n−3)) = 1.25·8.9216 − 8 = 3.152 for 1, 2, 3, 10, 4
    expect(nums(last(['kurt([1, 2, 3, 10, 4]) =']))[0]).toBeCloseTo(3.152, 3);
    expect(nums(last(['Rank([30, 10, 20]) =']))).toEqual([3, 1, 2]);
    expect(nums(last(['logspace(1, 1000, 4) =']))).toEqual([1, 10, 100, 1000]);
  });

  it('linear algebra: condition numbers, singular values, rref, eigen order as Mathcad reports it', () => {
    // ‖A‖₁‖A⁻¹‖₁ = 6·3.5; σ₁/σ₂ = 5.4650/0.36597
    expect(nums(last(['cond1([1, 2; 3, 4]) ='])) ).toEqual([21]);
    expect(nums(last(['cond2([1, 2; 3, 4]) =']))[0]).toBeCloseTo(14.933, 3);
    expect(nums(last(['svds([1, 2; 3, 4]) =']))[0]).toBeCloseTo(5.465, 3);
    expect(nums(last(['rref([1, 2, 3; 4, 5, 6; 7, 8, 10]) =']))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // Mathcad Prime saved these orders (mcad2py's matrices.mcdx): largest first
    const e = nums(last(['M := [3, 2, 1, 0; 2, 3, 2, 1; 1, 2, 3, 2; 0, 1, 2, 3]', 'eigenvals(M) =']));
    expect(e.map((x) => +x.toFixed(4))).toEqual([7.1623, 3.4142, 0.8377, 0.5858]);
    expect(nums(last(['eigenvals([3, 2; 3, -2]) =']))).toEqual([4, -3]);
    // and kept the diagonal's order for a triangular matrix
    expect(nums(last(['eigenvals([2, 0; 0, 3]) =']))).toEqual([2, 3]);
    // left eigenvectors: those of Aᵀ, unit length (λ = 4: (1, 1)/√2 for [1, 2; 3, 2])
    expect(nums(last(['eigenvecs([1, 2; 3, 2], "L") =']))[0]).toBeCloseTo(Math.SQRT1_2, 4);
    expect(nums(last(['reverse([1, 2; 3, 4]) =']))).toEqual([3, 4, 1, 2]);
  });

  it('Mathcad conventions: acot on (0, π), hyperbolic functions of degrees, round of a quantity', () => {
    // acot(−2) = π/2 − atan(−2), saved by Mathcad Prime as 2.677945
    expect(nums(last(['acot(-2) =']))[0]).toBeCloseTo(2.6779, 4);
    expect(nums(last(['sinh(30 deg) =']))[0]).toBeCloseTo(Math.sinh(Math.PI / 6), 4);
    expect(last(['round(3.14159 m, 2) ='])).toMatch(/= 3.14\\ \\mathrm\{m\}$/);
  });

  it('splines with Mathcad end conditions reproduce what they should', () => {
    // a cubic spline with cubic ends (not-a-knot) is exact for x³, a parabolic one for x²
    const xs = '[0; 0.5; 1.7; 2.5; 4]';
    expect(nums(last([`vx := ${xs}`, 'vy := vectorize(vx^3)', 'interp(cspline(vx, vy), vx, vy, 3.1) =']))[0]).toBeCloseTo(3.1 ** 3, 10);
    expect(nums(last([`vx := ${xs}`, 'vy := vectorize(vx^2)', 'interp(pspline(vx, vy), vx, vy, 3.1) =']))[0]).toBeCloseTo(3.1 ** 2, 10);
    // natural (lspline): no curvature at the ends
    expect(nums(last([`vx := ${xs}`, 'vy := vectorize(vx^2)', 's := lspline(vx, vy)', 's[0] =']))[0]).toBe(0);
  });

  it('vectorize applies scalar functions and programs element by element', () => {
    expect(nums(last(['f(e) := max(min(2*e, 3), -3)', 'v := [1; 2; -5]', 'vectorize(f(v)) =']))).toEqual([2, 3, -3]);
    expect(nums(last(['n := [1; 3]', 'vectorize([2; 8]*(1/(n + 1))) =']))).toEqual([1, 2]);
  });
});

describe('Mathcad semantics', () => {
  it('a recurrence reads the elements written before; the definition shows what it wrote', () => {
    const r = run(['X := 2', 'g[0] := 1', 'i := 0 .. 3', 'g[i + 1] := (g[i] + X/g[i])/2', 'g[4] =', 'j := 1 .. 2', 'w[j] := 10*j =']);
    expect(nums(r[4])[0]).toBeCloseTo(Math.SQRT2, 4);
    expect(nums(r[6])).toEqual([10, 20]);
  });

  it('programs: x[i] ← … grows a new vector, col(M, j) ← v sets a column', () => {
    expect(nums(last(['e(n) :=\n  y[0] ← 1\n  for i ∈ 1 .. n\n    y[i] ← 2*y[i - 1]\n  y', 'e(3) =']))).toEqual([1, 2, 4, 8]);
    // Jacobi iteration as written in a real Mathcad 15 sheet: x⟨k+1⟩ ← B·x⟨k⟩ + C
    const p = 'p(B, C, n) :=\n  col(x, 0) ← C\n  for k ∈ 0 .. n - 1\n    col(x, k + 1) ← B*col(x, k) + C\n  x';
    expect(nums(last([p, 'p([0.5, 0; 0, 0.5], [1; 2], 2) =']))).toEqual([1, 1.5, 1.75, 2, 3, 3.5]);
  });

  it('a worksheet function named like a built-in replaces it', () => {
    expect(nums(last(['log(x) := x^2', 'log(2) =']))).toEqual([4]);
  });

  it('angles count as plain numbers in display units', () => {
    expect(last(['f := 5/(1 s)', 'f = rad/s'])).toMatch(/= 5\\ \\frac\{\\mathrm\{rad\}\}\{\\mathrm\{s\}\}$/);
    expect(nums(last(['ρ := 10 cm/(2 rad)', 'ρ = cm']))).toEqual([5]);
    expect(last(['e := 2 mm/(1 m)', 'e = %'])).toMatch(/= 0.2\\,\\%$/);
    expect(last(['w := 3 rad/s', 'w = 1/s'])).toMatch(/= 3\\ \\mathrm\{s\}\^\{-1\}$/);
  });
});

describe('random numbers as Mathcad draws them', () => {
  // values Mathcad Prime 12 saved after Seed(1) (mcad2py's seed.mcdx)
  it('Seed(1) restarts the stream; every calculation starts at 1', () => {
    expect(nums(last(['runif(4, 0, 1) =']))).toEqual([0.0013, 0.1933, 0.585, 0.3503]);
    const r = run(['s := Seed(1)', 'rnorm(1, 0, 1) =']);
    expect(nums(r[1])[0]).toBeCloseTo(-0.439, 3);
    expect(nums(last(['a := runif(3, 0, 1)', 's := Seed(1)', 'b := runif(3, 0, 1)', 'max(abs(a - b)) =']))).toEqual([0]);
  });
});
