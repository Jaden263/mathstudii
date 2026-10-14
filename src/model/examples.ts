import { createRegion, emptyWorksheet, PX_PER_MM, type Region, type Worksheet } from './types';
import type { CadConstraint, CadEntity, CadSketch } from '../cad/model';

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

export function sectionExample(): Worksheet {
  return build('Cross-sections', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Cross-sections\nA **Sketch** named `sec` turns its closed shapes into section properties. Dimensions are worksheet variables, so change `t_p` and everything updates.' }],
    ['math', L, mm(38), { source: 'h_I := 300 mm' }],
    ['math', mm(65), mm(38), { source: 'b_p := 200 mm' }],
    ['math', mm(110), mm(38), { source: 't_p := 15 mm' }],
    ['sketch', L, mm(52), {
      name: 'sec', width: mm(82), height: mm(82), view: { cx: 0, cy: 7.5, zoom: 0.85 }, grid: 10,
      shapes: [
        { id: 'beam', type: 'section', template: 'I', p: { x: 0, y: 0 }, rot: 0, params: { h: 'h_I', b: '150', tw: '7.1', tf: '10.7' }, role: 'solid' },
        { id: 'plate', type: 'section', template: 'rect', p: { x: 0, y: 157.5 }, rot: 0, params: { b: 'b_p', h: 't_p' }, role: 'solid', bind: { 'p.y': 'h_I/2 + t_p/2' } },
        { id: 'dim1', type: 'dim', a: { x: -100, y: -150 }, b: { x: -100, y: 165 }, offset: 10, text: 'h', bind: { 'b.y': 'h_I/2 + t_p' } },
      ],
    }],
    ['math', mm(110), mm(56), { source: 'sec.A = cm^2' }],
    ['math', mm(110), mm(68), { source: 'sec.yc = mm' }],
    ['math', mm(110), mm(80), { source: 'sec.Ix = cm^4' }],
    ['math', mm(110), mm(92), { source: 'sec.Wx = cm^3' }],
    ['math', mm(110), mm(108), { source: 'M_Ed := 140 kN m' }],
    ['math', mm(110), mm(120), { source: 'σ := M_Ed / sec.Wx = MPa' }],
    ['math', mm(110), mm(132), { source: 'σ ≤ 235 MPa =' }],
    ['text', L, mm(150), { width: mm(170), markdown: '## Beam diagram\nSketches also draw supports, loads and dimensions.' }],
    ['sketch', L, mm(166), {
      width: mm(170), height: mm(45), view: { cx: 3000, cy: 300, zoom: 0.075 }, grid: 250, showProps: false,
      shapes: [
        { id: 'bm', type: 'line', a: { x: 0, y: 0 }, b: { x: 6000, y: 0 }, style: { width: 3 } },
        { id: 'pin', type: 'symbol', symbol: 'pin', p: { x: 0, y: 0 }, rot: 0, size: 200 },
        { id: 'roll', type: 'symbol', symbol: 'roller', p: { x: 6000, y: 0 }, rot: 0, size: 200 },
        { id: 'q', type: 'symbol', symbol: 'load', p: { x: 0, y: 60 }, rot: 0, size: 1500 },
        { id: 'qt', type: 'text', p: { x: 2550, y: 820 }, text: 'q = 25 kN/m', size: 190 },
        { id: 'dl', type: 'dim', a: { x: 0, y: 0 }, b: { x: 6000, y: 0 }, offset: -380, text: 'L = 6 m' },
      ],
    }],
  ]);
}

export function mechanismExample(): Worksheet {
  return build('Mechanism', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Crank-slider mechanism\nThe sketch points are bound to the expressions below. Press ▶ on the sketch to sweep θ, or change θ by hand.' }],
    ['math', L, mm(36), { source: 'r := 50 mm' }],
    ['math', mm(60), mm(36), { source: 'l := 150 mm' }],
    ['math', mm(110), mm(36), { source: 'θ := 40 deg' }],
    ['math', L, mm(48), { source: 'x_C(φ) := r cos(φ) + sqrt(l^2 - (r sin(φ))^2)' }],
    ['sketch', L, mm(62), {
      width: mm(140), height: mm(60), view: { cx: 85, cy: 5, zoom: 1.65 }, grid: 10, showProps: false,
      animation: { variable: 'θ', from: '0 deg', to: '360 deg', seconds: 3 },
      shapes: [
        { id: 'rail', type: 'line', a: { x: 60, y: -14 }, b: { x: 230, y: -14 }, style: { dash: 'center', width: 1 } },
        { id: 'crank', type: 'link', a: { x: 0, y: 0 }, b: { x: 38, y: 32 }, bind: { 'b.x': 'r cos(θ)', 'b.y': 'r sin(θ)' }, style: { stroke: '#2f6fdf' } },
        { id: 'rod', type: 'link', a: { x: 38, y: 32 }, b: { x: 180, y: 0 }, bind: { 'a.x': 'r cos(θ)', 'a.y': 'r sin(θ)', 'b.x': 'x_C(θ)' }, style: { stroke: '#e8590c' } },
        { id: 'O', type: 'symbol', symbol: 'pin', p: { x: 0, y: 0 }, rot: 0, size: 14 },
        { id: 'C', type: 'symbol', symbol: 'slider', p: { x: 180, y: 0 }, rot: 0, size: 14, bind: { 'p.x': 'x_C(θ)' } },
        { id: 'tO', type: 'text', p: { x: -12, y: -32 }, text: 'O', size: 9 },
        { id: 'tC', type: 'text', p: { x: 175, y: 14 }, text: 'C', size: 9, bind: { 'p.x': 'x_C(θ) - 4 mm' } },
      ],
    }],
    ['math', L, mm(128), { source: 'x_C(θ) = mm' }],
    ['math', mm(70), mm(128), { source: 'v_C := diff(x_C(θ), θ) · 120 rpm = m/s' }],
    ['text', L, mm(142), { width: mm(170), markdown: 'Slider position over one revolution (QuickPlot of the same function the sketch uses):' }],
    ['plot', L, mm(152), { xExpr: 'φ', traces: [{ y: 'x_C(φ)', style: 'line' }], xmin: '0', xmax: '2 π', yUnit: 'mm', width: mm(110), height: mm(60), title: 'x_C(φ)' }],
  ]);
}

/** A closed polyline of lines through the given points (ids p0, p1, …), plus its constraints. */
function outline(prefix: string, pts: [number, number][]): CadSketch {
  const points = pts.map(([x, y], i) => ({ id: `${prefix}p${i}`, x, y }));
  const entities: CadEntity[] = points.map((p, i) => ({ id: `${prefix}l${i}`, type: 'line', p1: p.id, p2: points[(i + 1) % points.length].id }));
  return { points, entities, constraints: [] };
}

export function cadExample(): Worksheet {
  // stepped shaft: half profile above the x axis, revolved about it
  const shaft = outline('s', [[0, 0], [0, 20], [60, 20], [60, 25], [180, 25], [180, 0]]);
  const hv = (i: number, t: 'horizontal' | 'vertical') => ({ id: `sk${t}${i}`, type: t, refs: [`sl${i}`] }) as CadConstraint;
  shaft.constraints.push(
    { id: 'sfix', type: 'fix', refs: ['sp0'], at: { x: 0, y: 0 } },
    hv(0, 'vertical'), hv(1, 'horizontal'), hv(2, 'vertical'), hv(3, 'horizontal'), hv(4, 'vertical'), hv(5, 'horizontal'),
    { id: 'sd1', type: 'distanceY', refs: ['sp0', 'sp1'], value: 'd/2', name: 'r1', offset: { x: -24, y: 0 } },
    { id: 'sd2', type: 'distanceY', refs: ['sp5', 'sp4'], value: 'd_2/2', name: 'r2', offset: { x: -16, y: 0 } },
    { id: 'sd3', type: 'distanceX', refs: ['sp1', 'sp2'], value: '60 mm', name: 'a', offset: { x: 0, y: 4 } },
    { id: 'sd4', type: 'distanceX', refs: ['sp0', 'sp5'], value: 'L', name: 'len', offset: { x: 0, y: -42 } },
  );
  // plate with a centred hole, extruded
  const plate = outline('q', [[0, 0], [120, 0], [120, 60], [0, 60]]);
  plate.points.push({ id: 'qc', x: 60, y: 30 });
  plate.entities.push({ id: 'qh', type: 'circle', c: 'qc', r: 10 });
  plate.constraints.push(
    { id: 'qfix', type: 'fix', refs: ['qp0'], at: { x: 0, y: 0 } },
    { id: 'qh0', type: 'horizontal', refs: ['ql0'] }, { id: 'qv1', type: 'vertical', refs: ['ql1'] },
    { id: 'qh2', type: 'horizontal', refs: ['ql2'] }, { id: 'qv3', type: 'vertical', refs: ['ql3'] },
    { id: 'qd1', type: 'length', refs: ['ql0'], value: 'b_p', name: 'b', offset: { x: 0, y: -20 } },
    { id: 'qd2', type: 'length', refs: ['ql3'], value: '60 mm', name: 'h', offset: { x: -20, y: 0 } },
    { id: 'qd3', type: 'diameter', refs: ['qh'], value: 'd_2 + 1 mm', name: 'hole', offset: { x: 18, y: 14 } },
    { id: 'qd4', type: 'distanceX', refs: ['qp0', 'qc'], value: 'b_p/2', offset: { x: 0, y: -70 } },
    { id: 'qd5', type: 'distanceY', refs: ['qp0', 'qc'], value: '30 mm', offset: { x: 112, y: 0 } },
  );
  return build('CAD part design', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Parametric parts from the calculation\nThe shaft diameter comes from the torque; the CAD part takes it as a dimension, and its mass and inertia come back into the math. Change `T` and watch the drawing, the 3-D model and the results update. Double-click a part to edit it: drag geometry, add constraints, type expressions into dimensions.' }],
    ['math', L, mm(50), { source: 'T := 450 N*m' }],
    ['math', mm(70), mm(50), { source: 'τ_allow := 40 MPa' }],
    ['math', mm(130), mm(50), { source: 'L := 180 mm' }],
    ['math', L, mm(61), { source: 'd_req := (16 * T / (π * τ_allow))^(1/3) = mm' }],
    ['math', L, mm(75), { source: 'd := ceil(d_req / (5 mm)) * 5 mm = mm' }],
    ['math', mm(110), mm(75), { source: 'd_2 := d + 10 mm = mm' }],
    ['cad', L, mm(90), {
      name: 'shaft', width: mm(170), height: mm(56), view: { cx: 88, cy: 8, zoom: 1.57 }, sketch: shaft, mode: 'split',
      view3d: { yaw: -30, pitch: 20 }, feature: { type: 'revolve', axis: 'x', angle: '360' }, density: '7850 kg/m^3',
    }],
    ['text', L, mm(152), { width: mm(170), markdown: '## Results from the part\nThe revolved solid gives the mass and the mass moment of inertia about the shaft axis (x).' }],
    ['math', L, mm(170), { source: 'shaft.m = kg' }],
    ['math', mm(80), mm(170), { source: 'shaft.Imx = kg*cm^2' }],
    ['math', L, mm(182), { source: 'τ := 16 * T / (π * d^3) = MPa' }],
    ['math', mm(80), mm(182), { source: 'ω := 2 * π * 3000 / (60 s) = s^-1' }],
    ['math', L, mm(196), { source: 'E_k := 1/2 * shaft.Imx * ω^2 = J' }],
    ['text', L, mm(210), { width: mm(170), markdown: '## Mounting plate\nThe hole follows the shaft (`d_2 + 1 mm`) and the plate width is set here. The plate is extruded 8 mm in aluminium.' }],
    ['math', L, mm(231), { source: 'b_p := 4 * d_2 = mm' }],
    ['cad', L, mm(238), {
      name: 'plate', width: mm(110), height: mm(62), view: { cx: 100, cy: 20, zoom: 1.55 }, sketch: plate,
      feature: { type: 'extrude', depth: '8 mm' }, density: '2700 kg/m^3',
    }],
    ['math', mm(140), mm(246), { source: 'plate.m = g' }],
    ['math', mm(140), mm(258), { source: 'plate.A = cm^2' }],
    ['math', mm(140), mm(270), { source: 'plate.hole = mm' }],
  ]);
}

export const EXAMPLES: { name: string; make: () => Worksheet }[] = [
  { name: 'Welcome & beam check', make: welcomeWorksheet },
  { name: 'Solving & optimisation', make: solvingExample },
  { name: 'Programming & ranges', make: programmingExample },
  { name: 'Symbolic math', make: symbolicExample },
  { name: 'Plots', make: plottingExample },
  { name: 'Cross-sections (sketch)', make: sectionExample },
  { name: 'Mechanism animation (sketch)', make: mechanismExample },
  { name: 'CAD part design (parametric)', make: cadExample },
];
