import { createRegion, emptyWorksheet, PX_PER_MM, type DrawingRegion, type Frame3DRegion, type PlateRegion, type Region, type Worksheet } from './types';
import type { CadConstraint, CadEntity, CadSketch } from '../cad/model';
import type { CadDesign } from '../cad/design';
import type { Annotation, DrawPick } from '../cad/annotations';
import type { BeamAnalysis, BeamCases, BeamData, BeamPanel } from '../beam/model';
import { windCases, type F3Load, type F3Member, type F3Node } from '../frame3d/model';
import { collapseArea } from './areas';

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


/** Concentric circles about a fixed centre, each with a diameter dimension. */
function rings(prefix: string, dias: [number, string, string?][], extra: (sk: CadSketch) => void = () => {}): CadSketch {
  const sk: CadSketch = {
    points: [{ id: `${prefix}c`, x: 0, y: 0 }],
    entities: [],
    constraints: [{ id: `${prefix}fix`, type: 'fix', refs: [`${prefix}c`], at: { x: 0, y: 0 } }],
  };
  dias.forEach(([d, value, name], i) => {
    sk.entities.push({ id: `${prefix}k${i}`, type: 'circle', c: `${prefix}c`, r: d / 2 });
    sk.constraints.push({ id: `${prefix}d${i}`, type: 'diameter', refs: [`${prefix}k${i}`], value, ...(name ? { name } : {}), offset: { x: d * 0.25, y: d * 0.25 } });
  });
  extra(sk);
  return sk;
}

/** A rectangle centred on the origin with width and height dimensions (worksheet names). */
function centredRect(prefix: string, w: number, h: number, wExpr: string, hExpr: string): CadSketch {
  const sk = outline(prefix, [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]);
  sk.points.push({ id: `${prefix}o`, x: 0, y: 0 });
  sk.constraints.push(
    { id: `${prefix}fo`, type: 'fix', refs: [`${prefix}o`], at: { x: 0, y: 0 } },
    { id: `${prefix}h0`, type: 'horizontal', refs: [`${prefix}l0`] },
    { id: `${prefix}h2`, type: 'horizontal', refs: [`${prefix}l2`] },
    { id: `${prefix}v1`, type: 'vertical', refs: [`${prefix}l1`] },
    { id: `${prefix}v3`, type: 'vertical', refs: [`${prefix}l3`] },
    { id: `${prefix}dw`, type: 'distanceX', refs: [`${prefix}p0`, `${prefix}p1`], value: wExpr, offset: { x: 0, y: -12 } },
    { id: `${prefix}dh`, type: 'distanceY', refs: [`${prefix}p1`, `${prefix}p2`], value: hExpr, offset: { x: 12, y: 0 } },
    // centred: the corners are symmetric about the origin
    { id: `${prefix}cx`, type: 'distanceX', refs: [`${prefix}p0`, `${prefix}o`], value: `(${wExpr})/2` },
    { id: `${prefix}cy`, type: 'distanceY', refs: [`${prefix}p0`, `${prefix}o`], value: `(${hExpr})/2` },
  );
  return sk;
}

/** Thin extrude (an enclosure), rounded edges (a knob) and a loft (a duct). */
function shapingDesign(): CadDesign {
  return {
    version: 2,
    components: [
      {
        id: 'ce', name: 'Enclosure', color: '#9fb4cf',
        items: [
          { kind: 'sketch', id: 'se1', name: 'Outline', plane: { ref: 'XY' }, sketch: centredRect('e', 120, 80, 'B_e', 'H_e') },
          { kind: 'extrude', id: 'fe1', name: 'Shell', sketch: 'se1', extent: { type: 'one', d: 'h_e', dir: '+' }, op: 'new', thin: { t: 't_w', side: 'inside', cap: 'start' } },
        ],
      },
      {
        id: 'ck', name: 'Knob', color: '#d4a373',
        items: [
          { kind: 'sketch', id: 'sk1', name: 'Disc', plane: { ref: 'XY' }, sketch: rings('k', [[40, 'D_k']]) },
          { kind: 'extrude', id: 'fk1', name: 'Knob', sketch: 'sk1', extent: { type: 'one', d: '18 mm', dir: '+' }, op: 'new', edgeStart: { type: 'chamfer', r: '1 mm' }, edgeEnd: { type: 'fillet', r: 'r_k' } },
        ],
      },
      {
        id: 'cd', name: 'Duct', color: '#90be6d',
        items: [
          { kind: 'sketch', id: 'sd1', name: 'Inlet', plane: { ref: 'XY' }, sketch: centredRect('d', 80, 50, '80 mm', '50 mm') },
          { kind: 'sketch', id: 'sd2', name: 'Outlet', plane: { ref: 'XY', offset: '70 mm' }, sketch: rings('o', [[40, 'D_o']]) },
          { kind: 'loft', id: 'fd1', name: 'Transition', sketch: 'sd1', sketch2: 'sd2', op: 'new' },
        ],
      },
    ],
    occurrences: [
      { id: 'oe', component: 'ce', grounded: true },
      { id: 'ok', component: 'ck', grounded: true, pos: [110, 0, 0] },
      { id: 'od', component: 'cd', grounded: true, pos: [200, 0, 0] },
    ],
    joints: [],
  };
}

export function shapingExample(): Worksheet {
  return build('CAD: shells, roundings, lofts', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Shells, rounded edges and lofts\nThree parts made with the Extrude options and the Loft feature. The enclosure is a **thin** extrude (wall t_w, closed at the bottom); the knob has a chamfered bottom and a **rounded** top; the duct is a **loft** from a rectangle to a circle 70 mm higher. Change a value below and the parts follow.' }],
    ['math', L, mm(40), { source: 'B_e := 120 mm' }],
    ['math', mm(55), mm(40), { source: 'H_e := 80 mm' }],
    ['math', mm(90), mm(40), { source: 'h_e := 40 mm' }],
    ['math', mm(125), mm(40), { source: 't_w := 2.5 mm' }],
    ['math', L, mm(52), { source: 'D_k := 40 mm' }],
    ['math', mm(55), mm(52), { source: 'r_k := 5 mm' }],
    ['math', mm(90), mm(52), { source: 'D_o := 40 mm' }],
    ['cad', L, mm(64), { name: 'sh', width: mm(170), height: mm(80), mode: '3d', view3d: { yaw: -35, pitch: 30 }, density: '1200 kg/m^3', design: shapingDesign() }],
    ['math', L, mm(150), { source: 'sh.Enclosure.m = g' }],
    ['math', mm(72), mm(150), { source: 'sh.Knob.m = g' }],
    ['math', mm(122), mm(150), { source: 'sh.Duct.V = cm^3' }],
  ]);
}

/** A flange with a hub and a bolt circle, and a shaft turning in it. */
function flangeAssembly(): CadDesign {
  const plate = rings('f', [[200, 'D_f', 'D_f'], [51, 'd_2 + 1 mm']]);
  const hub = rings('h', [[100, 'D_h', 'D_h'], [51, 'd_2 + 1 mm']]);
  const bolts = rings('b', [], (sk) => {
    sk.points.push({ id: 'bp', x: 75, y: 0 });
    sk.entities.push({ id: 'be', type: 'point', p: 'bp' });
    sk.constraints.push(
      { id: 'bdx', type: 'distanceX', refs: ['bc', 'bp'], value: 'D_b/2', name: 'r_b', offset: { x: 0, y: -12 } },
      { id: 'bdy', type: 'distanceY', refs: ['bc', 'bp'], value: '0' },
    );
  });
  const shaft = rings('s', [[40, 'd']]);
  return {
    version: 2,
    components: [
      {
        id: 'cf', name: 'Flange', density: '7200 kg/m^3', color: '#8fa3bf',
        items: [
          { kind: 'sketch', id: 'sf1', name: 'Disc', plane: { ref: 'XY' }, sketch: plate },
          { kind: 'extrude', id: 'ff1', name: 'Plate', sketch: 'sf1', extent: { type: 'one', d: 't_f', dir: '+' }, op: 'new' },
          { kind: 'sketch', id: 'sf2', name: 'HubSketch', plane: { ref: 'XY', offset: 't_f' }, sketch: hub },
          { kind: 'extrude', id: 'ff2', name: 'Hub', sketch: 'sf2', extent: { type: 'one', d: '20 mm', dir: '+' }, op: 'join' },
          { kind: 'sketch', id: 'sf3', name: 'BoltCircle', plane: { ref: 'XY', offset: 't_f' }, sketch: bolts },
          { kind: 'hole', id: 'ff3', name: 'BoltHole', sketch: 'sf3', d: '9 mm', depth: '', through: true, style: 'counterbore', cbD: '15 mm', cbDepth: '4 mm' },
          { kind: 'pattern', id: 'ff4', name: 'Bolts', of: 'features', refs: ['ff3'], type: 'circ', axis: 'Z', count: 'n_b', spacing: '360 deg' },
        ],
      },
      {
        id: 'cs', name: 'Shaft', color: '#c9a36b',
        items: [
          { kind: 'sketch', id: 'ss1', name: 'ShaftSketch', plane: { ref: 'XY' }, sketch: shaft },
          { kind: 'extrude', id: 'fs1', name: 'Shaft', sketch: 'ss1', extent: { type: 'one', d: 'L', dir: '+' }, op: 'new' },
        ],
      },
    ],
    occurrences: [
      { id: 'of', component: 'cf', grounded: true },
      { id: 'os', component: 'cs', pos: [250, 0, 0] },
    ],
    joints: [{
      id: 'jr', name: 'Spin', type: 'revolute',
      a: { occ: 'of', origin: { kind: 'point', sketch: 'sf1', point: 'fc' } },
      b: { occ: 'os', origin: { kind: 'point', sketch: 'ss1', point: 'sc' } },
      angle: 'φ', offset: '-40 mm',
    }],
  };
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
  const ws = build('CAD part design', [
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
    ['text', L, mm(305), { width: mm(170), markdown: '## Assembly: flange and shaft\nTwo components, as in Fusion: a cast-iron flange (plate, hub, counterbored bolt holes patterned around the axis) and the shaft from above, placed by a revolute joint. Every size comes from this page — open the part to see the timeline, the browser and the joint.' }],
    ['math', L, mm(333), { source: 'D_f := 4 * d_2 = mm' }],
    ['math', mm(70), mm(333), { source: 'D_h := 2 * d_2 = mm' }],
    ['math', mm(125), mm(333), { source: 'D_b := 3 * d_2 = mm' }],
    ['math', L, mm(345), { source: 't_f := 12 mm' }],
    ['math', mm(70), mm(345), { source: 'n_b := 6' }],
    ['math', mm(125), mm(345), { source: 'φ := 15 deg' }],
    ['cad', L, mm(356), {
      name: 'asm', width: mm(170), height: mm(80), mode: '3d', view3d: { yaw: -30, pitch: 28 }, density: '7850 kg/m^3', design: flangeAssembly(),
    }],
    ['math', L, mm(442), { source: 'asm.Flange.m = kg' }],
    ['math', mm(75), mm(442), { source: 'asm.Shaft.m = kg' }],
    ['math', mm(130), mm(442), { source: 'asm.m = kg' }],
    ['math', L, mm(455), { source: 'asm.Imz = kg*cm^2' }],
    ['math', mm(85), mm(455), { source: 'asm.Spin = deg' }],
    ['math', mm(130), mm(455), { source: 'asm.Lz = mm' }],
    ['text', L, mm(470), { width: mm(170), markdown: '## Drawing\nRight-click a part → **Make a drawing**: exact standard views with hidden and centre lines, automatic dimensions and a title block, kept up to date with the part. Here a section A–A cut through two bolt holes on the top view, a detail B of a counterbore, the shaft Ø40 g6 with a perpendicularity to datum A, surface textures, the parts list and balloons: change `T` and they follow. Select it to annotate (**Dimension**, **Hole**, **GD&T**, **Datum**, **Surface** …), print it on A3 at true scale or export SVG / DXF.' }],
  ]);
  const asm = ws.regions.find((r) => r.kind === 'cad' && r.name === 'asm');
  if (asm) {
    ws.regions.push(createRegion('drawing', L, mm(510), {
      cad: asm.id, title: 'Flange with shaft', partNo: 'FA-001', material: 'EN-GJL-250 / C45', sheet: 'A3',
      sections: [{ id: 'sa', letter: 'A', view: 'top', a: { x: -115, y: 0 }, b: { x: 115, y: 0 } }],
      details: [{ id: 'db', letter: 'B', view: 'sec:sa', c: { x: 75, y: 8 }, r: 13, scale: 2 }],
      ...flangeDrawingNotes(),
    }));
  }
  return ws;
}

export function steelCheckExample(): Worksheet {
  return build('Steel beam check', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Steel beam check (EN 1993-1-1)\nSimply supported floor beam. `section()` and `steel()` come from the built-in library; a comparison such as `M_Ed ≤ M_Rd` is a check: ✓ or ✗ with the utilisation, and the status bar counts them.' }],
    ['math', L, mm(42), { source: 'L := 6 m' }],
    ['math', mm(56), mm(42), { source: 'G_k := 5 kN/m' }],
    ['math', mm(96), mm(42), { source: 'Q_k := 8 kN/m' }],
    ['math', mm(136), mm(42), { source: 'γ_M0 := 1.0' }],
    ['math', L, mm(54), { source: 's := section("IPE 300")' }],
    ['math', mm(96), mm(54), { source: 'm := steel("S355")' }],
    ['math', L, mm(66), { source: 'q_Ed := 1.35 G_k + 1.5 Q_k =' }],
    ['math', L, mm(78), { source: 'M_Ed := q_Ed L^2 / 8 =' }],
    ['math', mm(96), mm(78), { source: 'V_Ed := q_Ed L / 2 =' }],
    ['math', L, mm(92), { source: 'M_Rd := s.W_pl_y m.f_y / γ_M0 =' }],
    ['math', mm(96), mm(92), { source: 'V_Rd := s.A_vz m.f_y / (sqrt(3) γ_M0) =' }],
    ['text', L, mm(108), { width: mm(170), markdown: '## Checks' }],
    ['math', L, mm(118), { source: 'M_Ed ≤ M_Rd' }],
    ['math', L, mm(130), { source: 'V_Ed ≤ 0.5 V_Rd' }],
    ['math', L, mm(142), { source: 'w := 5 (G_k + Q_k) L^4 / (384 m.E s.I_y) =' }],
    ['math', L, mm(154), { source: 'w ≤ L / 250' }],
  ]);
}

export function pythonExample(): Worksheet {
  return build('Python code', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Python in the worksheet\nA **Python** region reads the variables defined above it — with their units — and every variable or function it assigns comes back to the worksheet. `Q(5, "kN")` and `u.mm` make quantities, `M.to("kN*m")` gives a plain number, `f"{M:.1f kN*m}"` formats one. Python starts on first use (a few seconds); numpy and scipy download on first `import`.' }],
    ['math', L, mm(46), { source: 'N_Ed := 850 kN' }],
    ['math', mm(62), mm(46), { source: 'L_cr := 4.5 m' }],
    ['math', mm(104), mm(46), { source: 'f_y := 355 MPa' }],
    ['math', mm(146), mm(46), { source: 'E := 210 GPa' }],
    ['math', mm(178), mm(46), { source: 'γ_M1 := 1.0' }],
    ['python', L, mm(56), { width: mm(170), code: `# Lightest HEB column for N_Ed: flexural buckling about the weak axis
# (EN 1993-1-1, 6.3.1, curve c). section() is the built-in steel table.

def chi(A, I, alpha=0.49):
    i = (I / A) ** 0.5
    lam = L_cr / i / math.pi * (f_y / E) ** 0.5
    phi = 0.5 * (1 + alpha * (lam - 0.2) + lam**2)
    return min(1.0, 1 / (phi + (phi**2 - lam**2) ** 0.5))

rows = []
for size in (160, 180, 200, 220, 240):
    s = section(f"HEB {size}")
    N = chi(s.A, s.I_z) * s.A * f_y / γ_M1
    rows.append((s.name, N))
    print(f"{s.name}:  N_b,Rd = {N:5.0f kN}   η = {N_Ed / N:.2f}")

profile, N_bRd = next((r for r in rows if r[1] >= N_Ed), rows[-1])` }],
    ['math', L, mm(226), { source: 'profile =' }],
    ['math', mm(62), mm(226), { source: 'N_bRd = kN' }],
    ['math', mm(104), mm(226), { source: 'N_Ed ≤ N_bRd' }],
    ['text', L, mm(240), { width: mm(80), markdown: 'Python functions work in math and plots too — here χ for a HEB 220 as its I_z varies:' }],
    ['math', L, mm(252), { source: 'S := section("HEB 220")' }],
    ['math', L, mm(262), { source: 'chi(S.A, S.I_z) =' }],
    ['plot', mm(104), mm(238), { xExpr: 'I', traces: [{ y: 'chi(91 cm^2, I)', style: 'line' }], xmin: '500 cm^4', xmax: '6000 cm^4', xUnit: 'cm^4', width: mm(86), height: mm(56), title: 'χ(I_z)' }],
  ]);
}

export function beamExample(): Worksheet {
  // continuous beam: spans of 5 m and 4 m, uniform load, a point load in the second span
  const beam: BeamData = {
    nodes: [{ id: 'bA', x: 0, y: 0 }, { id: 'bB', x: 5, y: 0 }, { id: 'bC', x: 9, y: 0 }],
    members: [{ id: 'bm1', a: 'bA', b: 'bB' }, { id: 'bm2', a: 'bB', b: 'bC' }],
    supports: [
      { id: 'bsA', node: 'bA', type: 'pin', angle: 0, label: 'A' },
      { id: 'bsB', node: 'bB', type: 'roller', angle: 0, label: 'B' },
      { id: 'bsC', node: 'bC', type: 'roller', angle: 0, label: 'C' },
    ],
    loads: [
      { id: 'bq1', type: 'line', member: 'bm1', q1: 'q_d', dir: 'global' },
      { id: 'bq2', type: 'line', member: 'bm2', q1: 'q_d', dir: 'global' },
      { id: 'bP', type: 'force', at: { member: 'bm2', t: 0.5 }, value: 'P_d', angle: -90 },
    ],
  };
  // portal frame with fixed feet: roof load and wind
  const frame: BeamData = {
    nodes: [{ id: 'f1', x: 0, y: 0 }, { id: 'f2', x: 0, y: 4 }, { id: 'f3', x: 6, y: 4 }, { id: 'f4', x: 6, y: 0 }],
    members: [{ id: 'fc1', a: 'f1', b: 'f2' }, { id: 'fr', a: 'f2', b: 'f3' }, { id: 'fc2', a: 'f4', b: 'f3' }],
    supports: [
      { id: 'fsA', node: 'f1', type: 'fixed', angle: 0, label: 'A' },
      { id: 'fsD', node: 'f4', type: 'fixed', angle: 0, label: 'D' },
    ],
    loads: [
      { id: 'fq', type: 'line', member: 'fr', q1: 'q_r', dir: 'global' },
      { id: 'fH', type: 'force', at: { node: 'f2' }, value: 'H_w', angle: 0 },
    ],
  };
  // two spans with pattern loading: G everywhere, Q on span 1, span 2 or both
  const pattern: BeamData & { loadCases: BeamCases } = {
    nodes: [{ id: 'pA', x: 0, y: 0 }, { id: 'pB', x: 6, y: 0 }, { id: 'pC', x: 12, y: 0 }],
    members: [{ id: 'pm1', a: 'pA', b: 'pB' }, { id: 'pm2', a: 'pB', b: 'pC' }],
    supports: [
      { id: 'psA', node: 'pA', type: 'pin', angle: 0, label: 'A' },
      { id: 'psB', node: 'pB', type: 'roller', angle: 0, label: 'B' },
      { id: 'psC', node: 'pC', type: 'roller', angle: 0, label: 'C' },
    ],
    loads: [
      { id: 'pg1', type: 'line', member: 'pm1', q1: 'g_k', dir: 'global', case: 'G' },
      { id: 'pg2', type: 'line', member: 'pm2', q1: 'g_k', dir: 'global', case: 'G' },
      { id: 'pq1', type: 'line', member: 'pm1', q1: 'q_k2', dir: 'global', case: 'Q1' },
      { id: 'pq2', type: 'line', member: 'pm2', q1: 'q_k2', dir: 'global', case: 'Q2' },
    ],
    loadCases: {
      cases: [{ id: 'G', name: 'G', label: 'Permanent' }, { id: 'Q1', name: 'Q1', label: 'Imposed, span 1' }, { id: 'Q2', name: 'Q2', label: 'Imposed, span 2' }],
      combos: [
        { id: 'u1', name: 'ULS 1', kind: 'ULS', factors: { G: '1.35', Q1: '1.5', Q2: '0' } },
        { id: 'u2', name: 'ULS 2', kind: 'ULS', factors: { G: '1.35', Q1: '0', Q2: '1.5' } },
        { id: 'u3', name: 'ULS 3', kind: 'ULS', factors: { G: '1.35', Q1: '1.5', Q2: '1.5' } },
        { id: 's1', name: 'SLS', kind: 'SLS', factors: { G: '1', Q1: '1', Q2: '0' } },
      ],
      view: 'envelope',
    },
  };
  // sway portal on pinned feet: second order with shear deformation, and its buckling mode
  const sway: BeamData & { analysis: BeamAnalysis; panels: BeamPanel[] } = {
    nodes: [{ id: 'w1', x: 0, y: 0 }, { id: 'w2', x: 0, y: 5 }, { id: 'w3', x: 8, y: 5 }, { id: 'w4', x: 8, y: 0 }],
    members: [{ id: 'wc1', a: 'w1', b: 'w2' }, { id: 'wr', a: 'w2', b: 'w3' }, { id: 'wc2', a: 'w4', b: 'w3' }],
    supports: [
      { id: 'wsA', node: 'w1', type: 'pin', angle: 0, label: 'A' },
      { id: 'wsD', node: 'w4', type: 'pin', angle: 0, label: 'D' },
    ],
    loads: [
      { id: 'wq', type: 'line', member: 'wr', q1: 'q_s', dir: 'global' },
      { id: 'wH', type: 'force', at: { node: 'w2' }, value: 'H_s', angle: 0 },
    ],
    analysis: { secondOrder: true, shear: true },
    panels: ['M', 'mode'],
  };
  return build('Beams and frames', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Beams and frames\nPress **Beam** in the toolbar, draw members, click supports and loads onto them — the reactions and the N, V, M and deflection diagrams follow at once. Loads are worksheet expressions, and the results come back as variables. Double-click a structure to edit it; switch diagrams with the strip below it.' }],
    ['math', L, mm(44), { source: 'q_k := 8 kN/m' }],
    ['math', mm(65), mm(44), { source: 'P_k := 25 kN' }],
    ['math', mm(115), mm(44), { source: 'γ_Q := 1.5' }],
    ['math', L, mm(56), { source: 'q_d := γ_Q * q_k = kN/m' }],
    ['math', mm(65), mm(56), { source: 'P_d := γ_Q * P_k = kN' }],
    ['beam', L, mm(68), { name: 'b', width: mm(170), height: mm(70), show: 'M', ...beam }],
    ['text', L, mm(142), { width: mm(170), markdown: '## Checks\nReactions, the largest moment and the bending stress of the IPE 300 (S235: f_y = 235 MPa), and the deflection against L/250 of the longer span.' }],
    ['math', L, mm(162), { source: 'b.A.Ry = kN' }],
    ['math', mm(65), mm(162), { source: 'b.B.Ry = kN' }],
    ['math', mm(115), mm(162), { source: 'b.C.Ry = kN' }],
    ['math', L, mm(174), { source: 'b.M_max = kN*m' }],
    ['math', mm(65), mm(174), { source: 'u_σ := b.σ_max / (235 MPa) =' }],
    ['math', L, mm(188), { source: 'b.w_max = mm' }],
    ['math', mm(65), mm(188), { source: 'w_lim := 5 m / 250 = mm' }],
    ['plot', L, mm(202), { xExpr: 'x', traces: [{ y: 'b.M(x)', style: 'line' }], xmin: '0 m', xmax: 'b.L', xUnit: 'm', yUnit: 'kN*m', title: 'M(x) from the beam', width: mm(82), height: mm(52) }],
    ['plot', mm(108), mm(202), { xExpr: 'x', traces: [{ y: 'b.w(x)', style: 'line' }], xmin: '0 m', xmax: 'b.L', xUnit: 'm', yUnit: 'mm', title: 'w(x)', width: mm(82), height: mm(52) }],
    ['text', L, mm(268), { width: mm(170), markdown: '## Portal frame\nFixed feet, a roof load and wind on the left corner. The frame is statically indeterminate (degree 3); the stiffness method solves it directly.' }],
    ['math', L, mm(288), { source: 'q_r := 12 kN/m' }],
    ['math', mm(65), mm(288), { source: 'H_w := 15 kN' }],
    ['beam', L, mm(298), { name: 'fr', width: mm(170), height: mm(95), show: 'M', ...frame }],
    ['math', L, mm(400), { source: 'fr.A.M = kN*m' }],
    ['math', mm(70), mm(400), { source: 'fr.D.Rx = kN' }],
    ['math', mm(125), mm(400), { source: 'fr.w_max = mm' }],
    ['text', L, mm(418), { width: mm(170), markdown: '## Load cases and pattern loading\nPermanent load G on both spans, imposed load Q1 / Q2 on either span. Three ULS combinations put Q where it hurts most; the strip shows the envelope (max solid, min dashed). Pick a combination or a case there, or edit them in the side panel.' }],
    ['math', L, mm(440), { source: 'g_k := 6 kN/m' }],
    ['math', mm(65), mm(440), { source: 'q_k2 := 9 kN/m' }],
    ['beam', L, mm(450), { name: 'pb', width: mm(170), height: mm(80), ...pattern }],
    ['math', L, mm(534), { source: 'pb.M_max = kN*m' }],
    ['math', mm(65), mm(534), { source: 'pb.combos.ULS_1.M_max = kN*m' }],
    ['math', L, mm(546), { source: 'pb.B.Ry = kN' }],
    ['math', mm(65), mm(546), { source: 'pb.w_max = mm' }],
    ['text', L, mm(562), { width: mm(170), markdown: '## Stability: a sway portal in second order\nOn pinned feet the portal sways easily. Its analysis (side panel → Analysis) is **second order** with shear deformation: each load set is first checked for buckling — α_cr, with the EN 1993-1-1 5.2.1(3) verdict — and then solved on the deformed structure. The strip shows the moments and the lowest buckling mode.' }],
    ['math', L, mm(588), { source: 'q_s := 30 kN/m' }],
    ['math', mm(65), mm(588), { source: 'H_s := 10 kN' }],
    // tall enough for its diagrams from the start, so it does not grow over the math below
    ['beam', L, mm(598), { name: 'sp', width: mm(170), height: mm(160), ...sway }],
    ['math', L, mm(770), { source: 'sp.alpha_cr =' }],
    ['math', mm(65), mm(770), { source: 'sp.alpha_cr ≥ 3' }],
    ['math', L, mm(782), { source: 'sp.M_max = kN*m' }],
    ['math', mm(80), mm(782), { source: 'sp.first.M_max = kN*m' }],
    ['math', L, mm(794), { source: 'sp.M_max / sp.first.M_max =' }],
    ['math', mm(80), mm(794), { source: '1 / (1 - 1 / sp.alpha_cr) =' }],
    ['math', L, mm(810), { source: 'sp.L_cr[0] = m' }],
    ['text', L, mm(822), { width: mm(170), markdown: 'The corner moment comes mostly from the roof load, which hardly sways the frame, so it grows less than 1/(1 − 1/α_cr): that factor amplifies the sway part only (EN 1993-1-1 5.2.2(5)B). `sp.L_cr` lists the buckling lengths in member order: the left column first.' }],
  ]);
}

export function bridgeExample(): Worksheet {
  // a two-span bridge girder carrying one notional lane: permanent load G, and EN 1991-2 LM1 moving
  const girder: BeamData & { loadCases: BeamCases; panels: BeamPanel[]; traffic: import('../beam/model').BeamTraffic } = {
    nodes: [{ id: 'gA', x: 0, y: 0 }, { id: 'gB', x: 25, y: 0 }, { id: 'gC', x: 50, y: 0 }],
    members: [{ id: 'gm1', a: 'gA', b: 'gB' }, { id: 'gm2', a: 'gB', b: 'gC' }],
    supports: [
      { id: 'gsA', node: 'gA', type: 'pin', angle: 0, label: 'A' },
      { id: 'gsB', node: 'gB', type: 'roller', angle: 0, label: 'B' },
      { id: 'gsC', node: 'gC', type: 'roller', angle: 0, label: 'C' },
    ],
    loads: [
      { id: 'gg1', type: 'line', member: 'gm1', q1: 'g_k', dir: 'global', case: 'G' },
      { id: 'gg2', type: 'line', member: 'gm2', q1: 'g_k', dir: 'global', case: 'G' },
    ],
    loadCases: {
      cases: [{ id: 'G', name: 'G', label: 'Permanent' }],
      combos: [
        { id: 'gu', name: 'ULS', kind: 'ULS', factors: { G: '1.35', glm: '1.35' } },
        { id: 'gs', name: 'SLS', kind: 'SLS', factors: { G: '1', glm: '1' } },
      ],
      view: 'gu',
    },
    panels: ['V', 'M'],
    traffic: {
      lines: [
        { id: 'gRB', name: 'RB', quantity: 'Ry', support: 'gsB' },
        { id: 'gMB', name: 'MB', quantity: 'M', at: { x: 25, y: 0 } },
        { id: 'gM1', name: 'M1', quantity: 'M', at: { x: 10, y: 0 } },
      ],
      loads: [{ id: 'glm', name: 'LM1', preset: 'lm1', alphaQ: '1', alphaq: '1', w: '3' }],
    },
  };
  return build('Bridge girder: influence lines and LM1', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Bridge girder: influence lines and Load Model 1\nTwo spans of 25 m carry one notional lane. The permanent load G is an ordinary load case; EN 1991-2 Load Model 1 is a **moving load** (side panel → Moving loads): the tandem system 2 × α_Q·300 kN at 1.2 m stops with each axle on every load position, both ways, and the lane load α_q·9 kN/m² × 3 m goes only where the influence line is adverse. The combinations add 1.35 × the LM1 extremes to 1.35 G.' }],
    ['math', L, mm(52), { source: 'g_k := 60 kN/m' }],
    ['beam', L, mm(62), {
      name: 'gb', width: mm(170), height: mm(236), section: { E: '210 GPa', A: '600 cm^2', I: '8000000 cm^4', W: '88900 cm^3' }, ...girder,
    }],
    ['text', L, mm(304), { width: mm(170), markdown: '## Influence lines\nThe panels under the diagrams are the influence lines asked for: the reaction at B (1 over B, a cubic each side), the moment over B (negative on both spans) and the moment at 10 m. They come back as functions of x.' }],
    ['math', L, mm(332), { source: 'gb.IL.RB(10 m) =' }],
    ['math', mm(80), mm(332), { source: 'gb.IL.MB_min = m' }],
    ['math', mm(135), mm(332), { source: 'gb.IL.M1_max = m' }],
    ['plot', L, mm(344), { xExpr: 'x', traces: [{ y: 'gb.IL.MB(x)', style: 'line' }, { y: 'gb.IL.M1(x)', style: 'line' }], xmin: '0 m', xmax: '50 m', xUnit: 'm', yUnit: 'm', title: 'Influence lines of M over B and at 10 m', width: mm(82), height: mm(52) }],
    ['plot', mm(108), mm(344), { xExpr: 'x', traces: [{ y: 'gb.combos.ULS.M(x)', style: 'line' }, { y: 'gb.combos.ULS.min.M(x)', style: 'line' }], xmin: '0 m', xmax: '50 m', xUnit: 'm', yUnit: 'kN*m', title: 'ULS envelope: 1.35 G + 1.35 LM1', width: mm(82), height: mm(52) }],
    ['text', L, mm(404), { width: mm(170), markdown: '## LM1 extremes and where they act\n`x_M_max` is the section, `pos_M_max` the first axle of the tandem when it happens. Pick **LM1 (envelope)** in the strip under the girder and press **Train** to drag the tandem along and watch the diagrams.' }],
    ['math', L, mm(434), { source: 'gb.moving.LM1.M_max = kN*m' }],
    ['math', mm(105), mm(434), { source: 'gb.moving.LM1.x_M_max = m' }],
    ['math', L, mm(446), { source: 'gb.moving.LM1.pos_M_max = m' }],
    ['math', mm(105), mm(446), { source: 'gb.moving.LM1.M_min = kN*m' }],
    ['math', L, mm(458), { source: 'gb.moving.LM1.B.Ry_max = kN' }],
    ['math', mm(105), mm(458), { source: 'gb.moving.LM1.w_max = mm' }],
    ['text', L, mm(472), { width: mm(170), markdown: 'A hand check on the hogging moment: the lane load alone on both spans gives −q L²/8 over B, and the tandem adds about 2 × 300 kN × the lowest ordinate of the influence line (−L/(6√3) = −2.41 m at L/√3).' }],
    ['math', L, mm(494), { source: 'q_lane := 9 kN/m^2 * 3 m = kN/m' }],
    ['math', L, mm(512), { source: '-q_lane * (25 m)^2 / 8 = kN*m' }],
    ['math', mm(100), mm(512), { source: '2 * 300 kN * gb.IL.MB_min = kN*m' }],
    ['text', L, mm(530), { width: mm(170), markdown: '## Design values\nULS governing moment and bending stress, and the SLS deflection under G + LM1 (characteristic).' }],
    ['math', L, mm(550), { source: 'gb.M_max = kN*m' }],
    ['math', mm(88), mm(550), { source: 'gb.σ_max = MPa' }],
    ['math', mm(140), mm(550), { source: 'gb.w_max = mm' }],
  ]);
}

export function odeExample(): Worksheet {
  return build('Differential equations', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Free vibration of a single-storey frame\nA 30 t roof on two fixed-base HEB 200 columns (sway stiffness 2 × 12 EI/h³), 5 % damping, pushed 20 mm sideways and let go. The solve block takes the differential equation and its initial conditions; `odesolve` returns the displacement as a function of time, with units.' }],
    ['math', L, mm(42), { source: 'h := 4 m' }],
    ['math', mm(56), mm(42), { source: 'E := 210 GPa' }],
    ['math', mm(100), mm(42), { source: 'I_c := section("HEB 200").I_y = cm^4' }],
    ['math', L, mm(54), { source: 'M := 30000 kg' }],
    ['math', mm(56), mm(54), { source: 'ζ := 0.05' }],
    ['math', mm(100), mm(54), { source: 'k := 2 * 12 * E * I_c / h^3 = kN/m' }],
    ['math', L, mm(66), { source: 'ω := sqrt(k / M)' }],
    ['math', mm(52), mm(66), { source: 'f_n := ω / (2 π) = Hz' }],
    ['math', mm(96), mm(66), { source: 'T_n := 1 / f_n = s' }],
    ['math', mm(136), mm(66), { source: 'c := 2 ζ sqrt(k M) = kN*s/m' }],
    ['solve', L, mm(80), { guesses: '', constraints: "M * u''(t) + c * u'(t) + k * u(t) = 0\nu(0 s) = 20 mm\nu'(0 s) = 0 mm/s", solver: 'u := odesolve(t, 5 s)' }],
    ['math', mm(110), mm(86), { source: 'u(1 s) = mm' }],
    ['math', mm(110), mm(98), { source: "u'(0.25 s) = mm/s" }],
    ['math', mm(110), mm(110), { source: "u''(0 s) = m/s^2" }],
    ['plot', L, mm(132), { xExpr: 't', traces: [{ y: 'u(t)', style: 'line' }, { y: '20 mm * exp(-ζ * ω * t)', style: 'line' }, { y: '-20 mm * exp(-ζ * ω * t)', style: 'line' }], xmin: '0 s', xmax: '5 s', xUnit: 's', yUnit: 'mm', title: 'Roof displacement u(t) and its envelope', width: mm(130), height: mm(62) }],
    ['text', L, mm(200), { width: mm(170), markdown: '**Check** against the closed-form solution of the damped free vibration:' }],
    ['math', L, mm(210), { source: 'ω_d := ω sqrt(1 - ζ^2)' }],
    ['math', L, mm(222), { source: 'u_e(t) := 20 mm * exp(-ζ ω t) * (cos(ω_d t) + ζ / sqrt(1 - ζ^2) * sin(ω_d t))' }],
    ['math', L, mm(238), { source: 'u(1 s) - u_e(1 s) = mm' }],
    ['text', L, mm(305), { width: mm(170), markdown: '## A short pulse\nThe same frame hit by a 0.2 s half-sine force of 50 kN, starting at rest. `odesolve` handles any right-hand side the worksheet can evaluate.' }],
    ['math', L, mm(323), { source: 'F(t) := if(t < 0.2 s, 50 kN * sin(π t / 0.2 s), 0 kN)' }],
    ['solve', L, mm(337), { guesses: '', constraints: "M * v''(t) + c * v'(t) + k * v(t) = F(t)\nv(0 s) = 0 mm\nv'(0 s) = 0 mm/s", solver: 'v := odesolve(t, 3 s)' }],
    ['plot', mm(110), mm(339), { xExpr: 't', traces: [{ y: 'v(t)', style: 'line' }], xmin: '0 s', xmax: '3 s', xUnit: 's', yUnit: 'mm', title: 'Pulse response v(t)', width: mm(80), height: mm(52) }],
    ['math', L, mm(383), { source: 'v(0.3 s) = mm' }],
    ['text', L, mm(400), { width: mm(170), markdown: '## Beam deflection as a boundary value problem\nEI y⁗ = q with y = y″ = 0 at both supports: conditions at two points, solved by shooting. The bare zeros take their units from the equation.' }],
    ['math', L, mm(422), { source: 'q := 12 kN/m' }],
    ['math', mm(56), mm(422), { source: 'L := 6 m' }],
    ['math', mm(96), mm(422), { source: 'EI := 210 GPa * 8360 cm^4' }],
    ['solve', L, mm(436), { guesses: '', constraints: "EI * y''''(x) = q\ny(0) = 0\ny(L) = 0\ny''(0) = 0\ny''(L) = 0", solver: 'y := odesolve(x, L)' }],
    ['math', mm(110), mm(442), { source: 'y(L / 2) = mm' }],
    ['math', mm(110), mm(454), { source: '5 q L^4 / (384 EI) = mm' }],
    ['math', mm(110), mm(468), { source: "-EI * y''(L / 2) = kN*m" }],
    ['math', mm(110), mm(482), { source: 'q L^2 / 8 = kN*m' }],
    ['text', L, mm(502), { width: mm(170), markdown: '## Special functions: a flagpole buckling under its own weight\nGreenhill: a column clamped at the base buckles under its self-weight q when q L³/EI = (9/4) j², j being the first zero of the Bessel function J₋₁/₃ (real order).' }],
    ['math', L, mm(524), { source: 'j := root(Jn(-1/3, z), z, 1, 2.5) =' }],
    ['math', mm(110), mm(524), { source: '9 / 4 * j^2 =' }],
    ['math', L, mm(538), { source: 'q_w := 0.5 kN/m' }],
    ['math', mm(56), mm(538), { source: 'EI_p := 210 GPa * 2000 cm^4' }],
    ['math', mm(120), mm(538), { source: 'L_cr := (9 / 4 * j^2 * EI_p / q_w)^(1/3) = m' }],
    ['text', L, mm(602), { width: mm(170), markdown: '## A ground beam on an elastic foundation\nA 30 m HEB 300 ground beam, simply supported at its ends, rests on soil with a subgrade reaction k = 50 MN/m² per metre of beam and carries 20 kN/m. With λL ≈ 21 the solution grows like e^(λx) from each end, too fast to shoot from one end, so odesolve switches to multiple shooting. Away from the ends the beam just sits on the soil, w = q/k; near an end the moment peaks at λx = π/4 with q/(2λ²) e^(−π/4) sin(π/4), as for a semi-infinite beam (Hetényi).' }],
    ['math', L, mm(638), { source: 'q_b := 20 kN/m' }],
    ['math', mm(56), mm(638), { source: 'k_s := 50 MPa' }],
    ['math', mm(100), mm(638), { source: 'EI_b := 210 GPa * section("HEB 300").I_y' }],
    ['math', L, mm(650), { source: 'L_b := 30 m' }],
    ['math', mm(56), mm(650), { source: 'λ := (k_s / (4 EI_b))^(1/4) =' }],
    ['math', mm(120), mm(650), { source: 'λ * L_b =' }],
    ['solve', L, mm(664), { guesses: '', constraints: "EI_b * w''''(x) + k_s * w(x) = q_b\nw(0) = 0\nw(L_b) = 0\nw''(0) = 0\nw''(L_b) = 0", solver: 'w := odesolve(x, L_b)' }],
    ['math', mm(110), mm(668), { source: 'w(L_b / 2) = mm' }],
    ['math', mm(110), mm(680), { source: 'q_b / k_s = mm' }],
    ['math', mm(110), mm(692), { source: "M_max := -EI_b * w''(π / (4 λ)) = kN*m" }],
    ['math', mm(110), mm(706), { source: 'q_b / (2 λ^2) * exp(-π / 4) * sin(π / 4) = kN*m' }],
    ['plot', L, mm(724), { xExpr: 'x', traces: [{ y: 'w(x)', style: 'line' }], xmin: '0 m', xmax: '30 m', xUnit: 'm', yUnit: 'mm', title: 'Deflection w(x) of the ground beam', width: mm(130), height: mm(55) }],
  ]);
}

/** A one-storey steel frame in 3-D, its geometry and loads from the worksheet. */
function steelFrame3D(): Partial<Frame3DRegion> {
  const nodes: F3Node[] = [], members: F3Member[] = [];
  const xs = ['0', 'a', '2*a'], ys = ['0', 'b'];
  ys.forEach((y, j) => xs.forEach((x, i) => {
    const k = j * 3 + i + 1;
    nodes.push({ id: `f${k}`, name: `F${k}`, x, y, z: '0' }, { id: `t${k}`, name: `T${k}`, x, y, z: 'h' });
    members.push({ id: `c${k}`, name: `C${k}`, a: `f${k}`, b: `t${k}`, section: 'col' });
  }));
  for (const j of [0, 1]) for (const i of [1, 2]) members.push({ id: `x${j}${i}`, name: `BX${j * 2 + i}`, a: `t${j * 3 + i}`, b: `t${j * 3 + i + 1}`, section: 'bx' });
  for (const i of [1, 2, 3]) members.push({ id: `y${i}`, name: `BY${i}`, a: `t${i}`, b: `t${i + 3}`, section: 'by' });
  const roof = members.filter((m) => m.id[0] === 'x');
  const loads: F3Load[] = [
    ...roof.map((m): F3Load => ({ id: `g${m.id}`, type: 'line', member: m.id, dir: 'Z', q1: '-g_k', case: 'G' })),
    ...roof.map((m): F3Load => ({ id: `q${m.id}`, type: 'line', member: m.id, dir: 'Z', q1: '-q_k', case: 'Q' })),
    { id: 'sw', type: 'self', case: 'G' },
    // wind on the wall at x = 0: its two columns take half a bay each
    ...['c1', 'c4'].map((c): F3Load => ({ id: `w${c}`, type: 'line', member: c, dir: 'X', q1: 'w_k * b / 2', case: 'W' })),
  ];
  return {
    nodes, members, loads,
    sections: [
      { id: 'col', name: 'Column', profile: 'HEB 200', material: 'S355' },
      { id: 'bx', name: 'Beam X', profile: 'IPE 300', material: 'S355' },
      { id: 'by', name: 'Beam Y', profile: 'IPE 240', material: 'S355' },
    ],
    supports: nodes.filter((n) => n.z === '0').map((n) => ({ id: `s${n.id}`, node: n.id, dofs: ['fixed', 'fixed', 'fixed', 'fixed', 'fixed', 'fixed'] })),
    loadCases: windCases(),
    analysis: { buckling: true },
  };
}

export function frame3dExample(): Worksheet {
  return build('3-D steel frame', [
    ['text', L, mm(12), { width: mm(170), markdown: '# 3-D steel frame\nPress **3-D frame** in the toolbar for a space frame: nodes, members, sections, supports and loads in tables, every value a worksheet expression. This hall frame of 2 × 1 bays has fixed feet, roof loads G and Q on the main beams, its own weight and wind W on the gable at x = 0, in three EN 1990 combinations. Double-click it to orbit and edit the tables; the strip switches the diagrams (hover for values).' }],
    ['math', L, mm(54), { source: 'a := 6 m' }],
    ['math', mm(55), mm(54), { source: 'b := 5 m' }],
    ['math', mm(90), mm(54), { source: 'h := 4.5 m' }],
    ['math', L, mm(64), { source: 'g_k := 6 kN/m' }],
    ['math', mm(55), mm(64), { source: 'q_k := 7.5 kN/m' }],
    ['math', mm(100), mm(64), { source: 'w_k := 0.8 kN/m^2' }],
    ['frame3d', L, mm(80), { name: 'f', width: mm(170), height: mm(112), show: 'My', camera: { yaw: 35, pitch: 22, zoom: 1.05, panX: 0, panY: 0.04 }, ...steelFrame3D() }],
    ['text', L, mm(198), { width: mm(170), markdown: '## Results in the worksheet\nForces and reactions are the governing ones over the ULS combinations, displacements over the SLS one; each case and combination is there on its own too. Member z points down in a beam, so sagging M_y is positive.' }],
    ['math', L, mm(226), { source: 'f.α_cr =' }],
    ['math', mm(60), mm(226), { source: 'f.α_cr ≥ 10' }],
    ['math', L, mm(238), { source: 'f.BX1.My_max = kN*m' }],
    ['math', mm(95), mm(238), { source: 'f.BX1.My_min = kN*m' }],
    ['math', L, mm(250), { source: 'f.C1.N_min = kN' }],
    ['math', mm(95), mm(250), { source: 'f.F1.Rz = kN' }],
    ['math', L, mm(262), { source: 'f.combos.ULS2.F1.Rx = kN' }],
    ['math', mm(105), mm(262), { source: 'f.cases.W.F1.My = kN*m' }],
    ['text', L, mm(304), { width: mm(170), markdown: '## Checks\nExtreme fibre stress |N|/A + |M_y|/W_y + |M_z|/W_z of the main beam and a column against f_y (S355), and the sway of the frame top under SLS against h/300.' }],
    ['math', L, mm(326), { source: 'f.BX1.σ_max ≤ 355 MPa' }],
    ['math', L, mm(338), { source: 'f.C2.σ_max ≤ 355 MPa' }],
    ['math', L, mm(350), { source: 'f.T1.ux ≤ h / 300' }],
    ['math', L, mm(366), { source: 'f.u_max = mm' }],
    ['plot', L, mm(380), { xExpr: 'x', traces: [{ y: 'f.BX1.My(x)', style: 'line' }, { y: 'f.BX2.My(x)', style: 'line' }], xmin: '0 m', xmax: 'a', xUnit: 'm', yUnit: 'kN*m', title: 'M_y along BX1 and BX2 (ULS1)', width: mm(110), height: mm(56) }],
  ]);
}

/** A flat slab of 6 m × 4.5 m on six columns with a stair opening, from worksheet variables. */
function flatSlab(): Partial<PlateRegion> {
  const col = (name: string, x: string, y: string) => ({ id: name.toLowerCase(), name, x, y, b: 'c', h: 'c' });
  return {
    thickness: 't_s', material: 'C30/37',
    outline: [{ x: '0', y: '0' }, { x: 'L_x', y: '0' }, { x: 'L_x', y: 'L_y' }, { x: '0', y: 'L_y' }],
    edges: [0, 1, 2, 3].map(() => ({ support: 'free' as const })),
    openings: [{ id: 'o1', name: 'O1', points: [{ x: '3.9', y: '1.8' }, { x: '5.1', y: '1.8' }, { x: '5.1', y: '2.7' }, { x: '3.9', y: '2.7' }] }],
    walls: [],
    columns: [col('C1', 'c/2', 'c/2'), col('C2', 'L_x/2', 'c/2'), col('C3', 'L_x - c/2', 'c/2'), col('C4', 'c/2', 'L_y - c/2'), col('C5', 'L_x/2', 'L_y - c/2'), col('C6', 'L_x - c/2', 'L_y - c/2')],
    loads: [
      { id: 'sw', type: 'self', case: 'G' },
      { id: 'g2', type: 'area', q: 'g_2', case: 'G' },
      // the façade along the far edge, over the columns' line
      { id: 'gf', type: 'line', q: 'g_f', x1: '0', y1: 'L_y - c/2', x2: 'L_x', y2: 'L_y - c/2', case: 'G' },
      { id: 'qk', type: 'area', q: 'q_k', case: 'Q' },
    ],
    loadCases: {
      cases: [{ id: 'G', name: 'G', label: 'Permanent' }, { id: 'Q', name: 'Q', label: 'Imposed' }],
      combos: [{ id: 'uls', name: 'ULS', kind: 'ULS', factors: { G: '1.35', Q: '1.5' } }, { id: 'sls', name: 'SLS', kind: 'SLS', factors: { G: '1', Q: '1' } }],
      view: 'uls',
    },
    rebar: { steel: 'B500B', cover: '25', bar: '12' },
    show: 'asyb', cut: { x1: 0, y1: 2.25, x2: 6, y2: 2.25 },
  };
}

export function plateExample(): Worksheet {
  return build('Flat slab (plate)', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Flat slab with an opening\nPress **Plate** in the toolbar for a slab or plate: an outline with openings, edge supports, walls, columns and loads, solved by finite elements (MITC4 plate elements, meshed to the size you ask). This 6.0 m × 4.5 m slab, 220 mm C30/37, stands on six columns 350 × 350 with free edges and a stair opening of 1.2 m × 0.9 m. It carries its own weight, finishes, a façade along the far edge and an imposed load, in the EN 1990 combinations, and the bending reinforcement is designed from Wood–Armer moments (EN 1992-1-1). Double-click it to edit the tables; the strip picks the result, *More…* the design quantities, and the section A–B is plotted under the plan (hover for values).' }],
    ['math', L, mm(70), { source: 'L_x := 6 m' }],
    ['math', mm(55), mm(70), { source: 'L_y := 4.5 m' }],
    ['math', mm(95), mm(70), { source: 't_s := 220 mm' }],
    ['math', mm(140), mm(70), { source: 'c := 350 mm' }],
    ['math', L, mm(80), { source: 'g_2 := 1.5 kN/m^2' }],
    ['math', mm(65), mm(80), { source: 'g_f := 4 kN/m' }],
    ['math', mm(110), mm(80), { source: 'q_k := 3 kN/m^2' }],
    ['plate', L, mm(94), { name: 'p', width: mm(170), height: mm(150), ...flatSlab() }],
    ['text', L, mm(250), { width: mm(170), markdown: '## Results in the worksheet\nMoments, shear and reinforcement are the governing ones over the ULS combinations, the deflection over SLS; reactions per column. The deflection is elastic and uncracked: the long-term value needs creep and cracking on top.' }],
    ['math', L, mm(282), { source: 'p.w_max = mm' }],
    ['math', mm(70), mm(282), { source: 'p.w_max ≤ L_y / 250' }],
    ['math', L, mm(304), { source: 'p.m_y_max = kN*m/m' }],
    ['math', mm(70), mm(304), { source: 'p.m_x_min = kN*m/m' }],
    ['math', L, mm(316), { source: 'p.C5.R = kN' }],
    ['math', mm(70), mm(316), { source: 'p.R_sum = kN' }],
    ['text', L, mm(332), { width: mm(170), markdown: '## Reinforcement\nBottom bars along y Ø12/200 and along x Ø10/250, top bars Ø10/200 both ways, against the largest required a_s and the minimum of EN 1992-1-1 9.3.1.1 (d_x = 220 − 25 − 6 = 189 mm). Punching at the columns and the detailing round the opening are not checked here.' }],
    ['math', L, mm(362), { source: 'a_s_yb := bars(1, 12 mm) / 200 mm = cm^2/m' }],
    ['math', mm(100), mm(362), { source: 'p.a_s_y_bot_max / a_s_yb ≤ 1' }],
    ['math', L, mm(374), { source: 'a_s_xb := bars(1, 10 mm) / 250 mm = cm^2/m' }],
    ['math', mm(100), mm(374), { source: 'p.a_s_x_bot_max / a_s_xb ≤ 1' }],
    ['math', L, mm(386), { source: 'a_s_t := bars(1, 10 mm) / 200 mm = cm^2/m' }],
    ['math', mm(100), mm(386), { source: 'max(p.a_s_x_top_max, p.a_s_y_top_max) / a_s_t ≤ 1' }],
    ['math', L, mm(398), { source: 'p.a_s_min_x = cm^2/m' }],
    ['math', mm(100), mm(398), { source: 'p.a_s_min_x / a_s_xb ≤ 1' }],
    ['plot', L, mm(414), { xExpr: 'x', traces: [{ y: 'p.m_x(x, c/2)', style: 'line' }, { y: 'p.m_x(x, 1.2 m)', style: 'line' }], xmin: '0 m', xmax: 'L_x', xUnit: 'm', yUnit: 'kN*m/m', title: 'm_x along the column line y = c/2 and at y = 1.2 m (ULS)', width: mm(130), height: mm(58) }],
  ]);
}

/** A spring (coil), a bolt with a modeled M12 thread and a pipe swept along a bent path. */
function sweepDesign(): CadDesign {
  // hexagon head, 18 across flats
  const e = 18 / Math.sqrt(3);
  const head = outline('h', [0, 1, 2, 3, 4, 5].map((k) => [e * Math.cos((k * Math.PI) / 3), e * Math.sin((k * Math.PI) / 3)] as [number, number]));
  const shank = rings('s', [[12, '12 mm']]);
  // the pipe's path on XZ: up 80, a quarter bend of radius R_b, on 80
  const path: CadSketch = {
    points: [{ id: 'q0', x: 0, y: 0 }, { id: 'q1', x: 0, y: 80 }, { id: 'qc', x: 40, y: 80 }, { id: 'q2', x: 40, y: 120 }, { id: 'q3', x: 120, y: 120 }],
    entities: [
      { id: 'pl0', type: 'line', p1: 'q0', p2: 'q1' },
      { id: 'pa', type: 'arc', c: 'qc', p1: 'q2', p2: 'q1' },
      { id: 'pl1', type: 'line', p1: 'q2', p2: 'q3' },
    ],
    constraints: [
      { id: 'pf', type: 'fix', refs: ['q0'], at: { x: 0, y: 0 } },
      { id: 'pv', type: 'vertical', refs: ['pl0'] }, { id: 'ph', type: 'horizontal', refs: ['pl1'] },
      { id: 'pt0', type: 'tangent', refs: ['pl0', 'pa'] }, { id: 'pt1', type: 'tangent', refs: ['pa', 'pl1'] },
      { id: 'pd0', type: 'length', refs: ['pl0'], value: '80 mm' }, { id: 'pd1', type: 'length', refs: ['pl1'], value: '80 mm' },
      { id: 'pr', type: 'radius', refs: ['pa'], value: 'R_b', name: 'R_b' },
    ],
  };
  return {
    version: 2,
    components: [
      {
        id: 'cs', name: 'Spring', color: '#7f8fa6',
        items: [{ kind: 'coil', id: 'fs1', name: 'Coil1', plane: 'XY', mode: 'revs-pitch', d: 'D_s', revs: 'n_s', pitch: 'p_s', section: 'circle', size: 'd_w', op: 'new' }],
      },
      {
        id: 'cb', name: 'Bolt', color: '#b8a27a',
        items: [
          { kind: 'sketch', id: 'sb1', name: 'Head', plane: { ref: 'XY' }, sketch: head },
          { kind: 'extrude', id: 'fb1', name: 'Head', sketch: 'sb1', extent: { type: 'one', d: '7.5 mm', dir: '+' }, op: 'new' },
          { kind: 'sketch', id: 'sb2', name: 'Shank', plane: { ref: 'XY', offset: '7.5 mm' }, sketch: shank },
          { kind: 'extrude', id: 'fb2', name: 'Shank', sketch: 'sb2', extent: { type: 'one', d: 'l_b', dir: '+' }, op: 'join' },
          {
            kind: 'thread', id: 'fb3', name: 'Thread1', size: 'M12', length: 'b_t', modeled: true,
            faces: [{ kind: 'face', body: 'fb1', key: 'fb2/side:sk0', hint: { p: [0, 0, 32.5], d: [0, 0, 1], type: 'cylinder', r: 6, size: 2 * Math.PI * 6 * 50 } }],
          },
        ],
      },
      {
        id: 'cp', name: 'Pipe', color: '#90be6d',
        items: [
          { kind: 'sketch', id: 'sp1', name: 'Path', plane: { ref: 'XZ' }, sketch: path },
          { kind: 'plane', id: 'pp1', name: 'Plane1', def: { type: 'path', curve: 'sp1/pl0', at: '0' } },
          { kind: 'sketch', id: 'sp2', name: 'Section', plane: { frame: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0] }, datum: 'pp1', label: 'Plane1' }, sketch: rings('t', [[20, 'D_p'], [16, 'D_p - 2 t_p']]) },
          { kind: 'sweep', id: 'fp1', name: 'Pipe', sketch: 'sp2', path: { kind: 'sketch', sketch: 'sp1' }, op: 'new' },
        ],
      },
    ],
    occurrences: [
      { id: 'os', component: 'cs', grounded: true },
      { id: 'ob', component: 'cb', grounded: true, pos: [70, 0, 0] },
      { id: 'op', component: 'cp', grounded: true, pos: [120, 0, 0] },
    ],
    joints: [],
  };
}

export function sweepExample(): Worksheet {
  return build('CAD: sweeps, coils, threads', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Sweeps, coils and threads\nA compression spring made with **Coil**, an M12 bolt with a **modeled thread**, and a pipe **swept** along a bent path, its section sketched on a **construction plane** square to the path. Change a value and the parts follow; the spring rate and the bolt\'s tensile resistance use the parts\' own data.' }],
    ['math', L, mm(48), { source: 'D_s := 30 mm' }],
    ['math', mm(55), mm(48), { source: 'd_w := 3 mm' }],
    ['math', mm(90), mm(48), { source: 'p_s := 8 mm' }],
    ['math', mm(125), mm(48), { source: 'n_s := 6' }],
    ['math', L, mm(60), { source: 'l_b := 50 mm' }],
    ['math', mm(55), mm(60), { source: 'b_t := 30 mm' }],
    ['math', mm(90), mm(60), { source: 'D_p := 20 mm' }],
    ['math', mm(125), mm(60), { source: 't_p := 2 mm' }],
    ['math', mm(160), mm(60), { source: 'R_b := 40 mm' }],
    ['cad', L, mm(72), { name: 'sw', width: mm(170), height: mm(90), mode: '3d', view3d: { yaw: -35, pitch: 25 }, density: '7850 kg/m^3', design: sweepDesign() }],
    ['text', L, mm(168), { width: mm(80), markdown: '**Spring** (EN 13906-1): rate k = G d⁴ / (8 D³ n) with G = 81.5 GPa for spring steel wire.' }],
    ['math', mm(105), mm(168), { source: 'k_s := 81.5 GPa * d_w^4 / (8 * D_s^3 * n_s) = N/mm' }],
    ['math', mm(105), mm(182), { source: 'sw.Spring.m = g' }],
    ['text', L, mm(194), { width: mm(80), markdown: '**Bolt** 8.8 (EN 1993-1-8, Table 3.4): F_t,Rd = k₂ f_ub A_s / γ_M2, A_s from the thread.' }],
    ['math', mm(105), mm(194), { source: 'sw.Bolt.Thread1.As = mm^2' }],
    ['math', mm(105), mm(206), { source: 'F_tRd := 0.9 * 800 MPa * sw.Bolt.Thread1.As / 1.25 = kN' }],
    ['text', L, mm(224), { width: mm(80), markdown: '**Pipe**: the swept volume against the annulus times the length of the path (two straights and a quarter bend).' }],
    ['math', mm(105), mm(224), { source: 'sw.Pipe.V = cm^3' }],
    ['math', mm(105), mm(236), { source: 'π / 4 * (D_p^2 - (D_p - 2 t_p)^2) * (160 mm + π / 2 * R_b) = cm^3' }],
    ['math', mm(105), mm(252), { source: 'sw.Pipe.m = g' }],
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
  { name: 'Beams and frames', make: beamExample },
  { name: 'Steel beam check (sections, checks)', make: steelCheckExample },
  { name: 'Python code', make: pythonExample },
  { name: 'CAD part design (parametric)', make: cadExample },
  { name: 'CAD: shells, roundings, lofts', make: shapingExample },
  { name: 'CAD: sweeps, coils, threads', make: sweepExample },
  { name: 'Bridge girder: influence lines, LM1', make: bridgeExample },
  { name: '3-D steel frame', make: frame3dExample },
  { name: 'Flat slab with an opening (plate)', make: plateExample },
  { name: 'Differential equations (odesolve)', make: odeExample },
  { name: 'CAD: splines, ellipses, text, projected edges', make: curvesExample },
];

// ---------------------------------------------------------------- areas, protection, symbolic units

export function areasExample(): Worksheet {
  const ws = build('Areas, protection, units in symbolics', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Areas, protection and units in symbolics\nSelect regions and right-click → **Group into area** to fold intermediate steps away (click ▸ to open it again). **Protect worksheet** (file menu ▾) leaves only the regions marked as inputs — dashed while protected — editable. `→` keeps units.' }],
    ['text', L, mm(42), { width: mm(170), markdown: '## Glulam beam GL24h, simply supported (EN 1995-1-1)' }],
    ['math', L, mm(54), { source: 'L := 6 m', input: true }],
    ['math', mm(65), mm(54), { source: 'q := 12 kN/m', input: true }],
    ['math', mm(110), mm(54), { source: 'b := 200 mm', input: true }],
    ['math', mm(150), mm(54), { source: 'h := 400 mm', input: true }],
    ['area', mm(13), mm(66), { title: 'Section, moment and design strength', height: mm(48) }],
    ['math', L, mm(76), { source: 'W := b * h^2 / 6 = cm^3' }],
    ['math', mm(100), mm(76), { source: 'M_Ed := q * L^2 / 8 = kN*m' }],
    ['math', L, mm(92), { source: 'k_mod := 0.8' }],
    ['math', mm(55), mm(92), { source: 'γ_M := 1.25' }],
    ['math', mm(100), mm(92), { source: 'f_md := k_mod * 24 MPa / γ_M = MPa' }],
    ['math', L, mm(122), { source: 'σ_md := M_Ed / W = MPa' }],
    ['math', mm(90), mm(122), { source: 'σ_md ≤ f_md' }],
    ['text', L, mm(140), { width: mm(170), markdown: '## Units in symbolic results\nNumbers with units come out as `=` shows them; symbols keep their units; mismatched units are an error.' }],
    ['math', L, mm(160), { source: 'q * L^2 / 8 →' }],
    ['math', mm(100), mm(160), { source: '1 m + 10 cm →' }],
    ['math', L, mm(174), { source: 'x * kN/m + 2 kN/m →' }],
    ['math', mm(100), mm(174), { source: 'sqrt(4 m^2) →' }],
    ['math', L, mm(188), { source: 'y(t) := 5 m/s^2 * t^2' }],
    ['math', mm(100), mm(188), { source: "y'(t) →" }],
  ]);
  // the intermediate steps start folded away
  return collapseArea(ws, ws.regions.find((r) => r.kind === 'area')!.id);
}

EXAMPLES.push({ name: 'Areas, protection, units in symbolics', make: areasExample });

// ---------------------------------------------------------------- Excel: spreadsheet component, tables

export function excelExample(): Worksheet {
  // a simply supported beam tabulated at x = 0, L/8 … L: M(x) = q x (L − x) / 2, w(x) = q x (L³ − 2 L x² + x³) / (24 E I)
  const cells: Record<string, string> = {
    A1: 'L [m]', A2: 'q [kN/m]', A3: 'EI [kN·m²]', C1: 'M max [kN·m]', C2: 'w max [mm]', C3: 'w max / L',
    D1: '=MAX(B6:B14)', D2: '=MAX(C6:C14)*1000', D3: '=TEXT(D2/1000/B1,"0.0000")',
    A5: 'x [m]', B5: 'M [kN·m]', C5: 'w [m]', D5: 'V [kN]',
  };
  for (let i = 0; i <= 8; i++) {
    const r = 6 + i;
    cells[`A${r}`] = i === 0 ? '0' : `=A${r - 1}+$B$1/8`;
    cells[`B${r}`] = `=$B$2*A${r}*($B$1-A${r})/2`;
    cells[`C${r}`] = `=$B$2*A${r}*($B$1^3-2*$B$1*A${r}^2+A${r}^3)/(24*$B$3)`;
    cells[`D${r}`] = `=$B$2*($B$1/2-A${r})`;
  }
  const styles: Record<string, { fmt?: string; b?: boolean }> = Object.fromEntries(['A5', 'B5', 'C5', 'D5', 'C1', 'C2', 'C3'].map((k) => [k, { b: true }]));
  for (let i = 6; i <= 14; i++) {
    styles[`B${i}`] = { fmt: '0.00' };
    styles[`C${i}`] = { fmt: '0.000E+00' };
  }
  styles.D1 = { fmt: '0.00', b: true };
  styles.D2 = { fmt: '0.00', b: true };
  return build('Excel: spreadsheet component and tables', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Spreadsheets and Excel files\nA **spreadsheet region** (toolbar → Sheet) is Mathcad\'s Excel component: cells with Excel formulas, worksheet values written into cells in the unit you choose, and cells read back out as variables with units. Click it to edit: type in cells (`=` starts a formula), F2 edits, Ctrl+D fills down, paste ranges from Excel. **Import**, **Link…** (read again when the file changes) and **Export** work with .xlsx files.' }],
    ['math', L, mm(52), { source: 'L := 6 m' }],
    ['math', mm(50), mm(52), { source: 'q := 1.35 * 8 kN/m + 1.5 * 5 kN/m =' }],
    ['math', mm(140), mm(52), { source: 's := section("IPE 300")' }],
    ['math', L, mm(64), { source: 'E := 210 GPa' }],
    ['math', mm(50), mm(64), { source: 'EI := E * s.I_y = kN*m^2' }],
    ['spreadsheet', L, mm(76), {
      width: mm(170), height: 312, sheets: [{ name: 'Beam', cells, styles, widths: { 0: 84, 1: 84, 2: 96, 3: 84 } }], rows: 15, cols: 6,
      inputs: [{ expr: 'L', ref: 'B1', unit: 'm' }, { expr: 'q', ref: 'B2', unit: 'kN/m' }, { expr: 'EI', ref: 'B3', unit: 'kN*m^2' }],
      outputs: [{ name: 'M_max', ref: 'D1', unit: 'kN*m' }, { name: 'w_max', ref: 'D2', unit: 'mm' }, { name: 'x_t', ref: 'A6:A14', unit: 'm' }, { name: 'M_t', ref: 'B6:B14', unit: 'kN*m' }],
    }],
    ['text', L, mm(214), { width: mm(170), markdown: '**Back in the worksheet** the outputs are ordinary variables with units: the design checks and the plot use them.' }],
    ['math', L, mm(226), { source: 'σ := M_max / s.W_el_y = MPa' }],
    ['math', L, mm(242), { source: 'σ ≤ 355 MPa' }],
    ['math', L, mm(256), { source: 'w_max ≤ L / 250' }],
    ['math', mm(110), mm(226), { source: 'M_max / (q * L^2 / 8) =' }],
    ['plot', L, mm(305), { xExpr: 'x_t', traces: [{ y: 'M_t', style: 'both' }], xUnit: 'm', yUnit: 'kN*m', title: 'M from the spreadsheet', width: mm(170), height: mm(55) }],
    ['text', L, mm(370), { width: mm(170), markdown: '## Tables from Excel\nA **table** reads a sheet or a range of an .xlsx (table → *Import Excel…*, or drop the file on the page); a header row such as `F [kN]` gives each column its name and unit, and *Export Excel* writes it back with the units. File menu ▾ → **Export to Excel** writes every variable of the worksheet to a *Results* sheet, with vectors, matrices, tables and spreadsheets on sheets of their own.' }],
    ['table', L, mm(402), { name: 'loads', headers: ['case', 'F', 'a'], units: ['', 'kN', 'm'], cells: [['G', '20', '1.5'], ['Q', '35', '3'], ['wind', '12', '4.5']], columnVars: true }],
    ['math', mm(90), mm(408), { source: 'sum(F) =' }],
    ['math', mm(90), mm(420), { source: 'F * a / L =' }],
  ]);
}

EXAMPLES.push({ name: 'Excel: spreadsheet component and tables', make: excelExample });

// ---------------------------------------------------------------- partial differential equations (Pdesolve)

export function pdeExample(): Worksheet {
  return build('Heat flow in a slab (Pdesolve)', [
    ['text', L, mm(15), { width: mm(170), markdown: '# Heat flow into a concrete slab\nA 200 mm slab at 20 °C has its top face brought to 100 °C and held there; its underside is insulated. The solve block takes the heat equation in Mathcad\'s notation — `T_t` is ∂T/∂t, `T_xx` is ∂²T/∂x² — with the initial temperature and a condition at each face; `Pdesolve` returns T(x, t) with units (method of lines: central differences in x, Radau IIA in t).' }],
    ['math', L, mm(54), { source: 'L := 200 mm' }],
    ['math', mm(56), mm(54), { source: 'α := 7e-7 m^2/s' }],
    ['math', mm(110), mm(54), { source: 'T_0 := 293.15 K' }],
    ['math', mm(150), mm(54), { source: 'T_s := 373.15 K' }],
    ['solve', L, mm(68), { guesses: '', constraints: 'T_t(x, t) = α * T_xx(x, t)\nT(x, 0 s) = T_0\nT(0 m, t) = T_s\nT_x(L, t) = 0 K/m', solver: 'T := Pdesolve(T, x, [0 m, L], t, [0 s, 4 hr])' }],
    ['math', mm(110), mm(72), { source: 'T(50 mm, 1 hr) = degC' }],
    ['math', mm(110), mm(84), { source: 'T(L, 4 hr) = degC' }],
    ['text', L, mm(122), { width: mm(170), markdown: '**Check**: until the heat reaches the underside the slab behaves as a half-space, T = T_s + (T₀ − T_s) erf(x / (2√(α t))).' }],
    ['math', L, mm(134), { source: 'T_e(x, t) := T_s + (T_0 - T_s) * erf(x / (2 sqrt(α t)))' }],
    ['math', L, mm(146), { source: 'T(50 mm, 1 hr) - T_e(50 mm, 1 hr) = K' }],
    ['math', mm(110), mm(146), { source: 'T(20 mm, 15 min) - T_e(20 mm, 15 min) = K' }],
    ['plot', L, mm(162), {
      xExpr: 'x', traces: [{ y: 'T(x, 15 min)', style: 'line' }, { y: 'T(x, 1 hr)', style: 'line' }, { y: 'T(x, 2 hr)', style: 'line' }, { y: 'T(x, 4 hr)', style: 'line' }],
      xmin: '0 m', xmax: 'L', xUnit: 'mm', yUnit: 'degC', title: 'T(x) after 15 min, 1 h, 2 h and 4 h', width: mm(100), height: mm(65),
    }],
    ['plot', mm(122), mm(162), {
      plotType: 'contour', z: '(T(x * 1 m, y * 1 s) - 273.15 K) / (1 K)', traces: [], xmin: '0', xmax: '0.2', ymin: '0', ymax: '14400',
      title: 'T in °C: depth x in m (across), time t in s (up)', width: mm(68), height: mm(65),
    }],
  ]);
}

EXAMPLES.push({ name: 'Heat flow in a slab (Pdesolve)', make: pdeExample });

// ------------------------------------------------------------ CAD sketcher: curves, text, references

/**
 * A plate with an elliptical pocket and a hole dimensioned from one of its edges projected
 * into the hole's sketch, a cam on a closed spline, and a tag with engraved text.
 */
function curvesDesign(): CadDesign {
  const pocket: CadSketch = {
    points: [{ id: 'ec', x: 0, y: 0 }, { id: 'ea', x: 30, y: 0 }],
    entities: [{ id: 'el', type: 'ellipse', c: 'ec', a: 'ea', r: 18 }, { id: 'ex', type: 'line', p1: 'ec', p2: 'ea', construction: true }],
    constraints: [
      { id: 'ef', type: 'fix', refs: ['ec'], at: { x: 0, y: 0 } },
      { id: 'eh', type: 'horizontal', refs: ['ex'] },
      { id: 'eA', type: 'majorRadius', refs: ['el'], value: 'a_e', offset: { x: 0, y: -8 } },
      { id: 'eB', type: 'minorRadius', refs: ['el'], value: 'b_e', offset: { x: -12, y: 0 } },
    ],
  };
  // the plate's right-hand top edge, projected: the hole keeps e_h from it however wide the plate is
  const hole: CadSketch = {
    points: [{ id: 'r1.p0', x: 60, y: -40 }, { id: 'r1.p1', x: 60, y: 40 }, { id: 'hm', x: 60, y: 0 }, { id: 'hc', x: 45, y: 0 }],
    entities: [
      { id: 'r1.e0', type: 'line', p1: 'r1.p0', p2: 'r1.p1', ref: 'r1', construction: true },
      { id: 'hk', type: 'circle', c: 'hc', r: 5 },
      { id: 'hmp', type: 'point', p: 'hm', construction: true },
    ],
    constraints: [
      { id: 'hmid', type: 'midpoint', refs: ['hm', 'r1.e0'] },
      { id: 'hh', type: 'horizontal', refs: ['hc', 'hm'] },
      { id: 'hx', type: 'distanceX', refs: ['hc', 'hm'], value: 'e_h', offset: { x: 0, y: 10 } },
      { id: 'hd', type: 'diameter', refs: ['hk'], value: 'd_h', offset: { x: 4, y: 4 } },
    ],
    sources: [{
      id: 'r1', kind: 'edge', label: 'edge between the end face and the side face of Plate',
      ref: { kind: 'edge', body: 'fq0', key: 'fq0/end|fq0/side:bl1', hint: { p: [60, 0, 10], type: 'line', d: [0, 1, 0], size: 80 } },
    }],
  };
  // a cam: a closed fit spline through fixed points round a bore
  const camPts: [number, number][] = [[40, 0], [18, 26], [-16, 24], [-26, 0], [-16, -24], [18, -26]];
  const cam = rings('m', [[16, 'd_b']], (sk) => {
    camPts.forEach(([x, y], i) => {
      sk.points.push({ id: `mq${i}`, x, y });
      sk.constraints.push({ id: `mf${i}`, type: 'fix', refs: [`mq${i}`], at: { x, y } });
    });
    sk.entities.push({ id: 'ms', type: 'spline', pts: camPts.map((_, i) => `mq${i}`), closed: true });
  });
  const label: CadSketch = {
    points: [{ id: 'tp', x: -22, y: -3.5 }],
    entities: [{ id: 'tx', type: 'text', p: 'tp', text: 'mathstudii', size: 10 }],
    constraints: [{ id: 'tf', type: 'fix', refs: ['tp'], at: { x: -22, y: -3.5 } }],
  };
  return {
    version: 2,
    components: [
      {
        id: 'cpl', name: 'Plate', color: '#8d99ae',
        items: [
          { kind: 'sketch', id: 'sq0', name: 'Base', plane: { ref: 'XY' }, sketch: centredRect('b', 120, 80, 'w_p', 'h_p') },
          { kind: 'extrude', id: 'fq0', name: 'Plate', sketch: 'sq0', extent: { type: 'one', d: 't_p' }, op: 'new' },
          { kind: 'sketch', id: 'sq1', name: 'Pocket', plane: { ref: 'XY', offset: 't_p' }, sketch: pocket },
          { kind: 'extrude', id: 'fq1', name: 'Pocket', sketch: 'sq1', extent: { type: 'one', d: 'd_e' }, op: 'cut' },
          { kind: 'sketch', id: 'sq2', name: 'Hole', plane: { ref: 'XY', offset: 't_p' }, sketch: hole },
          { kind: 'extrude', id: 'fq2', name: 'Hole', sketch: 'sq2', extent: { type: 'all' }, op: 'cut' },
        ],
      },
      {
        id: 'ccm', name: 'Cam', color: '#e9c46a',
        items: [
          { kind: 'sketch', id: 'sm0', name: 'Profile', plane: { ref: 'XY' }, sketch: cam },
          { kind: 'extrude', id: 'fm0', name: 'Cam', sketch: 'sm0', extent: { type: 'one', d: 't_c' }, op: 'new' },
        ],
      },
      {
        id: 'ctg', name: 'Tag', color: '#90be6d',
        items: [
          { kind: 'sketch', id: 'st0', name: 'Blank', plane: { ref: 'XY' }, sketch: centredRect('g', 70, 24, '70 mm', '24 mm') },
          { kind: 'extrude', id: 'ft0', name: 'Blank', sketch: 'st0', extent: { type: 'one', d: '3 mm' }, op: 'new' },
          { kind: 'sketch', id: 'st1', name: 'Label', plane: { ref: 'XY', offset: '3 mm' }, sketch: label },
          { kind: 'extrude', id: 'ft1', name: 'Engrave', sketch: 'st1', extent: { type: 'one', d: '0.8 mm' }, op: 'cut' },
        ],
      },
    ],
    occurrences: [
      { id: 'opl', component: 'cpl', grounded: true },
      { id: 'ocm', component: 'ccm', grounded: true, pos: [120, 0, 0] },
      { id: 'otg', component: 'ctg', grounded: true, pos: [0, -75, 0] },
    ],
    joints: [],
  };
}

export function curvesExample(): Worksheet {
  return build('CAD: splines, ellipses, text, projected edges', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Sketch curves and references\nA plate with an **elliptical** pocket and a hole placed from a **projected edge**, a cam whose outline is a closed **spline**, and a tag with **engraved text**. Make the plate wider: the projected edge moves, and the hole keeps its distance from it.' }],
    ['math', L, mm(42), { source: 'w_p := 120 mm' }],
    ['math', mm(55), mm(42), { source: 'h_p := 80 mm' }],
    ['math', mm(90), mm(42), { source: 't_p := 10 mm' }],
    ['math', mm(125), mm(42), { source: 'e_h := 15 mm' }],
    ['math', mm(160), mm(42), { source: 'd_h := 10 mm' }],
    ['math', L, mm(54), { source: 'a_e := 30 mm' }],
    ['math', mm(55), mm(54), { source: 'b_e := 18 mm' }],
    ['math', mm(90), mm(54), { source: 'd_e := 4 mm' }],
    ['math', mm(125), mm(54), { source: 'd_b := 16 mm' }],
    ['math', mm(160), mm(54), { source: 't_c := 12 mm' }],
    ['cad', L, mm(66), { name: 'cs', width: mm(170), height: mm(90), mode: '3d', view3d: { yaw: -30, pitch: 35 }, density: '7850 kg/m^3', design: curvesDesign() }],
    ['text', L, mm(162), { width: mm(80), markdown: '**Plate**: the box less the elliptical pocket π·a·b·d and the hole, against the solid\'s exact volume.' }],
    ['math', mm(105), mm(162), { source: 'cs.Plate.V = cm^3' }],
    ['math', mm(105), mm(174), { source: 'w_p * h_p * t_p - π * a_e * b_e * d_e - π / 4 * d_h^2 * t_p = cm^3' }],
    ['text', L, mm(190), { width: mm(80), markdown: '**Cam**: the spline profile\'s area (from the sketch) times the thickness, against the solid\'s volume.' }],
    ['math', mm(105), mm(190), { source: 'cs.Cam.Profile.A = cm^2' }],
    ['math', mm(105), mm(202), { source: 'cs.Cam.Profile.A * t_c = cm^3' }],
    ['math', mm(105), mm(214), { source: 'cs.Cam.V = cm^3' }],
    ['text', L, mm(230), { width: mm(80), markdown: '**Tag**: the volume the engraving removed, 0.8 mm deep (the letters\' holes stay).' }],
    ['math', mm(105), mm(230), { source: '70 mm * 24 mm * 3 mm - cs.Tag.V = mm^3' }],
  ]);
}

// ------------------------------------------------------------ CAD drawing: annotations

/**
 * What the flange assembly's drawing says besides its views: the shaft Ø40 g6 with its
 * deviations and a perpendicularity to datum A (the flange's seat), surface textures, the
 * counterbore depth in detail B (between corners of the cut), a general note, balloons with
 * the parts list, and a filled ISO 7200 title block. Picks name the model's faces and
 * edges, so they follow the part when the worksheet changes its sizes.
 */
function flangeDrawingNotes(): Partial<DrawingRegion> {
  const edge = (occ: string, body: string, key: string, p: [number, number, number], type: 'circle', r: number) => ({ occ, ref: { kind: 'edge' as const, body, key, hint: { p, type, d: [0, 0, 1] as [number, number, number], r } } });
  const shaft: DrawPick = { occ: 'os', ref: { kind: 'face', body: 'fs1', key: 'fs1/side:sk0', hint: { p: [0, 0, 90], type: 'cylinder', d: [0, 0, -1], r: 20 } }, snap: 'cyl', shape: { k: 'cyl', x1: 0, y1: 140, x2: 0, y2: -40, r: 20 } };
  const rim: DrawPick = { occ: 'of', ref: { kind: 'face', body: 'ff1', key: 'ff1/side:fk0', hint: { p: [0, 0, 6], type: 'cylinder', d: [0, 0, -1], r: 100 } }, snap: 'cyl', shape: { k: 'cyl', x1: 0, y1: 12, x2: 0, y2: 0, r: 100 } };
  const seat: DrawPick = { ...edge('of', 'ff1', 'ff1/side:fk0|ff1/start', [-100, 0, 0], 'circle', 100), snap: 'line', shape: { k: 'line', x1: -100, y1: 0, x2: 100, y2: 0 } };
  const face: DrawPick = { ...edge('of', 'ff1', 'ff1/end|ff1/side:fk0', [-100, 0, 12], 'circle', 100), snap: 'line', shape: { k: 'line', x1: -100, y1: 12, x2: 100, y2: 12 } };
  const cbTop: DrawPick = { ...edge('of', 'ff1', 'ff1/end|ff3/hole0:cb', [67.5, 0, 12], 'circle', 7.5), snap: 'cut1', shape: { k: 'point', x: 82.5, y: 12 } };
  const cbFloor: DrawPick = { ...edge('of', 'ff1', 'ff3/hole0:cb|ff3/hole0:cbFloor', [67.5, 0, 8], 'circle', 7.5), snap: 'cut1', shape: { k: 'point', x: 82.5, y: 8 } };
  return {
    drawnBy: 'Example', bom: { show: true },
    titleBlock: { owner: 'mathstudii', checkedBy: 'P. Novak', approvedBy: 'M. Weber', revisions: true },
    revisions: [{ rev: 'A', text: 'First issue', date: '2026-10-17', by: 'Example' }],
    // placed on the sheet at 1:2.5 (detail B at 2:1): at another scale they keep their distances on the paper
    annotations: ([
      { id: 'n_d', kind: 'dim', view: 'front', type: 'diameter', a: shaft, text: [62, 112], tol: { kind: 'fit', code: 'g6', show: 'dev' } },
      { id: 'n_g', kind: 'gdt', view: 'front', char: 'perpendicularity', tol: 0.05, dia: true, datums: [{ letter: 'A' }], at: [62, 90], dim: 'n_d' },
      { id: 'n_a', kind: 'datum', view: 'front', letter: 'A', at: [-82, -24], leader: seat },
      { id: 'n_r1', kind: 'surface', view: 'front', param: 'Ra', value: 0.8, process: 'removal', method: 'ground', at: [48, 52], leader: shaft },
      { id: 'n_r2', kind: 'surface', view: 'front', param: 'Ra', value: 3.2, process: 'removal', at: [51, 12], leader: face },
      { id: 'n_cb', kind: 'dim', view: 'det:db', type: 'linear', orient: 'v', a: cbTop, b: cbFloor, text: [90, 10] },
      { id: 'n_n', kind: 'note', view: 'top', text: 'General tolerances ISO 2768-mK\nBreak sharp edges 0.3', at: [-100, -132] },
      { id: 'n_b1', kind: 'balloon', view: 'front', occ: 'of', a: rim, at: [-132, 6] },
      { id: 'n_b2', kind: 'balloon', view: 'front', occ: 'os', a: shaft, at: [-55, 118] },
    ] as Annotation[]).map((a) => ({ ...a, k: a.view.startsWith('det:') ? 2 : 0.4 })),
  };
}

// ------------------------------------------------------------ CAD: assembly motion

/**
 * A link of a linkage: a bar from its pin at the origin to the pin at L along x (both
 * sketch points, the joints' origins), w wide with the pin holes, every size from the
 * worksheet.
 */
function linkBar(p: string, L: number, lExpr: string, w: number, wExpr: string): CadSketch {
  const sk = outline(p, [[-w / 2, -w / 2], [L + w / 2, -w / 2], [L + w / 2, w / 2], [-w / 2, w / 2]]);
  sk.points.push({ id: `${p}o`, x: 0, y: 0 }, { id: `${p}e`, x: L, y: 0 });
  sk.entities.push({ id: `${p}ho`, type: 'circle', c: `${p}o`, r: 3 }, { id: `${p}he`, type: 'circle', c: `${p}e`, r: 3 });
  sk.constraints.push(
    { id: `${p}fo`, type: 'fix', refs: [`${p}o`], at: { x: 0, y: 0 } },
    { id: `${p}h0`, type: 'horizontal', refs: [`${p}l0`] }, { id: `${p}v1`, type: 'vertical', refs: [`${p}l1`] },
    { id: `${p}h2`, type: 'horizontal', refs: [`${p}l2`] }, { id: `${p}v3`, type: 'vertical', refs: [`${p}l3`] },
    { id: `${p}dl`, type: 'distanceX', refs: [`${p}o`, `${p}e`], value: lExpr, offset: { x: 0, y: -w } },
    { id: `${p}dy`, type: 'distanceY', refs: [`${p}o`, `${p}e`], value: '0' },
    { id: `${p}d0`, type: 'distanceX', refs: [`${p}p0`, `${p}o`], value: `(${wExpr})/2` },
    { id: `${p}d1`, type: 'distanceY', refs: [`${p}p0`, `${p}o`], value: `(${wExpr})/2` },
    { id: `${p}d2`, type: 'distanceX', refs: [`${p}e`, `${p}p1`], value: `(${wExpr})/2` },
    { id: `${p}d3`, type: 'distanceY', refs: [`${p}o`, `${p}p3`], value: `(${wExpr})/2` },
    { id: `${p}dh`, type: 'diameter', refs: [`${p}ho`], value: 'd_p' },
    { id: `${p}de`, type: 'diameter', refs: [`${p}he`], value: 'd_p' },
  );
  return sk;
}

/**
 * A four-bar linkage (crank-rocker): the ground bar with the crank and rocker pivots d
 * apart, the crank driven by θ_2, the coupler and rocker pins and the rocker's pivot solved
 * (the loop closes), each link on its own layer with a washer's gap between, and a stop
 * the rocker may hit. A motion study turns the crank once round, tracking the clearance.
 */
export function fourBarDesign(): CadDesign {
  const comp = (id: string, name: string, color: string, L: number, lExpr: string, w: number, wExpr: string, t: string) => ({
    id, name, color, items: [
      { kind: 'sketch' as const, id: `s${id}`, name: `${name}Sketch`, plane: { ref: 'XY' as const }, sketch: linkBar(id, L, lExpr, w, wExpr) },
      { kind: 'extrude' as const, id: `f${id}`, name: `${name}Bar`, sketch: `s${id}`, extent: { type: 'one' as const, d: t, dir: '+' as const }, op: 'new' as const },
    ],
  });
  const stop = rings('st', [[10, 'd_s']], (sk) => {
    sk.points.push({ id: 'sto', x: -60, y: 0 });
    sk.constraints.push({ id: 'stx', type: 'distanceX', refs: ['sto', 'stc'], value: 'r_s', offset: { x: 0, y: -10 } }, { id: 'sty', type: 'distanceY', refs: ['sto', 'stc'], value: '0' });
  });
  const pin = (side: string, sketch: string, point: string) => ({ occ: side, origin: { kind: 'point' as const, sketch, point } });
  return {
    version: 2,
    components: [
      comp('g', 'Ground', '#8fa3bf', 100, 'r_1', 30, '30 mm', 't_g'),
      comp('k', 'Crank', '#e8590c', 40, 'r_2', 12, 'w_l', 't_l'),
      comp('b', 'Coupler', '#2f6fdf', 120, 'r_3', 12, 'w_l', 't_l'),
      comp('r', 'Rocker', '#2f9e44', 80, 'r_4', 12, 'w_l', 't_l'),
      {
        id: 'st', name: 'Stop', color: '#c92a2a', items: [
          { kind: 'sketch', id: 'sst', name: 'StopSketch', plane: { ref: 'XY' }, sketch: stop },
          { kind: 'extrude', id: 'fst', name: 'StopPin', sketch: 'sst', extent: { type: 'one', d: 't_l', dir: '+' }, op: 'new' },
        ],
      },
    ],
    // exploded upwards, each link above the one it hangs on
    occurrences: [
      { id: 'og', component: 'g', grounded: true },
      { id: 'ok', component: 'k', pos: [0, -80, 0], explode: { dir: [0, 0, 1], d: '20 mm' } },
      { id: 'ob', component: 'b', pos: [0, -110, 0], explode: { dir: [0, 0, 1], d: '20 mm' } },
      { id: 'or', component: 'r', pos: [0, -140, 0], explode: { dir: [0, 0, 1], d: '20 mm' } },
      { id: 'ost', component: 'st', pos: [150, 0, 0], explode: { dir: [0, 0, 1], d: '90 mm' } },
    ],
    joints: [
      { id: 'j1', name: 'θ2', type: 'revolute', a: pin('og', 'sg', 'go'), b: pin('ok', 'sk', 'ko'), angle: 'θ_2', offset: 't_g + s_g' },
      { id: 'j2', name: 'Pin_A', type: 'revolute', a: pin('ok', 'sk', 'ke'), b: pin('ob', 'sb', 'bo'), angle: '0', offset: 't_l + s_g', dofs: { angle: { free: true } } },
      { id: 'j3', name: 'Pin_B', type: 'revolute', a: pin('ob', 'sb', 'be'), b: pin('or', 'sr', 're'), angle: '0', offset: 't_l + s_g', dofs: { angle: { free: true } } },
      // the rocker's pivot closes the loop: it starts from where the rocker was assembled
      { id: 'j4', name: 'θ4', type: 'revolute', a: pin('og', 'sg', 'ge'), b: pin('or', 'sr', 'ro'), angle: '0', offset: 't_g + 2 t_l + 3 s_g', dofs: { angle: { free: true, rest: '60 deg' } } },
      // the stop, on a bracket over the ground at the rocker's layer, r_s from its pivot at φ_s
      { id: 'j5', name: 'StopMount', type: 'rigid', a: pin('og', 'sg', 'ge'), b: { occ: 'ost', origin: { kind: 'point', sketch: 'sst', point: 'sto' } }, angle: 'φ_s', offset: 't_g + 2 t_l + 3 s_g' },
    ],
    motions: [{
      id: 'm1', name: 'Sweep', duration: 4, steps: 180, interp: 'linear', clearance: true,
      tracks: [{ joint: 'j1', dof: 'angle', keys: [{ t: 0, v: '0 deg' }, { t: 4, v: '360 deg' }] }],
    }],
  };
}

export function fourBarExample(): Worksheet {
  const ws = build('CAD: four-bar linkage (motion)', [
    ['text', L, mm(12), { width: mm(170), markdown: '# A four-bar linkage in motion\nA crank-rocker after Norton (*Design of Machinery*, §4.5): the ground r_1, the crank r_2 turned by θ_2, the coupler r_3 and the rocker r_4. The coupler’s and the rocker’s pins are **Solved**: the assembly closes the loop. Double-click the part, then on the **Assemble** tab: **Drive** turns the crank by hand, **Motion study** plays a turn with the clearance tracked, **Explode** and **BOM**.' }],
    ['math', L, mm(48), { source: 'r_1 := 100 mm' }],
    ['math', mm(55), mm(48), { source: 'r_2 := 40 mm' }],
    ['math', mm(90), mm(48), { source: 'r_3 := 120 mm' }],
    ['math', mm(125), mm(48), { source: 'r_4 := 80 mm' }],
    ['math', mm(160), mm(48), { source: 'θ_2 := 40 deg' }],
    ['math', L, mm(59), { source: 'w_l := 12 mm' }],
    ['math', mm(55), mm(59), { source: 't_l := 5 mm' }],
    ['math', mm(90), mm(59), { source: 't_g := 8 mm' }],
    ['math', mm(125), mm(59), { source: 's_g := 1 mm' }],
    ['math', mm(160), mm(59), { source: 'd_p := 6 mm' }],
    ['math', L, mm(70), { source: 'd_s := 10 mm' }],
    ['math', mm(55), mm(70), { source: 'r_s := 60 mm' }],
    ['math', mm(90), mm(70), { source: 'φ_s := 140 deg' }],
    ['cad', L, mm(80), { name: 'fb', width: mm(170), height: mm(74), mode: '3d', view3d: { yaw: -10, pitch: 62 }, density: '7850 kg/m^3', design: fourBarDesign() }],
    ['text', L, mm(158), { width: mm(170), markdown: '**Freudenstein’s equation** K₁·cos θ₄ − K₂·cos θ₂ + K₃ = cos(θ₂ − θ₄) holds for the rocker angle the part solved; θ₄ in closed form (open circuit, Norton eq. 4.10) beside it.' }],
    ['math', L, mm(172), { source: 'K_1 := r_1 / r_2' }],
    ['math', mm(55), mm(172), { source: 'K_2 := r_1 / r_4' }],
    ['math', mm(95), mm(172), { source: 'K_3 := (r_2^2 - r_3^2 + r_4^2 + r_1^2) / (2 r_2 r_4)' }],
    ['math', L, mm(186), { source: 'A(θ) := cos(θ) - K_1 - K_2 cos(θ) + K_3' }],
    ['math', mm(100), mm(186), { source: 'C(θ) := K_1 - (K_2 + 1) cos(θ) + K_3' }],
    ['math', L, mm(197), { source: 'θ_4(θ) := 2 atan((2 sin(θ) - sqrt(4 sin(θ)^2 - 4 A(θ) C(θ))) / (2 A(θ))) · 1 rad' }],
    ['math', L, mm(213), { source: 'fb.θ4 = deg' }],
    ['math', mm(55), mm(213), { source: 'θ_4(θ_2) = deg' }],
    ['math', mm(95), mm(213), { source: 'K_1 cos(fb.θ4) - K_2 cos(θ_2) + K_3 - cos(θ_2 - fb.θ4) =' }],
    ['text', L, mm(224), { width: mm(170), markdown: 'The study **Sweep** turns the crank once round in 4 s (181 frames). `fb.Sweep.of.θ4(φ)` is the rocker solved at a crank angle φ, against the closed form:' }],
    ['plot', L, mm(235), { xExpr: 'φ', traces: [{ y: 'fb.Sweep.of.θ4(φ)', style: 'line' }, { y: 'θ_4(φ)', style: 'line' }], xmin: '0 deg', xmax: '360 deg', xUnit: 'deg', yUnit: 'deg', title: 'θ₄(θ₂): the part and Freudenstein', width: mm(110), height: mm(52) }],
    ['text', L, mm(302), { width: mm(170), markdown: '**The stop.** The rocker swings out furthest where crank and coupler fold, |B − O₂| = r_3 − r_2 (Norton §4.4). The stop Ø d_s stands r_s from the rocker’s pivot at φ_s: its clearance from the rocker, against the study’s least clearance (every 2° of the crank; the parts a joint joins are left out). Make φ_s := 132 deg and the study finds the stop in the rocker’s way (red frames, V_int).' }],
    ['math', L, mm(330), { source: 'θ_4max := (π - acos((r_1^2 + r_4^2 - (r_3 - r_2)^2) / (2 r_1 r_4))) * 1 rad = deg' }],
    ['math', L, mm(344), { source: 'c_stop := r_s sin(φ_s - θ_4max) - d_s / 2 - w_l / 2 = mm' }],
    ['math', L, mm(358), { source: 'fb.Sweep.c_min = mm' }],
    ['math', mm(70), mm(358), { source: 'max(fb.Sweep.V_int) = mm^3' }],
    ['text', L, mm(372), { width: mm(170), markdown: '## Exploded drawing\nThe drawing below shows the assembly exploded (each link 20 mm above the one it hangs on) with its parts list: select it and **Add balloons** on the isometric view.' }],
  ]);
  const fb = ws.regions.find((r) => r.kind === 'cad' && r.name === 'fb');
  if (fb) {
    ws.regions.push(createRegion('drawing', L, mm(394), {
      cad: fb.id, title: 'Four-bar linkage', partNo: 'FB-001', sheet: 'A4', exploded: true, dims: false, hidden: false,
      views: { front: false, top: true, side: false, iso: true }, bom: { show: true },
    }));
  }
  return ws;
}

EXAMPLES.push({ name: 'CAD: four-bar linkage (motion)', make: fourBarExample });

// ---------------------------------------------------------------- materials, mass properties, appearance

/** A steel bracket with an aluminium pad (a body of its own material), a glass cover and a POM bush. */
function materialsDesign(): CadDesign {
  return {
    version: 2,
    components: [
      {
        id: 'cb', name: 'Bracket', material: 'S355', appearance: 'powder-anthracite',
        bodyNames: { fb1: 'Plate', fb2: 'Pad' },
        bodyMaterials: { fb2: 'EN AW-6082-T6' }, bodyAppearances: { fb2: 'anodised-red' },
        // the machined top face shows the bare steel under the powder coat
        faceAppearances: [{ face: { kind: 'face', body: 'fb1', key: 'fb1/end', hint: { p: [0, 0, 10], d: [0, 0, 1], type: 'plane' } }, appearance: 'steel-satin' }],
        items: [
          { kind: 'sketch', id: 'sb1', name: 'Base', plane: { ref: 'XY' }, sketch: centredRect('b', 120, 80, 'B', 'H') },
          { kind: 'extrude', id: 'fb1', name: 'Plate', sketch: 'sb1', extent: { type: 'one', d: 't', dir: '+' }, op: 'new' },
          { kind: 'sketch', id: 'sb2', name: 'PadSketch', plane: { ref: 'XY', offset: 't' }, sketch: centredRect('p', 40, 40, 'a_p', 'a_p') },
          { kind: 'extrude', id: 'fb2', name: 'Pad', sketch: 'sb2', extent: { type: 'one', d: 't_p', dir: '+' }, op: 'new' },
        ],
      },
      {
        id: 'cw', name: 'Window', material: 'Glass',
        items: [
          { kind: 'sketch', id: 'sw1', name: 'Pane', plane: { ref: 'XY' }, sketch: centredRect('w', 60, 40, '60 mm', '40 mm') },
          { kind: 'extrude', id: 'fw1', name: 'Pane', sketch: 'sw1', extent: { type: 'one', d: '4 mm', dir: '+' }, op: 'new' },
        ],
      },
      {
        id: 'cu', name: 'Bush', material: 'POM',
        items: [
          { kind: 'sketch', id: 'su1', name: 'Rings', plane: { ref: 'XY' }, sketch: rings('u', [[30, 'D_u'], [16, 'd_u']]) },
          { kind: 'extrude', id: 'fu1', name: 'Bush', sketch: 'su1', extent: { type: 'one', d: 'h_u', dir: '+' }, op: 'new' },
        ],
      },
    ],
    occurrences: [
      { id: 'ob', component: 'cb', grounded: true },
      { id: 'ow', component: 'cw', grounded: true, pos: [0, 0, 16] },
      { id: 'ou', component: 'cu', grounded: true, pos: [42, 0, 10] },
    ],
    joints: [],
  };
}

export function materialsExample(): Worksheet {
  return build('CAD: materials, mass properties, appearance', [
    ['text', L, mm(12), { width: mm(170), markdown: '# Materials and mass properties\nA bracket in **S355** steel (EN 10025-2), powder-coated, with its machined top face bare; an **EN AW-6082-T6** pad, a body of its own material (anodised red); a **glass** cover and a **POM** bush. The masses come from the materials, and the worksheet reads each material’s properties. Double-click the part: **Inspect → Properties** shows the centre of gravity and the principal axes, **Materials** (A) assigns materials and appearances, **Zebra**, **Draft** and **Curvature** analyse the surfaces, **Render** saves a picture.' }],
    ['math', L, mm(62), { source: 'B := 120 mm' }],
    ['math', mm(55), mm(62), { source: 'H := 80 mm' }],
    ['math', mm(90), mm(62), { source: 't := 10 mm' }],
    ['math', mm(125), mm(62), { source: 'a_p := 40 mm' }],
    ['math', mm(160), mm(62), { source: 't_p := 6 mm' }],
    ['math', L, mm(73), { source: 'D_u := 30 mm' }],
    ['math', mm(55), mm(73), { source: 'd_u := 16 mm' }],
    ['math', mm(90), mm(73), { source: 'h_u := 20 mm' }],
    ['cad', L, mm(82), { name: 'bk', width: mm(170), height: mm(78), mode: '3d', view3d: { yaw: -32, pitch: 30 }, density: '', design: materialsDesign() }],
    ['text', L, mm(164), { width: mm(170), markdown: '## Masses from the materials\nThe plate weighs ρ·B·H·t with the density of S355 the part read from its material; the pad with that of 6082-T6, the cover and the bush with glass’s and POM’s.' }],
    ['math', L, mm(184), { source: 'ρ_s := bk.Bracket.Plate.material.rho = kg/m^3' }],
    ['math', mm(110), mm(184), { source: 'bk.Bracket.Pad.material.name =' }],
    ['math', L, mm(197), { source: 'm_plate := ρ_s · B · H · t = kg' }],
    ['math', mm(110), mm(197), { source: 'bk.Bracket.Plate.m = kg' }],
    ['math', L, mm(209), { source: 'bk.Bracket.Pad.material.rho · a_p^2 · t_p = g' }],
    ['math', mm(110), mm(209), { source: 'bk.Bracket.Pad.m = g' }],
    ['math', L, mm(221), { source: 'bk.Bush.material.rho · π/4 · (D_u^2 - d_u^2) · h_u = g' }],
    ['math', mm(120), mm(221), { source: 'bk.Bush.m = g' }],
    ['text', L, mm(237), { width: mm(170), markdown: '## Principal moments and the material’s strength\nThe plate’s largest principal moment is m(B² + H²)/12, about its axis through the centre of gravity normal to it; the radius of gyration is √(I/m). The bracket’s yield strength comes from its material (EN 1993-1-1 Table 3.1).' }],
    ['math', L, mm(265), { source: 'bk.Bracket.Plate.Im3 = kg*cm^2' }],
    ['math', mm(110), mm(265), { source: 'm_plate · (B^2 + H^2) / 12 = kg*cm^2' }],
    ['math', L, mm(279), { source: 'bk.Bracket.Plate.k3 = mm' }],
    ['math', mm(110), mm(279), { source: 'sqrt((B^2 + H^2) / 12) = mm' }],
    ['math', L, mm(305), { source: 'bk.m = kg' }],
    ['math', mm(55), mm(305), { source: 'bk.zg = mm' }],
    ['math', mm(110), mm(305), { source: 'bk.Window.material.E = GPa' }],
    ['math', L, mm(317), { source: 'γ_M0 := 1.0' }],
    ['math', mm(55), mm(317), { source: 'f_yd := bk.Bracket.material.f_y / γ_M0 = MPa' }],
    ['math', mm(140), mm(317), { source: 'bk.S = cm^2' }],
  ]);
}

EXAMPLES.push({ name: 'CAD: materials, mass properties, appearance', make: materialsExample });
