import { describe, it, expect, beforeAll } from 'vitest';
import katex from 'katex';
import { evaluateWorksheet, type MathResult, type SolveResult, type PlotResult, type TextResult, type SketchResult } from './evaluator';
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

function run(lines: (string | Region)[], settings?: Partial<Worksheet['settings']>) {
  const ws = sheet(lines, settings);
  const out = evaluateWorksheet(ws);
  // every produced TeX string must be valid KaTeX
  for (const r of out.results.values()) {
    const texs: string[] = [];
    if (r.kind === 'math') texs.push(r.tex);
    if (r.kind === 'solve') texs.push(...r.guesses.map((g) => g.tex), ...r.constraints.map((c) => c.tex), r.solver.tex);
    if (r.kind === 'text') Object.values(r.values).forEach((v) => v.tex && texs.push(v.tex));
    for (const t of texs) expect(() => katex.renderToString(t, { throwOnError: true }), t).not.toThrow();
  }
  return ws.regions.map((r) => out.results.get(r.id)!);
}

/** Last region's TeX after the final "=" (the displayed result). */
function result(lines: string[], settings?: Partial<Worksheet['settings']>): string {
  const res = run(lines, settings);
  const last = res[res.length - 1] as MathResult;
  if (last.error) throw new Error(last.error);
  const i = last.tex.lastIndexOf(' = ');
  return last.tex.slice(i + 3);
}

function error(lines: string[]): string | undefined {
  const res = run(lines);
  return (res[res.length - 1] as MathResult).error;
}

describe('basic evaluation', () => {
  it('defines and evaluates', () => {
    expect(result(['x := 3', 'y := x^2 + 1', 'y ='])).toBe('10');
  });
  it('respects precision and strips zeros', () => {
    expect(result(['1/3 ='])).toBe('0.3333');
    expect(result(['1/3 ='], { precision: 2 })).toBe('0.33');
    expect(result(['2.5 ='])).toBe('2.5');
  });
  it('uses scientific notation past the threshold', () => {
    expect(result(['123456789 ='])).toBe('1.2346 \\cdot 10^{8}');
    expect(result(['0.000001234 ='])).toBe('1.234 \\cdot 10^{-6}');
  });
  it('groups digits', () => {
    expect(result(['12345 ='])).toBe('12\\,345');
  });
  it('reports undefined variables', () => {
    expect(error(['z + 1 ='])).toBe('"z" is not defined');
  });
  it('evaluates in reading order', () => {
    const ws = emptyWorksheet();
    const a = createRegion('math', 300, 40, { source: 'b := a + 1' });
    const b = createRegion('math', 40, 40, { source: 'a := 1' });
    const c = createRegion('math', 40, 120, { source: 'b =' });
    ws.regions = [a, b, c];
    const out = evaluateWorksheet(ws);
    expect((out.results.get(c.id) as MathResult).tex).toContain('= 2');
  });
  it('evaluates global definitions first', () => {
    expect(result(['y := k * 2', 'k ≡ 21', 'y ='])).toBe('42');
  });
  it('supports define-and-show', () => {
    const r = run(['x := 2 * 3 ='])[0] as MathResult;
    expect(r.tex).toContain('= 6');
  });
  it('handles complex numbers and imaginary literals', () => {
    expect(result(['sqrt(-4) ='])).toBe('2\\,i');
    expect(result(['(1 + 2i) * (3 - 1i) ='])).toBe('5 + 5\\,i');
    expect(result(['i := 5', 'i + 1i ='])).toBe('5 + i');
  });
  it('uses Mathcad log/ln', () => {
    expect(result(['log(1000) ='])).toBe('3');
    expect(result(['ln(e) ='])).toBe('1');
    expect(result(['log(8, 2) ='])).toBe('3');
  });
  it('has Mathcad gravity constant', () => {
    expect(result(['g ='])).toContain('9.8066');
  });
});

describe('units', () => {
  it('computes with units and picks derived units', () => {
    expect(result(['F := 10 kg * 9.81 m/s^2', 'F ='])).toBe('98.1\\ \\mathrm{N}');
  });
  it('converts to a requested unit', () => {
    expect(result(['L := 2 m + 30 cm', 'L = mm'])).toBe('2300\\ \\mathrm{mm}');
  });
  it('flags unit mismatches', () => {
    expect(error(['1 m + 1 s ='])).toMatch(/Units do not match/);
  });
  it('converts pressure', () => {
    expect(result(['p := 1 atm', 'p = kPa'])).toBe('101.325\\ \\mathrm{kPa}');
  });
  it('supports gm for gram (g is gravity)', () => {
    expect(result(['m := 500 gm', 'm = kg'])).toBe('0.5\\ \\mathrm{kg}');
  });
  it('shows dimensionless results in angle units and percent', () => {
    expect(result(['asin(0.5) = deg'])).toBe('30\\ {}^{\\circ}');
    expect(result(['0.125 = %'])).toBe('12.5\\,\\%');
  });
  it('rejects invalid result units', () => {
    expect(error(['2 = )'])).toMatch(/not a unit/);
    expect(error(['2 = m'])).toMatch(/Units do not match/);
  });
  it('degree symbol', () => {
    expect(result(['sin(30°) ='])).toBe('0.5');
  });
});

describe('functions and ranges', () => {
  it('defines user functions', () => {
    expect(result(['f(x) := x^2 + 1', 'f(3) ='])).toBe('10');
  });
  it('captures values at definition time (Mathcad semantics)', () => {
    expect(result(['a := 1', 'f(x) := a * x', 'a := 100', 'f(2) ='])).toBe('2');
  });
  it('supports recursion', () => {
    expect(result(['fib(n) := if(n < 2, n, fib(n - 1) + fib(n - 2))', 'fib(15) ='])).toBe('610');
  });
  it('iterates over range variables', () => {
    const r = result(['i := 0 .. 3', 'i^2 =']);
    expect(r).toContain('\\begin{bmatrix} 0 \\\\ 1 \\\\ 4 \\\\ 9 \\end{bmatrix}');
  });
  it('supports stepped ranges', () => {
    const r = result(['t := 0, 0.5 .. 2', 't =']);
    expect(r).toContain('0 \\\\ 0.5 \\\\ 1 \\\\ 1.5 \\\\ 2');
  });
  it('defines vector elements over a range with ORIGIN 0', () => {
    expect(result(['i := 0 .. 4', 'v[i] := i^2', 'v[3] ='])).toBe('9');
    expect(result(['i := 0 .. 4', 'v[i] := i^2', 'length(v) ='])).toBe('5');
  });
  it('honours ORIGIN = 1', () => {
    expect(result(['v := [10; 20; 30]', 'v[1] ='], { origin: 1 })).toBe('10');
    expect(result(['v := [10; 20; 30]', 'v[1] ='])).toBe('20');
  });
  it('sums', () => {
    expect(result(['sum(k^2, k, 1, 10) ='])).toBe('385');
    expect(result(['sum([1, 2, 3]) ='])).toBe('6');
    expect(result(['prod(k, k, 1, 5) ='])).toBe('120');
  });
});

describe('matrices', () => {
  it('multiplies and inverts', () => {
    expect(result(['A := [2, 0; 0, 4]', 'A^-1 ='])).toBe('\\begin{bmatrix} 0.5 & 0 \\\\ 0 & 0.25 \\end{bmatrix}');
    expect(result(['A := [1, 2; 3, 4]', 'det(A) ='])).toBe('-2');
  });
  it('indexes matrices', () => {
    expect(result(['M := [1, 2; 3, 4]', 'M[1, 0] ='])).toBe('3');
  });
  it('solves linear systems', () => {
    expect(result(['A := [2, 1; 1, 3]', 'b := [3; 5]', 'lsolve(A, b) ='])).toBe('\\begin{bmatrix} 0.8 \\\\ 1.4 \\end{bmatrix}');
  });
  it('transposes vectors into rows', () => {
    expect(result(['v := [1; 2; 3]', "v' ="])).toBe('\\begin{bmatrix} 1 & 2 & 3 \\end{bmatrix}');
  });
  it('augment, stack, rows, cols', () => {
    expect(result(['augment([1; 2], [3; 4]) ='])).toBe('\\begin{bmatrix} 1 & 3 \\\\ 2 & 4 \\end{bmatrix}');
    expect(result(['rows(stack([1, 2], [3, 4], [5, 6])) ='])).toBe('3');
  });
  it('factors a common unit out of a matrix', () => {
    expect(result(['v := [1; 2] * m', 'v ='])).toBe('\\begin{bmatrix} 1 \\\\ 2 \\end{bmatrix}\\ \\mathrm{m}');
  });
  it('eigenvalues', () => {
    expect(result(['eigenvals([2, 0; 0, 3]) ='])).toBe('\\begin{bmatrix} 2 \\\\ 3 \\end{bmatrix}');
  });
});

describe('calculus and solving', () => {
  it('integrates numerically', () => {
    expect(result(['integral(x^2, x, 0, 3) ='])).toBe('9');
    expect(result(['integral(exp(-x^2), x, -Infinity, Infinity) ='])).toBe('1.7725');
  });
  it('integrates with units', () => {
    expect(result(['integral(5 N, x, 0 m, 2 m) ='])).toBe('10\\ \\mathrm{J}');
  });
  it('differentiates numerically at the current value', () => {
    expect(result(['x := 2', 'diff(x^3, x) ='])).toBe('12');
    expect(result(['x := 2', 'diff(x^3, x, 2) ='])).toBe('12');
  });
  it('finds roots', () => {
    expect(result(['x := 1', 'root(x^2 - 2, x) ='])).toBe('1.4142');
    expect(result(['root(cos(x) - x, x, 0, 1) ='])).toBe('0.7391');
  });
  it('finds polynomial roots', () => {
    expect(result(['polyroots([-6, 11, -6, 1]) ='])).toBe('\\begin{bmatrix} 1 \\\\ 2 \\\\ 3 \\end{bmatrix}');
  });
  it('solves a solve block', () => {
    const blk = createRegion('solve', 40, 0, {
      guesses: 'x := 1\ny := 1',
      constraints: 'x^2 + y^2 = 4\ny = x',
      solver: 's := find(x, y)',
    });
    const res = run([blk, 's =']);
    expect((res[0] as SolveResult).solver.error).toBeUndefined();
    expect((res[1] as MathResult).tex).toContain('1.4142 \\\\ 1.4142');
  });
  it('solves with units', () => {
    const blk = createRegion('solve', 40, 0, {
      guesses: 'd := 10 mm',
      constraints: 'pi * d^2 / 4 * 200 MPa = 50 kN',
      solver: 'd_req := find(d)',
    });
    const res = run([blk, 'd_req = mm']);
    expect((res[1] as MathResult).tex).toContain('17.8412\\ \\mathrm{mm}');
  });
  it('reports no solution', () => {
    const blk = createRegion('solve', 40, 0, { guesses: 'x := 1', constraints: 'x^2 = -1', solver: 'r := find(x)' });
    const res = run([blk]);
    expect((res[0] as SolveResult).solver.error).toMatch(/No solution/);
  });
  it('minimizes with constraints', () => {
    const blk = createRegion('solve', 40, 0, {
      guesses: 'x := 1',
      constraints: 'x >= 2',
      solver: 'xm := minimize(f, x)',
    });
    const res = run(['f(x) := (x - 1)^2', blk, 'xm =']);
    expect((res[2] as MathResult).tex).toMatch(/= 2(\.0+)?$|= 1\.9999|= 2$/);
  });
  it('solves ODEs with rkfixed', () => {
    const r = result(['D(t, y) := [-y[0]]', 'S := rkfixed([1], 0, 1, 10, D)', 'S[10, 1] =']);
    expect(r).toBe('0.3679');
  });
  it('interpolates and fits', () => {
    expect(result(['vx := [0; 1; 2]', 'vy := [0; 10; 20]', 'linterp(vx, vy, 1.5) ='])).toBe('15');
    expect(result(['vx := [0; 1; 2; 3]', 'vy := [1; 3; 5; 7]', 'slope(vx, vy) ='])).toBe('2');
  });
  it('statistics', () => {
    expect(result(['mean([1, 2, 3, 4]) ='])).toBe('2.5');
    expect(result(['stdev([2, 4, 4, 4, 5, 5, 7, 9]) ='])).toBe('2');
    expect(result(['pnorm(1.96, 0, 1) ='])).toBe('0.975');
    expect(result(['qnorm(0.975, 0, 1) ='])).toBe('1.96');
  });
});

describe('programs', () => {
  it('runs loops and returns', () => {
    expect(result(['fact(n) :=\n  r ← 1\n  for k ∈ 1 .. n\n    r ← r * k\n  return r', 'fact(6) ='])).toBe('720');
  });
  it('supports while, if/else and break', () => {
    const prog = 'collatz(n) :=\n  c <- 0\n  while n != 1\n    if mod(n, 2) == 0\n      n <- n / 2\n    else\n      n <- 3 n + 1\n    c <- c + 1\n  c';
    expect(result([prog, 'collatz(27) ='])).toBe('111');
  });
  it('builds vectors with indexed assignment', () => {
    expect(result(['sq :=\n  for k in 0 .. 4\n    v[k] <- k^2\n  v', 'sq[4] ='])).toBe('16');
  });
  it('stops infinite loops', () => {
    expect(error(['x :=\n  while 1\n    k <- 1\n  k'])).toMatch(/aborted/);
  }, 30000);
  it('try / on error', () => {
    expect(result(['safe(x) :=\n  try\n    return 1/x + undefinedthing\n  on error\n    return -1', 'safe(0) ='])).toBe('-1');
  });
});

describe('symbolic', () => {
  beforeAll(async () => {
    await loadCas();
  });
  it('differentiates and integrates', () => {
    const r = run(['diff(x^3, x) →'])[0] as MathResult;
    expect(r.error).toBeUndefined();
    expect(r.tex).toMatch(/3.*x\^\{2\}/);
    const i = run(['integral(x^2, x, 0, 1) →'])[0] as MathResult;
    expect(i.tex).toContain('\\frac{1}{3}');
  });
  it('factors and solves with keywords', () => {
    expect((run(['x^2 - 1 → factor'])[0] as MathResult).tex).toMatch(/x\+1|x-1/);
    expect((run(['x^2 = 4 → solve, x'])[0] as MathResult).tex).toMatch(/2.*-2|-2.*2/);
  });
  it('substitutes defined values and functions', () => {
    const r = run(['a := 3', 'f(t) := t^2 + a', 'f(y) → expand']);
    expect((r[2] as MathResult).tex).toMatch(/y\^\{2\}\+3/);
  });
  it('handles improper integrals, Greek names and implicit products', () => {
    expect((run(['integral(x^2 * exp(-x), x, 0, ∞) →'])[0] as MathResult).tex).toMatch(/\\rightarrow 2$/);
    const lap = run(['sin(ω t) → laplace, t, s'])[0] as MathResult;
    expect(lap.error).toBeUndefined();
    expect(lap.tex).toContain('omega');
    const ilt = run(['1 / (s (s + 1)) → invlaplace, s, t'])[0] as MathResult;
    expect(ilt.error).toBeUndefined();
    expect(ilt.tex).toMatch(/e\^\{t\}|e\^\{-t\}/);
  });
  it('series expansion', () => {
    const r = run(['exp(x) → series, x, 4'])[0] as MathResult;
    expect(r.error).toBeUndefined();
    expect(r.tex).toMatch(/x\^\{3\}/);
  });
});

describe('display and semantics', () => {
  it('multiplies when a value is followed by parentheses', () => {
    expect(result(['s := 2', 's (s + 1) ='])).toBe('6');
  });
  it('renders row and column vector literals', () => {
    const r = run(['v := [1, 2, 3]', 'w := [1; 2]']) as MathResult[];
    expect(r[0].tex).toContain('\\begin{bmatrix} 1 & 2 & 3 \\end{bmatrix}');
    expect(r[1].tex).toContain('\\begin{bmatrix} 1 \\\\ 2 \\end{bmatrix}');
  });
  it('renders infinity', () => {
    expect((run(['integral(exp(-x), x, 0, ∞) ='])[0] as MathResult).tex).toContain('\\infty');
  });
});

describe('plots, tables and text', () => {
  it('reports a trace that fails everywhere', () => {
    const p = createRegion('plot', 40, 0, { xExpr: 't', traces: [{ y: 'undefinedFn(t) + q', style: 'line' }] });
    const pr = run([p])[0] as PlotResult;
    expect(pr.error).toMatch(/not defined/);
  });
  it('quick-plots an undefined variable', () => {
    const p = createRegion('plot', 40, 0, { xExpr: 'x', traces: [{ y: 'x^2', style: 'line' }] });
    const res = run([p]);
    const pr = res[0] as PlotResult;
    expect(pr.error).toBeUndefined();
    expect(pr.series[0].xs.length).toBe(601);
    expect(pr.series[0].ys[0]).toBe(100);
  });
  it('plots over a range variable with units', () => {
    const p = createRegion('plot', 40, 0, { xExpr: 't', traces: [{ y: 'v0 * t', style: 'line' }] });
    const res = run(['v0 := 2 m/s', 't := 0 s, 1 s .. 4 s', p]);
    const pr = res[2] as PlotResult;
    expect(pr.error).toBeUndefined();
    expect(pr.series[0].ys).toEqual([0, 2, 4, 6, 8]);
    expect(pr.yLabel).toContain('[m]');
  });
  it('defines variables from tables', () => {
    const t = createRegion('table', 40, 0, { name: 'D', units: ['m', 'N'], cells: [['1', '10'], ['2', '20']] });
    expect((run([t, 'D[1, 1] = N'])[1] as MathResult).tex).toContain('20\\ \\mathrm{N}');
  });
  it('fills live values into text', () => {
    const t = createRegion('text', 40, 0, { markdown: 'Force is {{F | kN}}.' });
    const res = run(['F := 2500 N', t]);
    expect((res[1] as TextResult).values['F | kN'].tex).toBe('2.5\\ \\mathrm{kN}');
  });
});

describe('sketches', () => {
  const ibeam = () =>
    createRegion('sketch', 40, 0, {
      name: 'sec',
      shapes: [{ id: 'i1', type: 'section', template: 'I', p: { x: 0, y: 0 }, rot: 0, params: { h: 'h_b', b: '150 mm', tw: '7.1', tf: 'tf' } }],
    });

  it('computes section properties from a parametric template', () => {
    const res = run(['h_b := 30 cm', 'tf := 10.7 mm', ibeam(), 'sec.A = cm^2', 'sec.Ix = cm^4', 'sec.Wx = cm^3']);
    const A = 2 * 150 * 10.7 + (300 - 21.4) * 7.1;
    const Ix = (150 * 300 ** 3 - (150 - 7.1) * (300 - 21.4) ** 3) / 12;
    expect((res[3] as MathResult).tex).toContain(`${(A / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}\\ \\mathrm{cm}^{2}`);
    expect((res[4] as MathResult).tex).toContain(`${(Ix / 1e4).toFixed(4).replace(/0+$/, '')}\\ \\mathrm{cm}^{4}`);
    expect((res[5] as MathResult).error).toBeUndefined();
    expect((res[3] as MathResult).tex).toMatch(/^\{\\mathit\{sec\}\}\.\{A\}/);
  });

  it('shows the whole property record', () => {
    const res = run(['h_b := 300 mm', 'tf := 10.7 mm', ibeam(), 'sec =']);
    expect((res[3] as MathResult).tex).toContain('\\mathrm{Ix}');
  });

  it('resolves bound points (kinematic sketch)', () => {
    const sk = createRegion('sketch', 40, 0, {
      shapes: [{ id: 'l1', type: 'link', a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, bind: { 'b.x': 'r * cos(θ)', 'b.y': 'r * sin(θ)' } }],
    });
    const res = run(['r := 0.1 m', 'θ := 30 deg', sk]);
    const sr = res[2] as SketchResult;
    expect(sr.errors).toEqual({});
    expect(sr.resolved.l1['b.x']).toBeCloseTo(100 * Math.cos(Math.PI / 6), 9);
    expect(sr.resolved.l1['b.y']).toBeCloseTo(50, 9);
  });

  it('reports unit errors on bound fields and bad templates', () => {
    const sk = createRegion('sketch', 40, 0, {
      shapes: [
        { id: 'l1', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, bind: { 'b.x': '5 kg' } },
        { id: 's1', type: 'section', template: 'tube', p: { x: 0, y: 0 }, rot: 0, params: { d: '10', t: '6' } },
      ],
    });
    const sr = run([sk])[0] as SketchResult;
    expect(sr.errors.l1).toMatch(/length/);
    expect(sr.errors.s1).toMatch(/wall/);
  });

  it('subtracts holes drawn with ordinary shapes', () => {
    const sk = createRegion('sketch', 40, 0, {
      name: 'P',
      shapes: [
        { id: 'r', type: 'rect', role: 'solid', a: { x: 0, y: 0 }, b: { x: 100, y: 50 } },
        { id: 'c', type: 'circle', role: 'hole', c: { x: 50, y: 25 }, r: 10 },
      ],
    });
    const res = run([sk, 'P.A = mm^2']);
    expect((res[1] as MathResult).tex).toContain(`${(5000 - Math.PI * 100).toFixed(4)}`.slice(0, 7));
  });
});

describe('bundled examples', () => {
  beforeAll(async () => {
    await loadCas();
  });
  it('evaluate without errors', async () => {
    const { EXAMPLES } = await import('../model/examples');
    for (const ex of EXAMPLES) {
      const ws = ex.make();
      const out = evaluateWorksheet(ws);
      const errors = [...out.results.entries()].flatMap(([id, r]) => {
        const msgs: string[] = [];
        if ('error' in r && r.error) msgs.push(r.error);
        if (r.kind === 'solve') [r.solver, ...r.guesses, ...r.constraints].forEach((x) => x.error && msgs.push(x.error));
        if (r.kind === 'sketch') msgs.push(...Object.values(r.errors));
        const reg = ws.regions.find((q) => q.id === id)!;
        return msgs.map((m) => `${ex.name} / ${reg.kind === 'math' ? reg.source : reg.kind}: ${m}`);
      });
      expect(errors).toEqual([]);
    }
  });
});
