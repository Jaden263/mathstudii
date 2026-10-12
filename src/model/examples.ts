import { createRegion, emptyWorksheet, PX_PER_MM, type Region, type Worksheet } from './types';

const L = Math.round(20 * PX_PER_MM);
const C2 = Math.round(110 * PX_PER_MM);

type Spec = [kind: Region['kind'], x: number, y: number, init: Partial<Region>];

function build(title: string, specs: Spec[]): Worksheet {
  const ws = emptyWorksheet();
  ws.title = title;
  ws.regions = specs.map(([kind, x, y, init]) => createRegion(kind, x, y, init));
  return ws;
}

const mm = (v: number) => Math.round(v * PX_PER_MM);

export function welcomeWorksheet(): Worksheet {
  return build('Welcome', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Welcome to mathstudii\nLive engineering math: type anywhere on the page, units are checked, results update as you type. Click any region to edit it, drag it to move it, or click empty space and start typing.' }],
    ['text', L, mm(38), { width: mm(80), markdown: '**Definitions** use `:=` (just type `:`).\n**Results** appear after `=`. Type a unit after `=` to convert.' }],
    ['math', C2, mm(40), { source: 'b := 300 mm' }],
    ['math', C2, mm(50), { source: 'h := 500 mm' }],
    ['math', C2, mm(60), { source: 'A := b * h' }],
    ['math', C2, mm(70), { source: 'A = cm^2' }],
    ['text', L, mm(85), { width: mm(170), markdown: '## Beam check\nSimply supported beam under a uniform load (the section above).' }],
    ['math', L, mm(102), { source: 'q := 25 kN/m' }],
    ['math', mm(70), mm(102), { source: 'L := 6 m' }],
    ['math', mm(120), mm(102), { source: 'E := 30 GPa' }],
    ['math', L, mm(114), { source: 'I := b * h^3 / 12' }],
    ['math', mm(120), mm(114), { source: 'I = cm^4' }],
    ['math', L, mm(128), { source: 'M_max := q * L^2 / 8' }],
    ['math', mm(120), mm(128), { source: 'M_max = kN*m' }],
    ['math', L, mm(144), { source: 'w(x) := q * x / (24 * E * I) * (L^3 - 2 * L * x^2 + x^3)' }],
    ['math', L, mm(158), { source: 'w(L / 2) = mm' }],
    ['math', mm(120), mm(158), { source: 'σ := M_max * (h / 2) / I =  MPa' }],
    ['text', L, mm(172), { width: mm(170), markdown: 'Midspan deflection is {{w(L/2) | mm}}, i.e. L/{{round(L / w(L/2))}}. Text can show live values with `{{expr | unit}}`.' }],
    ['plot', L, mm(186), { xExpr: 'x', traces: [{ y: '-w(x)', style: 'line' }], xmin: '0 m', xmax: 'L', yUnit: 'mm', xUnit: 'm', title: 'Deflection', width: mm(110), height: mm(62) }],
    ['text', mm(140), mm(186), { width: mm(55), markdown: '**QuickPlot**: `x` is undefined, so it is sampled between the limits.\n\nOpen **Examples** in the toolbar for solve blocks, programming, symbolics and 3-D plots.' }],
  ]);
}

export function solvingExample(): Worksheet {
  return build('Solving', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Solving\nSolve blocks take guess values, constraints and a solver call — exactly like Mathcad. Units work throughout.' }],
    ['solve', L, mm(42), { guesses: 'x := 1\ny := 1', constraints: 'x^2 + y^2 = 25\ny = x + 1', solver: 'sol := find(x, y)' }],
    ['math', mm(110), mm(48), { source: 'sol =' }],
    ['text', L, mm(100), { width: mm(170), markdown: '## Bolt sizing\nFind the diameter so that the shear stress equals the allowable stress.' }],
    ['math', L, mm(118), { source: 'V := 45 kN' }],
    ['math', mm(75), mm(118), { source: 'τ_allow := 160 MPa' }],
    ['solve', L, mm(130), { guesses: 'd := 10 mm', constraints: 'V / (π d^2 / 4) = τ_allow', solver: 'd_req := find(d) = mm' }],
    ['text', L, mm(182), { width: mm(170), markdown: '## Roots, polynomials and linear algebra' }],
    ['math', L, mm(194), { source: 'f(t) := cos(t) - t' }],
    ['math', mm(80), mm(194), { source: 'root(f(t), t, 0, 1) =' }],
    ['math', L, mm(208), { source: 'polyroots([-6, 11, -6, 1]) =' }],
    ['math', mm(90), mm(208), { source: 'A := [4, -2; 1, 1]' }],
    ['math', mm(140), mm(208), { source: 'eigenvals(A) =' }],
    ['math', L, mm(236), { source: 'M := [3, 2, -1; 2, -2, 4; -1, 0.5, -1]' }],
    ['math', mm(110), mm(236), { source: 'lsolve(M, [1; -2; 0]) =' }],
    ['text', L, mm(264), { width: mm(170), markdown: '## Optimisation\nMinimise a cost subject to a constraint.' }],
    ['math', L, mm(282), { source: 'cost(w, h) := 2 * w + 3 * h' }],
    ['solve', L, mm(294), { guesses: 'w := 1\nh := 1', constraints: 'w * h >= 24\nw >= 0\nh >= 0', solver: '[w_o; h_o] := minimize(cost, w, h)' }],
    ['math', mm(130), mm(300), { source: 'w_o =' }],
    ['math', mm(130), mm(312), { source: 'h_o =' }],
    ['math', mm(130), mm(324), { source: 'cost(w_o, h_o) =' }],
  ]);
}

export function programmingExample(): Worksheet {
  return build('Programming', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Programming\nEnd a definition with `:=` and write the body indented underneath (Shift+Enter for a new line). Use `←` (or `<-`) for local variables.' }],
    ['math', L, mm(44), { source: 'fact(n) :=\n  r ← 1\n  for k ∈ 1 .. n\n    r ← r · k\n  return r' }],
    ['math', mm(110), mm(48), { source: 'fact(10) =' }],
    ['math', L, mm(80), { source: 'collatz(n) :=\n  steps ← 0\n  while n ≠ 1\n    if mod(n, 2) == 0\n      n ← n / 2\n    else\n      n ← 3 n + 1\n    steps ← steps + 1\n  steps' }],
    ['math', mm(110), mm(84), { source: 'collatz(27) =' }],
    ['math', L, mm(136), { source: 'primes(N) :=\n  k ← 0\n  for n ∈ 2 .. N\n    if isPrime(n)\n      p[k] ← n\n      k ← k + 1\n  p' }],
    ['math', mm(90), mm(140), { source: "primes(30)' =" }],
    ['text', L, mm(180), { width: mm(170), markdown: '## Range variables\nA range iterates every expression it appears in — the Mathcad way to build tables.' }],
    ['math', L, mm(198), { source: 'i := 0 .. 6' }],
    ['math', mm(60), mm(198), { source: 'x[i] := i / 2' }],
    ['math', mm(110), mm(198), { source: 'y[i] := x[i]^2' }],
    ['math', L, mm(212), { source: 'x =' }],
    ['math', mm(60), mm(212), { source: 'y =' }],
    ['plot', mm(110), mm(212), { xExpr: 'x', traces: [{ y: 'y', style: 'both' }], width: mm(80), height: mm(60), title: 'y vs x' }],
  ]);
}

export function symbolicExample(): Worksheet {
  const rows = [
    'diff(sin(x) * x^2, x) →',
    'integral(x^2 * exp(-x), x, 0, ∞) →',
    'integrate(1 / (1 + x^2), x) →',
    'x^3 - 6 x^2 + 11 x - 6 → factor',
    '(a + b)^4 → expand',
    'a x^2 + b x + c = 0 → solve, x',
    'exp(x) * cos(x) → series, x, 5',
    'sin(ω t) → laplace, t, s',
    '1 / (s (s + 1)) → invlaplace, s, t',
    'limit(sin(x) / x, x, 0) →',
    '1 / (x^2 - 1) → partfrac, x',
  ];
  return build('Symbolics', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Symbolic math\nUse `→` (Ctrl+.) to evaluate symbolically, optionally with a keyword: `factor`, `expand`, `solve, x`, `series, x, 6`, `laplace, t, s`…' }],
    ...rows.map((source, k): Spec => ['math', L, mm(44 + k * 15), { source }]),
  ]);
}

export function plottingExample(): Worksheet {
  return build('Plots', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Plots\nX-Y, polar, 3-D surface and contour plots. Click a plot and use the **Properties** panel to edit traces and axes.' }],
    ['math', L, mm(42), { source: 'f(x) := sin(x) / x' }],
    ['plot', L, mm(56), { xExpr: 'x', traces: [{ y: 'f(x)', style: 'line' }, { y: 'cos(x) / 2', style: 'line' }], xmin: '-15', xmax: '15', width: mm(82), height: mm(60), title: 'QuickPlot' }],
    ['math', mm(112), mm(42), { source: 'θ := 0, 0.01 .. 2 π' }],
    ['plot', mm(112), mm(56), { plotType: 'polar', xExpr: 'θ', traces: [{ y: '1 + cos(4 θ)', style: 'line' }], width: mm(70), height: mm(62), title: 'Rose' }],
    ['plot', L, mm(126), { plotType: 'surface', z: 'sin(sqrt(x^2 + y^2)) / sqrt(x^2 + y^2 + 0.01)', xmin: '-8', xmax: '8', ymin: '-8', ymax: '8', width: mm(82), height: mm(70), title: 'Surface' }],
    ['plot', mm(112), mm(126), { plotType: 'contour', z: 'x^2 - y^2', width: mm(76), height: mm(70), title: 'Contour' }],
    ['math', L, mm(206), { source: 'data := [0, 0.8; 1, 2.9; 2, 5.2; 3, 6.8; 4, 9.1; 5, 11.2]' }],
    ['math', L, mm(250), { source: 'c := polyfit(col(data, 0), col(data, 1), 1) =' }],
    ['plot', mm(112), mm(254), { xExpr: 'col(data, 0)', traces: [{ y: 'col(data, 1)', style: 'points' }, { xExpr: 't', y: 'polyval(c, t)', style: 'line' }], xmin: '0', xmax: '5', width: mm(76), height: mm(56), title: 'Linear fit' }],
  ]);
}

export const EXAMPLES: { name: string; make: () => Worksheet }[] = [
  { name: 'Welcome & beam check', make: welcomeWorksheet },
  { name: 'Solving & optimisation', make: solvingExample },
  { name: 'Programming & ranges', make: programmingExample },
  { name: 'Symbolic math', make: symbolicExample },
  { name: 'Plots', make: plottingExample },
];
