// Sheet metal on the B-rep kernel against hand calculations. Flat lengths of brackets from
// their outer legs: L = (a − t − R) + (b − t − R) + BA with BA = (π/2)(R + K·t) for 90°,
// (R + t)·tan(θ/2) off each leg for other angles. The folded volume against the flat:
//
//   a flange keeps its area, a bend of width w and angle θ is the ring sector between R
//   and R + t, V = θ/2·((R + t)² − R²)·w = θ·w·t·(R + t/2), while its flat strip is BA·w =
//   θ·w·(R + K·t). So V_folded = A_flat·t + Σ θ·w·t²·(1/2 − K): equal for K = 1/2 (the
//   fibre that keeps its length at mid-thickness), and t²(1/2 − K) per unit of θ·w more
//   for a fibre nearer the inside (real sheet thins in the bend; CAD keeps t).
//
// Cut-outs: a hole through a flange lands in the flat where the flange unrolls to; the
// flat DXF's contour has the blank's perimeter and the hole's circumference.
import { describe, expect, it } from 'vitest';
import { circles, rect, single, solve, volumes, watchHandles } from './fixtures';
import { occ } from './kernel';
import { buildResultOcc } from './result';
import { buildDesignOcc } from './build';
import { flatPatternOcc } from './flat';
import { sheetCutoutsOcc } from './sheet';
import { facePlane, type CadDesign, type DesignItem } from '../design';
import type { CadSketch } from '../model';
import { refTo, type TopoRef } from '../topology';
import type { Vec3 } from '../solid';
import { bendAllowance, type FlatPattern, type SheetRules } from '../sheetMetal';
import { flatDxf, flatView } from '../flatExport';
import { layoutSheet } from '../drawingSheet';
import type { Prim } from '../drawing2d';
import type { Unit } from 'mathjs';
import { evaluateWorksheet, type CadResult } from '../../engine/evaluator';
import { createRegion, emptyWorksheet, type CadRegion, type DrawingRegion } from '../../model/types';
import { cadValue } from '../evaluate';

const { PI, tan, sqrt } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.max(Math.abs(want), 1)).toBeLessThan(rel);
const t = 2, R = 2, K = 0.44;
const BA90 = bendAllowance(PI / 2, R, K, t);
const RULES: SheetRules = { t: '2', r: '2', k: '0.44' };

/** Lines end to end through the points (an open profile). */
function lines(p: string, pts: [number, number][]): CadSketch {
  return {
    points: pts.map(([x, y], i) => ({ id: `${p}p${i}`, x, y })),
    entities: pts.slice(1).map((_, i) => ({ id: `${p}l${i}`, type: 'line' as const, p1: `${p}p${i}`, p2: `${p}p${i + 1}` })),
    constraints: [],
  };
}

function part(items: DesignItem[], rules: SheetRules = RULES): CadDesign {
  const d = single(items);
  d.components[0].sheet = rules;
  return d;
}

/** The part evaluated, and the flat pattern of its first sheet-metal body. */
function flatOf(d: CadDesign): { fp: FlatPattern; V: number; res: ReturnType<typeof solve>['res'] } {
  const { res, numbers } = solve(d);
  expect(res.design!.errors).toEqual({});
  const oc = occ()!;
  const built = buildDesignOcc(oc, d, numbers);
  try {
    const cb = built.components.get('c1')!;
    const [id, m] = Object.entries(cb.sheets ?? {})[0];
    const body = cb.bodies.find((b) => b.id === id)!;
    return { fp: flatPatternOcc(oc, body.solid.shape, m), V: volumes(res)[0], res };
  } finally {
    built.free();
  }
}

const at = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;
const bodyOf = (d: CadDesign) => buildResultOcc(occ()!, d, solve(d).numbers).components.c1.bodies[0];

/** A reference to the edge of the part with its middle at p. */
function edgeAt(d: CadDesign, p: Vec3): TopoRef {
  const b = bodyOf(d);
  const e = b.edges.find((q) => at(q.mid, p));
  if (!e) throw new Error(`no edge at ${p}`);
  return refTo('edge', b.id, e);
}

const plate = (w = 50, h = 40): DesignItem[] => [
  { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, w, h) },
  { kind: 'flange', id: 'f1', name: 'Flange1', sketch: 's1' },
];

/** The plate with edge flanges (each on the top edge whose middle is given, made in order). */
function withFlanges(base: DesignItem[], mids: Vec3[], more: Record<string, unknown> = {}, rules = RULES): CadDesign {
  let items = base;
  mids.forEach((mid, i) => {
    const ref = edgeAt(part(items, rules), mid);
    items = [...items, { kind: 'edgeflange', id: `g${i}`, name: `Edge${i}`, edges: [ref], height: '30', ...more } as DesignItem];
  });
  return part(items, rules);
}

const perimeter = (loop: Prim[]) => loop.reduce((s, p) => s + (p.k === 'line' ? Math.hypot(p.x2 - p.x1, p.y2 - p.y1) : p.k === 'arc' ? p.r * (p.a1 - p.a0) : 0), 0);
const width = (fp: FlatPattern) => fp.numbers.box.x1 - fp.numbers.box.x0;

describe('flat lengths of bent parts', () => {
  it('L bracket from an open profile with outer legs a = 30, b = 50: (a − t − R) + (b − t − R) + (π/2)(R + K·t)', () => {
    const d = part([
      { kind: 'sketch', id: 's1', name: 'Profile', plane: { ref: 'XZ' }, sketch: lines('a', [[0, 30], [0, 0], [50, 0]]) },
      { kind: 'flange', id: 'f1', name: 'Flange1', sketch: 's1', width: '40' },
    ]);
    const { fp, res } = flatOf(d);
    near(width(fp), (30 - t - R) + (50 - t - R) + BA90);
    near(width(fp), 76.52389342116930);
    near(fp.numbers.box.y1 - fp.numbers.box.y0, 40);
    expect(fp.numbers.bends).toHaveLength(1);
    near(fp.numbers.bends[0].BA, BA90);
    expect(fp.numbers.bends[0]).toMatchObject({ angle: 90, R: 2, up: true });
    // outside, the legs are a and b
    const box = res.design!.box!;
    near(box.max[0] - box.min[0], 50);
    near(box.max[2] - box.min[2], 30);
    expect(fp.outer).toHaveLength(1);
    near(perimeter(fp.outer[0]), 2 * (76.52389342116930 + 40));
  });

  it('the same bracket as a plate a = 50 and an edge flange 30 high (Inside, to the outer virtual sharp)', () => {
    const d = withFlanges(plate(), [[50, 20, t]]);
    const { fp, res } = flatOf(d);
    near(width(fp), (50 - t - R) + (30 - t - R) + BA90);
    const box = res.design!.box!;
    near(box.max[0], 50);
    near(box.max[2], 30);
  });

  it('positions: Outside puts the inner face on the edge, Adjacent starts the bend at it', () => {
    const outside = flatOf(withFlanges(plate(), [[50, 20, t]], { position: 'outside' }));
    near(width(outside.fp), (50 - R) + (30 - t - R) + BA90);
    near(outside.res.design!.box!.max[0], 50 + t);
    const adjacent = flatOf(withFlanges(plate(), [[50, 20, t]], { position: 'adjacent' }));
    near(width(adjacent.fp), 50 + (30 - t - R) + BA90);
    near(adjacent.res.design!.box!.max[0], 50 + R + t);
  });

  it('U channel 60 wide with legs 25 (two edge flanges): 2(25 − 4) + (60 − 8) + 2·BA, as the open profile U', () => {
    const want = 2 * (25 - t - R) + (60 - 2 * (t + R)) + 2 * BA90;
    const flanged = flatOf(withFlanges(plate(60, 40), [[60, 20, t], [0, 20, t]], { height: '25' }));
    near(width(flanged.fp), want);
    const open = flatOf(part([
      { kind: 'sketch', id: 's1', name: 'Profile', plane: { ref: 'XZ' }, sketch: lines('u', [[0, 25], [0, 0], [60, 0], [60, 25]]) },
      { kind: 'flange', id: 'f1', name: 'Flange1', sketch: 's1', width: '40' },
    ]));
    near(width(open.fp), want);
    expect(open.fp.numbers.bends).toHaveLength(2);
    near(flanged.V, open.V);
    const box = flanged.res.design!.box!;
    near(box.max[0] - box.min[0], 60);
    near(box.max[2] - box.min[2], 25);
  });

  it('a 60° bend: each leg short of its virtual sharp by (R + t)·tan 30°, BA = (π/3)(R + K·t)', () => {
    const c = Math.cos(PI / 3), s = Math.sin(PI / 3);
    const { fp } = flatOf(part([
      { kind: 'sketch', id: 's1', name: 'Profile', plane: { ref: 'XZ' }, sketch: lines('a', [[0, 0], [50, 0], [50 + 30 * c, 30 * s]]) },
      { kind: 'flange', id: 'f1', name: 'Flange1', sketch: 's1', width: '20' },
    ]));
    near(width(fp), 80 - 2 * (R + t) * tan(PI / 6) + (PI / 3) * (R + K * t));
    near(fp.numbers.bends[0].angle, 60);
    // DIN 6935 for comparison: k = 0.65 at r = s
    near(fp.numbers.bends[0].din!.v, (PI / 3) * (R + 0.65 * t / 2) - 2 * (R + t) * tan(PI / 6));
  });

  it('an edge flange at 60°, its height to the outer virtual sharp', () => {
    const { fp } = flatOf(withFlanges(plate(), [[50, 20, t]], { angle: '60', position: 'adjacent' }));
    near(width(fp), 50 + (30 - (R + t) * tan(PI / 6)) + (PI / 3) * (R + K * t));
  });
});

describe('volume against the flat', () => {
  it('K = 1/2: the folded part is the flat area times t, exactly', () => {
    const d = withFlanges(plate(60, 40), [[60, 20, t], [0, 20, t]], { height: '25' }, { t: '2', r: '2', k: '0.5' });
    const { fp, V } = flatOf(d);
    near(V, fp.area * t, 1e-10);
  });

  it('K = 0.44: more by θ·w·t²·(1/2 − K) for each bend', () => {
    const d = withFlanges(plate(60, 40), [[60, 20, t], [0, 20, t]], { height: '25' });
    const { fp, V } = flatOf(d);
    near(V - fp.area * t, 2 * (PI / 2) * 40 * t * t * (0.5 - K), 1e-9);
    near(V, 2 * (25 - 4) * 40 * 2 + (60 - 8) * 40 * 2 + 2 * (PI / 4) * ((R + t) ** 2 - R ** 2) * 40, 1e-10);
  });
});

describe('reliefs, hems and bends', () => {
  it('a flange narrower than its edge: rectangular reliefs t × t beside the bend, in the solid and the flat', () => {
    const d = withFlanges(plate(), [[50, 20, t]], { position: 'adjacent', offset1: '10', offset2: '10' });
    const { fp, V } = flatOf(d);
    const area = 50 * 40 - 2 * t * t + 20 * BA90 + 20 * 26;
    near(fp.area, area, 1e-9);
    near(V, (50 * 40 - 2 * t * t) * t + (PI / 4) * 12 * 20 + 20 * 26 * t, 1e-9);
    // the outline: the plate with two notches, the bend and the flange
    near(perimeter(fp.outer[0]), 2 * 40 + 2 * 50 + 4 * t + 2 * (BA90 + 26));
  });

  it('round reliefs: the slots end in half circles', () => {
    const d = withFlanges(plate(), [[50, 20, t]], { position: 'adjacent', offset1: '10', offset2: '10' }, { ...RULES, relief: 'round' });
    const { fp } = flatOf(d);
    near(fp.area, 50 * 40 - 2 * (t * (t - t / 2) + (PI * (t / 2) ** 2) / 2) + 20 * BA90 + 20 * 26, 1e-9);
  });

  it('an open hem: 180° round half the gap, the flat 50 + π(g/2 + K·t) + (L − g/2 − t)', () => {
    const ref = edgeAt(part(plate()), [50, 20, t]);
    const d = part([...plate(), { kind: 'hem', id: 'h1', name: 'Hem1', edges: [ref], type: 'open', gap: '2', length: '8' }]);
    const { fp, res } = flatOf(d);
    near(width(fp), 50 + PI * (1 + K * t) + (8 - 1 - t));
    const box = res.design!.box!;
    near(box.max[0], 50 + 1 + t);
    near(box.max[2], 2 * (1 + t));
  });

  it('a bend along a sketch line across the plate keeps the flat: 100 × 40 with its bend line at x = 50', () => {
    const d = part([
      ...plate(100, 40),
      { kind: 'sketch', id: 's2', name: 'Line', plane: { ref: 'XY', offset: '2' }, sketch: lines('b', [[50, -5], [50, 45]]) },
      { kind: 'bend', id: 'b1', name: 'Bend1', sketch: 's2', angle: '90' },
    ]);
    const { fp, V, res } = flatOf(d);
    near(fp.area, 4000, 1e-9);
    near(width(fp), 100);
    near(fp.numbers.bends[0].a.x, 50);
    near(V, (4000 - BA90 * 40) * t + (PI / 4) * 12 * 40, 1e-9);
    // half stays flat, the other half stands up (towards the sketch's normal)
    const box = res.design!.box!;
    near(box.max[2], 50 - BA90 / 2 + R + t, 1e-9);
  });

  it('square corner relief where two flanges meet end to end', () => {
    const rules: SheetRules = { ...RULES, corner: 'square' };
    const d = withFlanges(plate(), [[50, 20, t], [25, 40, t]], { position: 'adjacent' }, rules);
    const { fp } = flatOf(d);
    const cs = R + t;
    near(fp.area, 50 * 40 - cs * cs + 40 * BA90 + 40 * 26 + (50 - cs) * BA90 + (50 - cs) * 26, 1e-9);
  });
});

describe('cut-outs in the flat', () => {
  // the L bracket, and a hole Ø6 through its standing flange at y = 20, 17 above the bottom
  const bracket = (): DesignItem[] => {
    const d = withFlanges(plate(), [[50, 20, t]]);
    return d.components[0].items;
  };
  const hole = (z = 17): DesignItem[] => [
    { kind: 'sketch', id: 's9', name: 'Hole', plane: { ref: 'YZ', offset: '50' }, sketch: circles('h', [[20, z, 3]]) },
    { kind: 'extrude', id: 'x9', name: 'Cut', sketch: 's9', extent: { type: 'all', both: true }, op: 'cut' },
  ];

  it('a hole through a flange lands where the flange unrolls to: 46 + BA + (17 − t − R) from the end', () => {
    const { fp, V } = flatOf(part([...bracket(), ...hole()]));
    expect(fp.inner).toHaveLength(1);
    const arcs = fp.inner[0].filter((p): p is Extract<Prim, { k: 'arc' }> => p.k === 'arc');
    expect(arcs.length).toBeGreaterThan(0);
    near(arcs[0].cx, 46 + BA90 + (17 - t - R));
    near(arcs[0].cy, 20);
    near(arcs[0].r, 3);
    near(perimeter(fp.inner[0]), 2 * PI * 3);
    near(fp.area, width(fp) * 40 - PI * 9, 1e-9);
    near(V, flatOf(part(bracket())).V - PI * 9 * t, 1e-9);
    expect(fp.warnings).toEqual([]);
  });

  it('the flat DXF: R12, the contour on OUTER, the hole on INNER, the bend line DASHED on BEND with its note', () => {
    const { fp } = flatOf(part([...bracket(), ...hole()]));
    const dxf = flatDxf(fp, 'mm');
    expect(dxf).toContain('$ACADVER\n1\nAC1009');
    const g = dxf.trim().split('\n');
    const ents: { type: string; layer: string; v: Record<number, string> }[] = [];
    const start = g.findIndex((x, i) => x.trim() === 'ENTITIES' && g[i - 1].trim() === '2');
    for (let i = start + 1; i + 1 < g.length; i += 2) {
      const [c, v] = [+g[i], g[i + 1]];
      if (c === 0) ents.push({ type: v, layer: '', v: {} });
      else if (ents.length) {
        if (c === 8) ents[ents.length - 1].layer = v;
        else ents[ents.length - 1].v[c] = v;
      }
    }
    const len = (e: (typeof ents)[number]) => Math.hypot(+e.v[11] - +e.v[10], +e.v[21] - +e.v[20]);
    const outer = ents.filter((e) => e.layer === 'OUTER');
    near(outer.filter((e) => e.type === 'LINE').reduce((s, e) => s + len(e), 0), 2 * (width(fp) + 40), 1e-9);
    const inner = ents.filter((e) => e.layer === 'INNER');
    const round = inner.reduce((s, e) => s + (e.type === 'CIRCLE' ? 2 * PI * +e.v[40] : e.type === 'ARC' ? ((((+e.v[51] - +e.v[50]) % 360) + 360) % 360 || 360) * (PI / 180) * +e.v[40] : 0), 0);
    near(round, 2 * PI * 3, 1e-9);
    const bend = ents.filter((e) => e.layer === 'BEND');
    expect(bend).toHaveLength(1);
    near(len(bend[0]), 40, 1e-9);
    near(+bend[0].v[10], 46 + BA90 / 2, 1e-9);
    expect(dxf).toMatch(/LAYER\n2\nBEND\n70\n0\n62\n1\n6\nDASHED/);
    expect(ents.find((e) => e.type === 'TEXT')?.v[1]).toBe('UP 90%%d R2');
  });

  it('a hole across a bend is reported, not mapped', () => {
    const { fp } = flatOf(part([...bracket(), ...hole(3)]));
    expect(fp.warnings.join(' ')).toMatch(/Bend1 is cut through/);
  });
});

describe('references on sheet-metal faces', () => {
  it('a sketch on the flange\'s outer face follows it when the flange gets taller; its hole stays in the flat', () => {
    const items = withFlanges(plate(), [[50, 20, t]]).components[0].items;
    const b = bodyOf(part(items));
    // face A of the standing flange: at x = 50
    const face = b.faces.find((f) => f.frame && Math.abs(f.c[0] - 50) < 1e-9 && Math.abs(f.frame.n[0] - 1) < 1e-9)!;
    expect(face.key).toMatch(/^g0\/fl:\w+\/start$/);
    const withHole = (h: string): CadDesign => {
      const its = items.map((i) => (i.kind === 'edgeflange' ? { ...i, height: h } : i));
      return part([...its,
        { kind: 'sketch', id: 's5', name: 'OnFlange', plane: facePlane(b, face, 'flange'), sketch: { points: [{ id: 'q', x: 20, y: 17 }], entities: [{ id: 'e', type: 'point', p: 'q' }], constraints: [] } },
        { kind: 'hole', id: 'h5', name: 'Hole1', sketch: 's5', d: '6', depth: '10', through: true, style: 'simple' },
      ]);
    };
    const lo = flatOf(withHole('30')), hi = flatOf(withHole('40'));
    expect(lo.res.design!.warnings).toEqual({});
    expect(hi.res.design!.warnings).toEqual({});
    const c = (fp: FlatPattern) => fp.inner[0].find((p): p is Extract<Prim, { k: 'arc' }> => p.k === 'arc')!;
    near(c(lo.fp).cx, c(hi.fp).cx);
    near(c(lo.fp).cy, c(hi.fp).cy);
    near(width(hi.fp) - width(lo.fp), 10);
  });

  it('every face, edge and vertex of a flanged part has a name of its own', () => {
    const b = bodyOf(withFlanges(plate(), [[50, 20, t], [25, 40, t]], { position: 'adjacent' }));
    for (const list of [b.faces, b.edges, b.vertices]) {
      const keys = list.map((x) => x.key);
      expect(keys.every((k) => k && !k.includes('?'))).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('worksheet values', () => {
  it('rules from worksheet variables with units; the part exports flat.L, W, A, m (A·t·ρ), n and BA', () => {
    const items = withFlanges(plate(), [[50, 20, t]]).components[0].items;
    const d = part(items, { t: 't_s', r: 'R_i', k: 'K_f' });
    const ws = emptyWorksheet();
    const pre = ['t_s := 2 mm', 'R_i := 0.2 cm', 'K_f := 0.44'].map((src, i) => createRegion('math', 20, 20 + 20 * i, { source: src }));
    const cad = createRegion('cad', 20, 400, { name: 'part', design: d, density: '7850 kg/m^3' }) as CadRegion;
    ws.regions = [...pre, cad];
    const res = evaluateWorksheet(ws).results.get(cad.id) as CadResult;
    expect(res.design!.errors).toEqual({});
    const v = cadValue(cad, res) as { flat: Record<string, Unit | number> };
    const len = (46 + BA90 + 26);
    near((v.flat.L as Unit).toNumber('mm'), len);
    near((v.flat.W as Unit).toNumber('mm'), 40);
    near((v.flat.A as Unit).toNumber('mm^2'), len * 40);
    near((v.flat.m as Unit).toNumber('kg'), len * 40 * 2 * 7850e-9);
    near((v.flat.BA as Unit).toNumber('mm'), BA90);
    expect(v.flat.n).toBe(1);
    expect(v.flat.K).toBe(0.44);
    // the body has it too
    expect(((v as unknown as Record<string, { flat: { n: number } }>).Body1.flat.n)).toBe(1);
  });
});

describe('memory', () => {
  it('the flat pattern and the cut-outs a Bend carries delete the OCCT objects they make', () => {
    const d = part([...withFlanges(plate(), [[50, 20, t]]).components[0].items,
      { kind: 'sketch', id: 's9', name: 'Hole', plane: { ref: 'YZ', offset: '50' }, sketch: circles('h', [[20, 17, 3]]) },
      { kind: 'extrude', id: 'x9', name: 'Cut', sketch: 's9', extent: { type: 'all', both: true }, op: 'cut' }]);
    const { numbers } = solve(d);
    const oc = occ()!;
    const built = buildDesignOcc(oc, d, numbers);
    const cb = built.components.get('c1')!;
    const w = watchHandles(oc);
    try {
      flatPatternOcc(oc, cb.bodies[0].solid.shape, cb.sheets!.g0 ?? Object.values(cb.sheets!)[0]);
      const found = sheetCutoutsOcc(oc, cb.bodies[0].solid.shape, Object.values(cb.sheets!)[0]);
      // the hole Ø6 through the standing flange, and nothing else
      expect(found.cuts.flatMap((c) => c.regions)).toHaveLength(1);
      expect(found.other).toBeLessThan(1e-6);
    } finally {
      w.stop();
      built.free();
    }
    expect(w.undeleted()).toEqual([]);
  });

  void sqrt;
});

describe('features that fail, or that the sheet model must follow', () => {
  it('an edge flange on two edges whose second is gone leaves the plate as it was (solid and flat agree)', () => {
    const ref = edgeAt(part(plate()), [50, 20, t]);
    // the same edge twice: the first flange takes it away, the second finds nothing
    const d = part([...plate(), { kind: 'edgeflange', id: 'g0', name: 'Edge0', edges: [ref, ref], height: '30' } as DesignItem]);
    const { res, numbers } = solve(d);
    expect(res.design!.errors.g0).toMatch(/reference lost/);
    near(volumes(res)[0], 50 * 40 * t, 1e-12);
    const oc = occ()!;
    const built = buildDesignOcc(oc, d, numbers);
    try {
      const cb = built.components.get('c1')!;
      const fp = flatPatternOcc(oc, cb.bodies[0].solid.shape, cb.sheets!.f1);
      // no flange in the model, and no sliver of a bend taken for a cut-out
      near(fp.area, 2000, 1e-12);
      expect(fp.inner).toEqual([]);
    } finally {
      built.free();
    }
  });

  const bendAt50 = (more: DesignItem[]): CadDesign => part([
    ...plate(100, 40), ...more,
    { kind: 'sketch', id: 's2', name: 'Line', plane: { ref: 'XY', offset: '2' }, sketch: lines('b', [[50, -5], [50, 45]]) },
    { kind: 'bend', id: 'b1', name: 'Bend1', sketch: 's2', angle: '90' },
  ]);
  // the plate 100 × 40 bent 90° up at x = 50: (4000 − 40·BA)·t + the quarter ring π/4·(4² − 2²)·40
  const V0 = (4000 - 40 * BA90) * t + (PI / 4) * 12 * 40;

  it('a hole made before a bend goes along, without a warning', () => {
    const { fp, V, res } = flatOf(bendAt50([
      { kind: 'sketch', id: 's8', name: 'H', plane: { ref: 'XY' }, sketch: circles('h', [[80, 20, 3]]) },
      { kind: 'extrude', id: 'x8', name: 'Cut', sketch: 's8', extent: { type: 'all', both: true }, op: 'cut' },
    ]));
    expect(res.design!.warnings).toEqual({});
    near(V, V0 - 9 * PI * t, 1e-9);
    const arc = fp.inner[0].find((p): p is Extract<Prim, { k: 'arc' }> => p.k === 'arc')!;
    near(arc.cx, 80);
    near(arc.cy, 20);
  });

  it('a boss made before a bend is left out, and the bend says so', () => {
    const boss: DesignItem[] = [
      { kind: 'sketch', id: 's7', name: 'B', plane: { ref: 'XY', offset: '2' }, sketch: rect('k', 10, 10, 20, 20) },
      { kind: 'extrude', id: 'x7', name: 'Boss', sketch: 's7', extent: { type: 'one', d: '5' }, op: 'join' },
    ];
    // the boss is there before the bend: 10 × 10 × 5
    near(volumes(solve(part([...plate(100, 40), ...boss])).res)[0], 4000 * t + 500, 1e-12);
    const { V, res } = flatOf(bendAt50(boss));
    expect(res.design!.warnings?.b1).toMatch(/left out/);
    near(V, V0, 1e-9);
  });

  it('a hole across the bend line is refused (it would be cut on one side of the bend only)', () => {
    const d = bendAt50([
      { kind: 'sketch', id: 's8', name: 'H', plane: { ref: 'XY' }, sketch: circles('h', [[50, 20, 3]]) },
      { kind: 'extrude', id: 'x8', name: 'Cut', sketch: 's8', extent: { type: 'all', both: true }, op: 'cut' },
    ]);
    expect(solve(d).res.design!.errors.b1).toMatch(/crosses the bend/);
  });

  it('a moved sheet keeps its flat pattern and its edges: a hole after the move, a flange after that', () => {
    const moved: DesignItem[] = [...plate(), { kind: 'move', id: 'mv', name: 'Move1', bodies: ['f1'], dx: '5', dz: '10' } as DesignItem];
    const ref = edgeAt(part(moved), [55, 20, 10 + t]);
    const d = part([...moved,
      { kind: 'edgeflange', id: 'g0', name: 'Edge0', edges: [ref], height: '30' } as DesignItem,
      { kind: 'sketch', id: 's9', name: 'Hole', plane: { ref: 'XY' }, sketch: circles('h', [[25, 20, 3]]) },
      { kind: 'extrude', id: 'x9', name: 'Cut', sketch: 's9', extent: { type: 'all', both: true }, op: 'cut' },
    ]);
    const { fp, res } = flatOf(d);
    expect(fp.warnings).toEqual([]);
    near(width(fp), (50 - t - R) + BA90 + (30 - t - R));
    const arc = fp.inner[0].find((p): p is Extract<Prim, { k: 'arc' }> => p.k === 'arc')!;
    // the hole at x = 25 of the part is 20 from the plate's start, which moved by 5
    near(arc.cx, 20);
    near(res.design!.box!.max[2], 10 + 30);
  });
});

describe('the drawing of a flat pattern', () => {
  it('its view carries the blank\'s length and width as overall dimensions', () => {
    const { fp } = flatOf(withFlanges(plate(), [[50, 20, t]]));
    const r = createRegion('drawing', 0, 0, { flat: {}, views: { front: false, top: false, side: false, iso: false } }) as DrawingRegion;
    const sheet = layoutSheet(r, { flat: flatView(fp, 'Flat pattern') }, { unit: 'mm', name: 'Part', date: '', overall: false })!;
    const texts = sheet.labels.filter((l) => l.layer === 'DIM').map((l) => l.text);
    expect(texts).toEqual([`${+width(fp).toFixed(2)}`, '40']);
    expect(sheet.inks.some((i) => i.layer === 'BEND')).toBe(true);
  });
});
