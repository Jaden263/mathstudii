// Mathcad semantics that imported worksheets rely on, each checked against the value Mathcad
// saved with a real worksheet or against PTC's documented behaviour.
import { describe, it, expect, beforeAll } from 'vitest';
import { evaluateWorksheet, evaluateWithScope, type MathResult, type SolveResult } from './evaluator';
import { emptyWorksheet, createRegion, type Region, type Worksheet } from '../model/types';
import { loadCas } from './symbolic';

function sheet(lines: (string | Region)[], settings: Partial<Worksheet['settings']> = {}): Worksheet {
  const ws = emptyWorksheet();
  ws.settings = { ...ws.settings, ...settings };
  ws.regions = lines.map((l, i) => {
    const r = typeof l === 'string' ? createRegion('math', 40, 40 + i * 40, { source: l }) : l;
    r.y = 40 + i * 40;
    return r;
  });
  return ws;
}

/** The results of every region. */
function run(lines: (string | Region)[], settings?: Partial<Worksheet['settings']>) {
  const ws = sheet(lines, settings);
  const out = evaluateWorksheet(ws);
  return ws.regions.map((r) => out.results.get(r.id)!);
}

/** The shown value of the last region (the TeX after its last "="). */
function shown(lines: (string | Region)[], settings?: Partial<Worksheet['settings']>): string {
  const res = run(lines, settings);
  const last = res[res.length - 1];
  const tex = last.kind === 'solve' ? (last as SolveResult).solver.tex : (last as MathResult).tex;
  const err = last.kind === 'solve' ? (last as SolveResult).solver.error : (last as MathResult).error;
  if (err) throw new Error(err);
  return tex.slice(tex.lastIndexOf(' = ') + 3);
}

beforeAll(async () => {
  await loadCas();
});

describe('names', () => {
  it('may be written in any alphabet (Cyrillic worksheets)', () => {
    expect(shown(['m_сух := 3', 'm_топ := 1', 'm_0 := m_сух + m_топ =', 'F_аэрод(V) := 2 V', 'F_аэрод(m_0) ='])).toBe('8');
    expect(shown(['Höhe := 2 m', 'Höhe^2 ='])).toMatch(/^4\\ \\mathrm\{m\}\^\{2\}$/);
  });
  it('keep Σ, π and Γ that are letters of a name (γ_Σ_dB), while Σ(…), 2 π and Γ(…) stay operators', () => {
    expect(shown(['γ_Σ_dB := 30', 'γ_Σ := 10^(γ_Σ_dB/10)', 'x_π := 2', 'γ_Σ + x_π ='])).toBe('1002');
    expect(shown(['Σ(k, k, 1, 4) + Γ(5) ='])).toBe('34');
    expect(shown(['2π ='])).toBe('6.2832');
  });
});

describe('odesolve', () => {
  it('takes Prime’s form odesolve(y(t), b) with the unknown written with its variable', () => {
    const block = createRegion('solve', 40, 0, { guesses: '', constraints: "h''(t) = -9.81\nh(0) = 0\nh'(0) = 10", solver: 'h := odesolve(h(t), 3)' });
    // h(1) = 10 − 9.81/2
    expect(shown([block, 'h(1) ='])).toBe('5.095');
  });
});

describe('arithmetic', () => {
  it('adds a plain 0 to a quantity of any unit (a matrix product over [w, 0; 0, l])', () => {
    // RC_col.mcdx: Contour := ½·([−1, −1; …]·[w_c, 0; 0, l_c]) saved as ±0.65 m corners
    expect(shown(['w := 1.3 m', 'l := 1.3 m', 'C := 1/2*([-1, -1; -1, 1]*[w, 0; 0, l])', 'C[1, 1] = m'])).toMatch(/^0\.65\\ \\mathrm\{m\}$/);
    expect(shown(['a := 2 m', 'a - 0 + (0 - a) ='])).toBe('0\\ \\mathrm{m}');
    expect(() => shown(['a := 2 m', 'a + 1 ='])).toThrow(/Units do not match/);
  });
  it('raises a vector to a power element by element, a square matrix as a matrix', () => {
    // GBerezin Column.mcdx: A_s := π·d_s²/4 of a vector of bar diameters, saved as a vector of areas
    expect(shown(['d_s := [32; 18] mm', 'A_s := π*d_s^2/4 = cm^2'])).toMatch(/8\.0425 \\\\ 2\.5447/);
    expect(shown(['[1, 2; 3, 4]^2 ='])).toMatch(/7 & 10 \\\\ 15 & 22/);
  });
});

describe('ORIGIN', () => {
  it('is a variable worksheets read, and ORIGIN := 1 moves the first index from there on', () => {
    expect(shown(['ORIGIN ='])).toBe('0');
    expect(shown(['ORIGIN ='], { origin: 1 })).toBe('1');
    expect(shown(['v := [5; 6; 7]', 'ORIGIN := 1', 'v[ORIGIN] + v[3] ='])).toBe('12');
  });
});

describe('comparisons and programs', () => {
  it('a comparison followed by = has the value 1 or 0', () => {
    const ws = sheet(['a := 2', 'a < 3 =', 'a > 3 =']);
    const { shown: values } = evaluateWithScope(ws);
    expect(ws.regions.slice(1).map((r) => values.get(r.id))).toEqual([1, 0]);
  });
  it('a program whose last if is false has the value computed before it', () => {
    // kut666 practice worksheets (Mathcad 15): the value of the last line that ran
    expect(shown(['f(x) :=\n  y ← 1\n  if x > 0\n    y ← 2', 'f(-1) + 10 f(1) ='])).toBe('21');
  });
});

describe('built-in functions', () => {
  it('SIUnitsOf and UnitsOf: the SI unit of a value or of an array', () => {
    expect(shown(['SIUnitsOf(5 km) ='])).toBe('1\\ \\mathrm{m}');
    expect(shown(['UnitsOf([1; 2] kN) ='])).toBe('1\\ \\mathrm{N}');
    expect(shown(['SIUnitsOf(3) ='])).toBe('1');
    // IF97 Units: p/SIUnitsOf(p) strips the unit off for a DLL call
    expect(shown(['p := 2 MPa', 'p/SIUnitsOf(p) ='])).toBe('2 \\cdot 10^{6}');
  });
  it('the product of two vectors is their dot product', () => {
    // Lab01.xmcd saved 1573.9247
    expect(shown(['[-36.13; 5.98; -30.44]*[-18.25; -17.03; -33.39] ='])).toBe('1573.9247');
    expect(shown(['[1, 2; 3, 4]*[1; 1] ='])).toMatch(/3 \\\\ 7/);
  });
  it('coordinate conversions', () => {
    // Lab01.xmcd saved [23.861021; 3.5565473; 17.442923]
    expect(shown(['sph2xyz(-29.77, -15.56, 8.48) ='])).toMatch(/23\.861 \\\\ 3\.5565 \\\\ 17\.4429/);
    expect(shown(['v := xyz2sph(1, 1, 1)', 'sph2xyz(v) ='])).toMatch(/^\\begin\{bmatrix\} 1 \\\\ 1 \\\\ 1 \\end\{bmatrix\}$/);
    expect(shown(['xy2pol(3 m, 4 m) ='])).toMatch(/5\\ \\mathrm\{m\} \\\\ 0\.9273/);
    expect(shown(['cyl2xyz(xyz2cyl(1, 2, 3)) ='])).toMatch(/1 \\\\ 2 \\\\ 3/);
  });
  it('means and rank correlations', () => {
    expect(shown(['gmean([1; 4], 16) ='])).toBe('4');
    expect(shown(['hmean(1, 4, 4) ='])).toBe('2');
    expect(shown(['Spear([1; 2; 3; 4], [1; 3; 2; 4]) ='])).toBe('0.8');
    expect(shown(['kendltau([1; 2; 3; 4], [1; 3; 2; 4]) ='])).toBe('0.6667');
  });
  it('error(S) stops with the message S; IsNaN', () => {
    expect(() => shown(['f(x) := error("too small")', 'f(1) ='])).toThrow('too small');
    expect(shown(['g(x) :=\n  try\n    error("no")\n  on error\n    2', 'g(1) ='])).toBe('2');
    expect(shown(['IsNaN(NaN) + IsNaN(1) ='])).toBe('1');
  });
});

describe('programs', () => {
  it('a local definition can take a program of its own (Mathcad nests programs as operands)', () => {
    expect(shown(['f(n) :=\n  r ←\n    a ← 2\n    a*n\n  r + 1', 'f(5) ='])).toBe('11');
    // a return inside the nested program ends that program only
    expect(shown(['g(n) :=\n  r ←\n    if n > 0\n      return 1\n    -1\n  10 r', 'g(3) + g(-3) ='])).toBe('0');
  });
  it('[a; b] ←, local functions f(x) ←, and row(M, i) ← in programs', () => {
    expect(shown(['f(n) :=\n  [p; q] ← [n; 3 n]\n  g(x) ← x + q\n  g(1) + p', 'f(5) ='])).toBe('21');
    expect(shown(['M :=\n  M ← [0, 0; 0, 0]\n  row(M, 1) ← [7, 8]\n  col(M, 0) ← [1; 2]\n  M', 'M ='])).toMatch(/1 & 0 \\\\ 2 & 8/);
  });
  it('x := = unit shows the value of a program in that unit', () => {
    expect(shown(['L :=\n  a ← 2 m\n  a + 50 cm', 'L ='])).toBe('2.5\\ \\mathrm{m}');
    const res = run(['L := = mm\n  a ← 2 m\n  a + 50 cm']);
    expect((res[0] as MathResult).tex).toMatch(/= 2500\\ \\mathrm\{mm\}$/);
  });
});

describe('number formats', () => {
  const fmtRegion = (source: string, format: object) => createRegion('math', 40, 0, { source, format });
  it('general, decimal, scientific and engineering, with or without trailing zeros', () => {
    expect(shown(['x := 1234.5678', 'x ='], { precision: 3 })).toBe('1234.568');
    expect(shown([fmtRegion('0.000012345 =', { style: 'decimal', precision: 6 })])).toBe('0.000012');
    expect(shown([fmtRegion('12345.6 =', { style: 'scientific', precision: 2 })])).toBe('1.23 \\cdot 10^{4}');
    expect(shown([fmtRegion('12345.6 =', { style: 'engineering', precision: 2 })])).toBe('12.35 \\cdot 10^{3}');
    expect(shown([fmtRegion('0.000160218 =', { style: 'engineering', precision: 3 })])).toBe('160.218 \\cdot 10^{-6}');
    expect(shown([fmtRegion('1.5 =', { style: 'decimal', precision: 3, trailingZeros: true })])).toBe('1.500');
    expect(shown([fmtRegion('12.3 =', { style: 'engineering', precision: 1 })])).toBe('12.3');
  });
  it('a region’s format does not change the others', () => {
    const res = run([fmtRegion('1.23456 =', { precision: 1 }), '1.23456 =']);
    expect((res[0] as MathResult).tex).toMatch(/= 1\.2$/);
    expect((res[1] as MathResult).tex).toMatch(/= 1\.2346$/);
  });
});

describe('systems of element definitions', () => {
  it('[x[i + 1]; y[i + 1]] := […]: each step calculates the whole right side, then writes the elements', () => {
    const lines = ['i := 0 .. 3', '[x[0]; y[0]] := [1; 0]', '[x[i + 1]; y[i + 1]] := [x[i] + y[i]; x[i]]'];
    // y takes the x of the step before (not the one written beside it): Fibonacci in both
    expect(shown([...lines, 'x[4] ='])).toBe('5');
    expect(shown([...lines, 'y[4] ='])).toBe('3');
    expect(shown([...lines, 'rows(y) ='])).toBe('5');
  });
  it('a name among the elements takes its value as it is', () => {
    expect(shown(['[a[1]; b] := [2; 3]', 'a[1] + b ='])).toBe('5');
  });
});

describe('nested arrays', () => {
  it('a matrix literal with arrays among its elements nests them, never joins them', () => {
    // [X; Y] of vectors of different lengths, or of a vector beside a number
    expect(shown(['X := [1; 2]', 'Y := [3; 4; 5]', 'N := [X; Y]', 'rows(N) ='])).toBe('2');
    expect(shown(['X := [1; 2]', 'Y := [3; 4; 5]', 'N := [X; Y]', 'B := N[1]', 'B[2] ='])).toBe('5');
    expect(shown(['X := [1; 2]', 'P := [X; 3]', 'P[1] + rows(P) ='])).toBe('5');
    // of one shape, too: an element is a whole array
    expect(shown(['X := [1; 2]', 'M := [X; 2 X]', 'B := M[1]', 'B[1] ='])).toBe('4');
  });
  it('[a; b] := [X; Y] takes each array as it is', () => {
    expect(shown(['X := [1; 2]', 'Y := [3; 4; 5]', '[a; b] := [X; Y]', 'rows(a) + b[2] ='])).toBe('7');
    expect(shown(['X := [1; 2]', '[p; q] := [X; 3 X]', 'q[1] ='])).toBe('6');
  });
  it('E[i] ← an array makes that element the array', () => {
    expect(shown(['g :=\n  E[0] ← 1\n  E[1] ← [7; 8]\n  E', 'B := g[1]', 'B[1] + rows(g) ='])).toBe('10');
  });
});

describe('vectorize', () => {
  it('takes a call that gives an array (of no array argument) element by element', () => {
    // without vectorize the product of two vectors is their dot product
    expect(shown(['F(a) := [a; 2 a]', 'F(3)*F(3) ='])).toBe('45');
    expect(shown(['F(a) := [a; 2 a]', 'vectorize(F(3)*F(3)) ='])).toMatch(/^\\begin\{bmatrix\} 9 \\\\ 36 \\end\{bmatrix\}$/);
  });
  it('an array with a subscript is that element, beside the array taken element by element', () => {
    expect(shown(['A := [1; 2; 3]', 'vectorize(A*A[2]) ='])).toMatch(/^\\begin\{bmatrix\} 3 \\\\ 6 \\\\ 9 \\end\{bmatrix\}$/);
  });
});

describe('max and min', () => {
  it('over every element of every argument', () => {
    expect(shown(['max([1; 5], 3, [2, 7]) ='])).toBe('7');
    expect(shown(['min([4; 5], 3, [2, 7]) ='])).toBe('2');
  });
  it('a plain 0 among quantities is their zero', () => {
    expect(shown(['F := -2 kN', 'max(F, 0) = kN'])).toMatch(/^0\\ \\mathrm\{kN\}$/);
    expect(shown(['F := 2 kN', 'max(F, 0) = kN'])).toMatch(/^2\\ \\mathrm\{kN\}$/);
  });
});

describe('comparisons', () => {
  it('a quantity compares with a plain 0, and with no other number', () => {
    expect(shown(['F := 2 kN', 'if(F > 0, 1, 2) + if(F ≤ 0, 10, 20) ='])).toBe('21');
    expect(shown(['F := 2 kN', '(F == 0) + (0 < F) ='])).toBe('1');
    expect(() => shown(['F := 2 kN', 'F > 1 ='])).toThrow();
  });
  it('text equals text', () => {
    expect(shown(['s := "fixed"', 'if(s == "fixed", 1, 2) + if(s ≠ "pinned", 10, 20) ='])).toBe('11');
  });
  it('comparisons joined by logic on their own are a check of the whole condition', () => {
    const res = run(['a := 2', 'a > 1 ∧ a < 3', 'a > 1 ∧ a > 5']);
    expect((res[1] as MathResult).check).toEqual({ ok: true });
    expect((res[2] as MathResult).check).toEqual({ ok: false });
  });
});

describe('solve blocks that define a function', () => {
  it('a guess may use the function’s arguments: it is worked out at each call', () => {
    const block = createRegion('solve', 40, 0, { guesses: 'x := N/2', constraints: 'x^2 = N', solver: 'f(N) := find(x)' });
    expect(shown([block, 'f(16) + f(9) ='])).toBe('7');
    const units = createRegion('solve', 40, 0, { guesses: 's := A/(1 m)', constraints: 's^2 = A', solver: 'g(A) := find(s)' });
    expect(shown([units, 'g(4 m^2) = m'])).toMatch(/^2\\ \\mathrm\{m\}$/);
  });
});

describe('display units', () => {
  it('a unit short of some of the value’s units gets them, in SI', () => {
    expect(shown(['EI := 76 MN*m^2', 'EI = kN'])).toBe('76\\,000\\ \\mathrm{kN}\\cdot \\mathrm{m}^{2}');
  });
});

describe('lsolve', () => {
  it('solves a system with units in SI; each unknown takes its unit from an equation', () => {
    expect(shown(['K := [2 N/m, 0; 0, 4 N]', 'F := [4 N; 8 N*m]', 'lsolve(K, F) ='])).toBe('\\begin{bmatrix} 2 \\\\ 2 \\end{bmatrix}\\ \\mathrm{m}');
    expect(shown(['K := [2 N/m, 1 N; 0, 4 N*m]', 'F := [6 N; 8 N*m]', 'lsolve(K, F) ='])).toBe('\\begin{bmatrix} 2\\ \\mathrm{m} \\\\ 2 \\end{bmatrix}');
  });
});

describe('mod', () => {
  it('of two quantities of one kind is the remainder, in the unit of the first', () => {
    expect(shown(['mod(10 s, 3 s) ='])).toBe('1\\ \\mathrm{s}');
    expect(shown(['mod(250 mm, 0.1 m) = mm'])).toBe('50\\ \\mathrm{mm}');
  });
});
