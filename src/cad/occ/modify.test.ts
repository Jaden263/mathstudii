// The modify features on the B-rep kernel (fillet, chamfer, shell, draft, press-pull,
// split, move/copy), checked against closed forms: the volume a rounding or a chamfer
// takes off a straight edge is its cross-section times the edge length, a shell is the
// box less its offset inside, a draft takes off a wedge, a press-pull adds a prism.
// Picks are references (topology.ts), so they must follow upstream edits.
import { describe, expect, it } from 'vitest';
import { circles, points, poly, rect, roundedRect, single, solve, volumes, watchHandles, withCircles } from './fixtures';
import { occ, setOccEnabled } from './kernel';
import { buildDesignOcc } from './build';
import { buildResultOcc, builtResultOcc } from './result';
import type { BodyResult, BuildResult } from '../buildResult';
import { facePlane, type CadDesign, type DesignItem, type FilletFeature } from '../design';
import type { CadSketch } from '../model';
import { refTo, refToken, type TopoRef } from '../topology';
import type { Vec3 } from '../solid';

const { PI, tan } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.max(Math.abs(want), 1e-300)).toBeLessThan(rel);

const built = (d: CadDesign, pre: string[] = []): BuildResult => buildResultOcc(occ()!, d, solve(d, pre).numbers);
const bodiesOf = (r: BuildResult, cid = 'c1') => r.components[cid].bodies;
const at = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;

/** Every name of a body is there and different from the others. */
function expectUnique(b: BodyResult) {
  for (const list of [b.faces, b.edges, b.vertices]) {
    const keys = list.map((x) => x.key);
    expect(keys.every((k) => k && !k.includes('?'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  }
}

/**
 * A fully defined a × b rectangle from the origin whose sides are worksheet expressions:
 * line rl0 runs along y = 0, rl1 along x = a.
 */
function dimRect(a: string, b: string): CadSketch {
  const sk = rect('r', 0, 0, 100, 60);
  sk.constraints = [
    { id: 'k0', type: 'fix', refs: ['rp0'], at: { x: 0, y: 0 } },
    { id: 'k1', type: 'horizontal', refs: ['rl0'] }, { id: 'k2', type: 'horizontal', refs: ['rl2'] },
    { id: 'k3', type: 'vertical', refs: ['rl1'] }, { id: 'k4', type: 'vertical', refs: ['rl3'] },
    { id: 'k5', type: 'length', refs: ['rl0'], value: a }, { id: 'k6', type: 'length', refs: ['rl1'], value: b },
  ];
  return sk;
}

/** An a × b × c box from the origin (Extrude1, body f1). */
const box = (a: string | number, b: string | number, c: string | number): DesignItem[] => [
  { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: dimRect(String(a), String(b)) },
  { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: String(c) }, op: 'new' },
];

/** References to the edges or faces of a built body that `pred` picks (edges by midpoint, faces by centroid). */
function edgesAt(items: DesignItem[], ps: Vec3[], pre: string[] = []): TopoRef[] {
  const b = bodiesOf(built(single(items), pre))[0];
  return ps.map((p) => {
    const e = b.edges.find((q) => at(q.mid, p));
    if (!e) throw new Error(`no edge at ${p}`);
    return refTo('edge', b.id, e);
  });
}
function facesAt(items: DesignItem[], ps: Vec3[], pre: string[] = []): TopoRef[] {
  const b = bodiesOf(built(single(items), pre))[0];
  return ps.map((p) => {
    const f = b.faces.find((q) => at(q.c, p));
    if (!f) throw new Error(`no face at ${p}`);
    return refTo('face', b.id, f);
  });
}

/** Evaluate a part: its body volumes and errors. */
function run(items: DesignItem[], pre: string[] = []) {
  const { res } = solve(single(items), pre);
  return { res, V: volumes(res), errors: res.design!.errors, warnings: res.design!.warnings ?? {}, bodies: res.design!.bodies.c1 };
}

// the top front edge of a 100 × 60 × 10 box: along x, at y = 0, z = 10
const TOP_FRONT: Vec3 = [50, 0, 10];

describe('fillet', () => {
  it('a straight edge of length L, radius r, takes off (1 − π/4) r² L', () => {
    // the rounding replaces an r × r corner by a quarter circle: (r² − πr²/4) per unit length
    const items = box(100, 60, 10);
    const edges = edgesAt(items, [TOP_FRONT]);
    const { V, errors } = run([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: '3' }] }]);
    expect(errors).toEqual({});
    near(V[0], 100 * 60 * 10 - (1 - PI / 4) * 9 * 100);
  });

  it('several sets with their own radii; the rounding faces are named after the picked edges', () => {
    const items = box(100, 60, 10);
    const [front, back] = edgesAt(items, [TOP_FRONT, [50, 60, 10]]);
    const f: FilletFeature = { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [front], r: '2' }, { edges: [back], r: '4 mm' }] };
    const d = single([...items, f]);
    const { V, errors } = run(d.components[0].items);
    expect(errors).toEqual({});
    near(V[0], 60000 - (1 - PI / 4) * (4 + 16) * 100);
    const b = bodiesOf(built(d))[0];
    expectUnique(b);
    // the UI finds the pick again from its rounding: f2/round:<token of the reference>
    const round = b.faces.find((q) => q.key === `f2/round:${refToken(back)}`)!;
    expect(round.type).toBe('cylinder');
    near(round.radius!, 4);
    near(round.area, (PI / 2) * 4 * 100);
  });

  it('follows its edge when the base gets longer (a dimension upstream)', () => {
    // the edge was picked on a 100 long base; L = 150 rebuilds it 150 long and the reference finds it
    const pre = (L: number) => [`L := ${L} mm`];
    const items = box('L', 60, 10);
    const edges = edgesAt(items, [TOP_FRONT], pre(100));
    const all: DesignItem[] = [...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: '3' }] }];
    for (const L of [100, 150]) {
      const { V, errors, warnings } = run(all, pre(L));
      expect(errors).toEqual({});
      expect(warnings).toEqual({});
      near(V[0], L * 60 * 10 - (1 - PI / 4) * 9 * L);
    }
    // still the front edge, not some other edge of the same length
    const b = bodiesOf(built(single(all), pre(150)))[0];
    const round = b.faces.find((q) => q.key.startsWith('f2/round:'))!;
    near(round.c[0], 75);
    expect(round.c[1]).toBeLessThan(3);
  });

  it('the tangent chain of a rounded box: Pappus round the corners', () => {
    // a 100 × 60 × 10 box with R = 5 vertical corners; one picked top edge rounds the whole
    // outline: the section A = (1 − π/4) r² swept along 2(100 − 2R) + 2(60 − 2R) straight and
    // round the corners at the radius of its centroid, R − r(10 − 3π)/(3(4 − π)) (Pappus)
    const R = 5, r = 2;
    const items: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: roundedRect('a', 100, 60, R) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ];
    const edges = edgesAt(items, [TOP_FRONT]);
    const A = (1 - PI / 4) * r * r;
    const rho = R - (r * (10 - 3 * PI)) / (3 * (4 - PI));
    const V0 = 100 * 60 * 10 - (4 - PI) * R * R * 10;
    const { V, errors } = run([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: String(r) }] }]);
    expect(errors).toEqual({});
    near(V[0], V0 - A * (2 * (100 - 2 * R) + 2 * (60 - 2 * R) + 2 * PI * rho), 1e-7);
    // the eight roundings of the chain are named after the one picked edge, told apart by place
    const b = bodiesOf(built(single([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: String(r) }] }])))[0];
    expectUnique(b);
    expect(b.faces.filter((q) => q.key.startsWith(`f2/round:${refToken(edges[0])}#`))).toHaveLength(8);
    // without the chain OpenCascade cannot round only the picked edge: it says so
    const off = run([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: String(r) }], chain: false }]);
    expect(off.errors.f2).toMatch(/tangent edges.*7 more.*Tangent chain/);
    near(off.V[0], V0);
  });

  it('a variable radius goes from the start (the end with the smaller x) to the end', () => {
    // r from 2 to 6 along the edge: the volume lies between the constant fillets of 2 and of 6, near
    // (1 − π/4) ∫ r² dx = (1 − π/4) L (r1² + r1 r2 + r2²)/3 (a cross-section at every x)
    const items = box(100, 60, 10);
    const edges = edgesAt(items, [TOP_FRONT]);
    const all = [...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: '2', r2: '6' }] } as FilletFeature];
    const { V, errors } = run(all);
    expect(errors).toEqual({});
    const k = (1 - PI / 4) * 100;
    expect(V[0]).toBeLessThan(60000 - k * 4);
    expect(V[0]).toBeGreaterThan(60000 - k * 36);
    near(V[0], 60000 - (k * (4 + 12 + 36)) / 3, 2e-4);
    // the rounding is wider where x is larger: its area centroid lies past the middle,
    // ∫x r dx / ∫r dx = 58.3 for a linear r
    const round = bodiesOf(built(single(all)))[0].faces.find((q) => q.key.startsWith('f2/round:'))!;
    expect(round.c[0]).toBeGreaterThan(56);
  });

  it('two edges meeting at a corner (the third edge sharp): the overlap of the two cuts, r³(5/3 − π/2), counts once', () => {
    // each rounding takes off (1 − π/4) r² L; near the corner both cut the cube r³ where a point is outside
    // both quarter circles: at depth s = r − w below the top, u, v < r − √(r² − s²), so the overlap is
    // ∫₀ʳ (r − √(r² − s²))² ds = r³ (5/3 − π/2) (the roundings mitre, each as if alone)
    const r = 4;
    const items = box(100, 60, 40);
    const edges = edgesAt(items, [[50, 0, 40], [100, 30, 40]]);
    const { V, errors } = run([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: String(r) }] }]);
    expect(errors).toEqual({});
    near(V[0], 240000 - (1 - PI / 4) * r * r * (100 + 60) + r ** 3 * (5 / 3 - PI / 2));
  });

  it('two sets with different radii on one tangent chain are refused (OpenCascade rounds a chain with one radius)', () => {
    const items: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: roundedRect('a', 100, 60, 5) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ];
    const [front, back] = edgesAt(items, [TOP_FRONT, [50, 60, 10]]);
    const fillet = (r2: string): DesignItem => ({ kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [front], r: '2' }, { edges: [back], r: r2 }] });
    const { errors, V } = run([...items, fillet('4')]);
    expect(errors.f2).toBe('an edge of set 2 is on the tangent chain of set 1, which is rounded with one radius: pick it in that set');
    near(V[0], 100 * 60 * 10 - (4 - PI) * 25 * 10);
    // the same radius twice is no conflict
    expect(run([...items, fillet('2 mm')]).errors).toEqual({});
  });

  it('round edges: the top circle of a cylinder, rounded or chamfered (Pappus)', () => {
    // the section (1 − π/4) r² (fillet) or d²/2 (chamfer) swept round the axis at the radius of its
    // centroid: R − r(10 − 3π)/(3(4 − π)) for the fillet's, R − d/3 for the chamfer's triangle
    const R = 20, h = 30, r = 4, d = 3;
    const cyl: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Disc', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, R]]) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: String(h) }, op: 'new' },
    ];
    const b = bodiesOf(built(single(cyl)))[0];
    const top = refTo('edge', 'f1', b.edges.find((q) => q.circle && Math.abs(q.circle.c[2] - h) < 1e-9)!);
    const V0 = PI * R * R * h;
    const f = run([...cyl, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [top], r: String(r) }] }]);
    expect(f.errors).toEqual({});
    near(f.V[0], V0 - 2 * PI * (R - (r * (10 - 3 * PI)) / (3 * (4 - PI))) * (1 - PI / 4) * r * r);
    const c = run([...cyl, { kind: 'chamfer', id: 'f2', name: 'Chamfer1', edges: [top], type: 'equal', d: String(d) }]);
    expect(c.errors).toEqual({});
    near(c.V[0], V0 - 2 * PI * (R - d / 3) * (d * d) / 2);
  });

  it('a radius too large says which edge and about how large it may be', () => {
    // the side face under the edge is 10 high: a rounding of 10 or more does not fit
    const items = box(100, 60, 10);
    const edges = edgesAt(items, [TOP_FRONT]);
    const { V, errors } = run([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: '12' }] }]);
    expect(errors.f2).toBe('radius 12 mm is too large for the edge between the end face and the side face of Extrude1 (max ≈ 10 mm)');
    // the body stays as it was
    near(V[0], 60000);
  });

  it('a lost edge is an error; one of several lost is a warning', () => {
    // a boss on top whose edge is rounded, then the boss is suppressed
    const items: DesignItem[] = [...box(100, 60, 10),
      { kind: 'sketch', id: 's2', name: 'Top', plane: { ref: 'XY', offset: '10' }, sketch: rect('b', 20, 20, 40, 40) },
      { kind: 'extrude', id: 'f2', name: 'Boss', sketch: 's2', extent: { type: 'one', d: '5' }, op: 'join' },
    ];
    const [boss, base] = edgesAt(items, [[30, 20, 15], TOP_FRONT]);
    const fillet = (edges: TopoRef[]): DesignItem => ({ kind: 'fillet', id: 'f3', name: 'Fillet1', sets: [{ edges, r: '1' }] });
    const gone = (i: DesignItem) => (i.id === 'f2' ? { ...i, suppressed: true } : i);
    const one = run([...items.map(gone), fillet([boss])]);
    expect(one.errors.f3).toBe('reference lost: the edge between the end face and the side face of Boss is gone');
    const two = run([...items.map(gone), fillet([boss, base])]);
    expect(two.errors.f3).toBeUndefined();
    expect(two.warnings.f3).toMatch(/^reference lost: the edge between the end face and the side face of Boss is gone; the other edges are still rounded/);
    near(two.V[0], 60000 - (1 - PI / 4) * 100);
  });

  it('suppressed or rolled back, it is as if it were not there', () => {
    const items = box(100, 60, 10);
    const edges = edgesAt(items, [TOP_FRONT]);
    const f: DesignItem = { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: '3' }] };
    near(run([...items, { ...f, suppressed: true }]).V[0], 60000);
    const { res } = solve({ ...single([...items, f]), components: [{ id: 'c1', name: 'Part', items: [...items, f], marker: 2 }] });
    near(volumes(res)[0], 60000);
  });
});

describe('chamfer', () => {
  const items = box(100, 60, 10);
  const edges = edgesAt(items, [TOP_FRONT]);
  const chamfer = (o: Partial<Extract<DesignItem, { kind: 'chamfer' }>>): DesignItem => ({ kind: 'chamfer', id: 'f2', name: 'Chamfer1', edges, type: 'equal', d: '3', ...o });

  it('equal distances d take off d² L / 2', () => {
    const { V, errors } = run([...items, chamfer({})]);
    expect(errors).toEqual({});
    near(V[0], 60000 - (9 / 2) * 100);
  });

  it('two distances a, b take off a b L / 2, a on the face first by name (flip: the other)', () => {
    // the triangle a × b; d (= a = 2) is measured on the top face f1/end, d2 (= b = 5) down the side
    for (const flip of [false, true]) {
      const all = [...items, chamfer({ type: 'two', d: '2', d2: '5', flip: flip || undefined })];
      const { V, errors } = run(all);
      expect(errors).toEqual({});
      near(V[0], 60000 - (2 * 5 / 2) * 100);
      const top = bodiesOf(built(single(all)))[0].faces.find((q) => q.key === 'f1/end')!;
      near(top.area, 100 * (60 - (flip ? 5 : 2)));
    }
  });

  it('a distance d and an angle θ from its face take off d² tan θ L / 2', () => {
    const { V, errors } = run([...items, chamfer({ type: 'angle', d: '3', angle: '30 deg' })]);
    expect(errors).toEqual({});
    near(V[0], 60000 - (9 * tan(PI / 6) / 2) * 100);
  });

  it('a distance wider than the face says so', () => {
    const { errors } = run([...items, chamfer({ type: 'two', d: '2', d2: '11' })]);
    expect(errors.f2).toBe('a chamfer distance of 11 mm is too large for the edge between the end face and the side face of Extrude1 (max ≈ 10 mm)');
  });
});

describe('shell', () => {
  const a = 100, b = 60, c = 40, t = 3;
  const items = box(a, b, c);
  const top = facesAt(items, [[50, 30, 40]]);

  it('the top removed, walls inside: abc − (a − 2t)(b − 2t)(c − t)', () => {
    const all: DesignItem[] = [...items, { kind: 'shell', id: 'f2', name: 'Shell1', faces: top, t: String(t), side: 'inside' }];
    const { V, errors } = run(all);
    expect(errors).toEqual({});
    near(V[0], a * b * c - (a - 2 * t) * (b - 2 * t) * (c - t));
    const body = bodiesOf(built(single(all)))[0];
    expectUnique(body);
    // the floor inside is the offset of the bottom face, t up
    const floor = body.faces.filter((q) => q.key.startsWith('f2/in:') && q.frame && Math.abs(q.frame.n[2] - 1) < 1e-9);
    expect(floor).toHaveLength(1);
    near(floor[0].c[2], t);
  });

  it('walls outside: (a + 2t)(b + 2t)(c + t) − abc', () => {
    const { V, errors } = run([...items, { kind: 'shell', id: 'f2', name: 'Shell1', faces: top, t: String(t), side: 'outside' }]);
    expect(errors).toEqual({});
    near(V[0], (a + 2 * t) * (b + 2 * t) * (c + t) - a * b * c);
  });

  it('no face removed hollows the body: abc − (a − 2t)(b − 2t)(c − 2t)', () => {
    const { V, errors } = run([...items, { kind: 'shell', id: 'f2', name: 'Shell1', faces: [], body: 'f1', t: String(t), side: 'inside' }]);
    expect(errors).toEqual({});
    near(V[0], a * b * c - (a - 2 * t) * (b - 2 * t) * (c - 2 * t));
  });

  it('a body joined from two (a compound of one solid) shells and drafts the same', () => {
    // two 100 × 60 × 20 boxes stacked and joined: the 100 × 60 × 40 box, its sides merged faces
    const stacked: DesignItem[] = [...box(100, 60, 20),
      { kind: 'sketch', id: 's2', name: 'Upper', plane: { ref: 'XY', offset: '20' }, sketch: rect('u', 0, 0, 100, 60) },
      { kind: 'extrude', id: 'f2', name: 'Extrude2', sketch: 's2', extent: { type: 'one', d: '20' }, op: 'join' },
    ];
    const [lid, front] = facesAt(stacked, [[50, 30, 40], [50, 0, 20]]);
    expect(front.key).toBe('f1/side:rl0+f2/side:ul0');
    const shell = run([...stacked, { kind: 'shell', id: 'f3', name: 'Shell1', faces: [lid], t: String(t), side: 'inside' }]);
    expect(shell.errors).toEqual({});
    near(shell.V[0], a * b * c - (a - 2 * t) * (b - 2 * t) * (c - t));
    const draft = run([...stacked, { kind: 'draft', id: 'f3', name: 'Draft1', faces: [front], plane: 'XY', angle: '5 deg' }]);
    expect(draft.errors).toEqual({});
    near(draft.V[0] - a * b * c, (-a * c * c * tan((5 * PI) / 180)) / 2);
  });

  it('an opening tangent to a rounding it keeps: the body less its offset and the opening pushed through', () => {
    // OCCT's thick solid leaves the body as it was when the top is tangent to the rounded top front
    // edge (r = 4). The shell is the rounded body (abc − (1 − π/4) r² a) less its offset inside (the
    // inner box with its edge rounded to r − t) less the top's offset pushed out, (a − 2t)(b − t − r) t:
    // the rounding stays as a lip curving in at the top
    const r = 4;
    const [edge] = edgesAt(items, [[50, 0, 40]]);
    const { V, errors } = run([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [edge], r: String(r) }] },
      { kind: 'shell', id: 'f3', name: 'Shell1', faces: top, t: String(t), side: 'inside' }]);
    expect(errors).toEqual({});
    const k = 1 - PI / 4;
    const body = a * b * c - k * r * r * a;
    const inner = (a - 2 * t) * (b - 2 * t) * (c - 2 * t) - k * (r - t) ** 2 * (a - 2 * t);
    near(V[0], body - inner - (a - 2 * t) * (b - t - r) * t);
  });

  it('the opening tangent to two roundings that meet: body less its offset less the top slab, both cornered', () => {
    // as above with the top front and right edges rounded (r = 4, t = 3): the body is
    // abc − k r² (a + b) + r³ q (q = 5/3 − π/2, the corner), its offset the (a−2t)(b−2t)(c−2t) box
    // rounded to r − t the same way, and the opening's image, (a − t − r) × (b − t − r), cuts the
    // top wall t deep
    const r = 4, k = 1 - PI / 4, q = 5 / 3 - PI / 2;
    const edges = edgesAt(items, [[50, 0, 40], [100, 30, 40]]);
    const { V, errors } = run([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: String(r) }] },
      { kind: 'shell', id: 'f3', name: 'Shell1', faces: top, t: String(t), side: 'inside' }]);
    expect(errors).toEqual({});
    const body = a * b * c - k * r * r * (a + b) + r ** 3 * q;
    const ri = r - t;
    const inner = (a - 2 * t) * (b - 2 * t) * (c - 2 * t) - k * ri * ri * (a - 2 * t + b - 2 * t) + ri ** 3 * q;
    near(V[0], body - inner - (a - t - r) * (b - t - r) * t);
  });

  it('a rounding thinner than the wall vanishes inside: the walls meet at a sharp edge', () => {
    // a vertical edge rounded to r = 2, walls t = 3: the outside keeps the rounding, the cavity is the
    // plain (a − 2t)(b − 2t)(c − t) box (its offset rounding would have the radius r − t < 0)
    const r = 2;
    const [vert, bottom] = edgesAt(items, [[100, 0, 20], [50, 0, 0]]);
    const k = 1 - PI / 4;
    for (const [edge, L] of [[vert, c], [bottom, a]] as const) {
      const rounded: DesignItem[] = [...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [edge], r: String(r) }] }];
      const open = run([...rounded, { kind: 'shell', id: 'f3', name: 'Shell1', faces: top, t: String(t), side: 'inside' }]);
      expect(open.errors).toEqual({});
      near(open.V[0], a * b * c - k * r * r * L - (a - 2 * t) * (b - 2 * t) * (c - t));
      const hollow = run([...rounded, { kind: 'shell', id: 'f3', name: 'Shell1', faces: [], body: 'f1', t: String(t), side: 'inside' }]);
      expect(hollow.errors).toEqual({});
      near(hollow.V[0], a * b * c - k * r * r * L - (a - 2 * t) * (b - 2 * t) * (c - 2 * t));
    }
    // the top front edge (its rounding tangent to the opening) the same way
    const [rim] = edgesAt(items, [[50, 0, 40]]);
    const tangent = run([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [rim], r: String(r) }] },
      { kind: 'shell', id: 'f3', name: 'Shell1', faces: top, t: String(t), side: 'inside' }]);
    expect(tangent.errors).toEqual({});
    near(tangent.V[0], a * b * c - k * r * r * a - (a - 2 * t) * (b - 2 * t) * (c - t));
    // exactly as thick as the rounding: its offset shrinks to an edge, which OpenCascade cannot make
    const same = run([...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [vert], r: String(r) }] },
      { kind: 'shell', id: 'f3', name: 'Shell1', faces: top, t: String(r), side: 'inside' }]);
    expect(same.errors.f3).toBe('a wall of 2 mm as thick as the radius of a rounding cannot be made — make it a little thinner or thicker');
  });

  it('a wall thicker than the body allows is refused', () => {
    const { errors, V } = run([...items, { kind: 'shell', id: 'f2', name: 'Shell1', faces: top, t: '35', side: 'inside' }]);
    expect(errors.f2).toBe('a wall of 35 mm does not fit this body — try a thinner one');
    near(V[0], a * b * c);
  });
});

describe('draft', () => {
  it('a side face of height h, width w turned by θ about its bottom edge: ΔV = −w h² tan θ / 2', () => {
    // the front face (y = 0) of a 100 × 60 × 40 box leans in by h tan θ at the top; neutral plane XY, pull +Z
    const w = 100, h = 40, th = (5 * PI) / 180;
    const items = box(w, 60, h);
    const faces = facesAt(items, [[50, 0, 20]]);
    for (const [angle, sign] of [['5 deg', 1], ['-5 deg', -1]] as const) {
      const all: DesignItem[] = [...items, { kind: 'draft', id: 'f2', name: 'Draft1', faces, plane: 'XY', angle }];
      const { V, errors } = run(all);
      expect(errors).toEqual({});
      near(V[0] - w * 60 * h, (-sign * w * h * h * tan(th)) / 2, 1e-9);
      // the drafted face keeps its name, tilted by θ
      const front = bodiesOf(built(single(all)))[0].faces.find((q) => q.key === 'f1/side:rl0')!;
      expect(front.frame!.n[2]).toBeCloseTo(sign * Math.sin(th), 12);
    }
  });

  it('about a mid-height neutral plane a flat face takes off as much as it adds; four sides: ∫(w − 2kz)(b − 2kz) dz', () => {
    // neutral plane z = h/2 (a sketch plane): the face turns about its middle, ΔV = 0. All four sides
    // drafted about z = 0: the section at height z is (w − 2kz)(b − 2kz), k = tan θ, so
    // V = w b h − k (w + b) h² + 4 k² h³ / 3
    const w = 100, b = 60, h = 40, k = tan((5 * PI) / 180);
    const items: DesignItem[] = [...box(w, b, h), { kind: 'sketch', id: 's2', name: 'Mid', plane: { ref: 'XY', offset: String(h / 2) }, sketch: rect('q', 0, 0, 1, 1) }];
    const [front, back, left, right] = facesAt(items, [[50, 0, 20], [50, 60, 20], [0, 30, 20], [100, 30, 20]]);
    const mid = run([...items, { kind: 'draft', id: 'f2', name: 'Draft1', faces: [front], plane: 's2', angle: '5 deg' }]);
    expect(mid.errors).toEqual({});
    near(mid.V[0], w * b * h);
    const four = run([...items, { kind: 'draft', id: 'f2', name: 'Draft1', faces: [front, back, left, right], plane: 'XY', angle: '5 deg' }]);
    expect(four.errors).toEqual({});
    near(four.V[0], w * b * h - k * (w + b) * h * h + (4 * k * k * h ** 3) / 3);
  });

  it('flip pulls the other way; the neutral plane can be a picked face', () => {
    // neutral plane: the top face (z = 40), pulled down (flip): the face leans out at the bottom
    const items = box(100, 60, 40);
    const [front, top] = facesAt(items, [[50, 0, 20], [50, 30, 40]]);
    const { V, errors } = run([...items, { kind: 'draft', id: 'f2', name: 'Draft1', faces: [front], plane: top, flip: true, angle: '5 deg' }]);
    expect(errors).toEqual({});
    near(V[0] - 240000, (-100 * 1600 * tan((5 * PI) / 180)) / 2);
  });
});

describe('press-pull', () => {
  const items = box(100, 60, 10);
  const top = facesAt(items, [[50, 30, 10]]);

  it('the top face out by d adds A d, in by d takes it off; the face keeps its name', () => {
    for (const d of [5, -4]) {
      const all: DesignItem[] = [...items, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: top, d: String(d) }];
      const { V, errors } = run(all);
      expect(errors).toEqual({});
      near(V[0], 60000 + 6000 * d);
      const b = bodiesOf(built(single(all)))[0];
      expectUnique(b);
      // still six faces with the names they had (the sides grew with it)
      expect(b.faces.map((q) => q.key).sort()).toEqual(['f1/end', 'f1/side:rl0', 'f1/side:rl1', 'f1/side:rl2', 'f1/side:rl3', 'f1/start']);
      near(b.faces.find((q) => q.key === 'f1/end')!.c[2], 10 + d);
    }
  });

  it('a sketch on the pulled face follows it when the distance changes', () => {
    // a 3 deep hole sketched on the top face after a pull of 5; pulled 8, the hole goes up with the face
    const pull = (d: string): DesignItem => ({ kind: 'presspull', id: 'f2', name: 'PressPull1', faces: top, d });
    const b = bodiesOf(built(single([...items, pull('5')])))[0];
    const plane = facePlane(b, b.faces.find((q) => q.key === 'f1/end')!, 'end face of Extrude1');
    const all = (d: number): DesignItem[] => [...items, pull(String(d)),
      { kind: 'sketch', id: 's2', name: 'Top', plane, sketch: points('h', [[50, 30]]) },
      { kind: 'hole', id: 'f3', name: 'Hole1', sketch: 's2', d: '6', depth: '3', style: 'simple' },
    ];
    for (const d of [5, 8]) {
      const { V, errors, warnings } = run(all(d));
      expect(errors).toEqual({});
      expect(warnings).toEqual({});
      near(V[0], 60000 + 6000 * d - PI * 9 * 3);
    }
  });

  it('a hole wall pulled in by d shrinks the hole: ΔV = π (R² − (R − d)²) h', () => {
    // a 100 × 60 × 10 plate with a Ø20 hole; the wall's normal points at the axis
    const R = 10, h = 10;
    const plate: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: withCircles(rect('r', 0, 0, 100, 60), 'h', [[50, 30, R]]) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: String(h) }, op: 'new' },
    ];
    const V0 = 6000 * h - PI * R * R * h;
    const wall = facesAt(plate, [[50, 30, 5]]);
    for (const d of [3, -2]) {
      const all: DesignItem[] = [...plate, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: wall, d: String(d) }];
      const { V, errors } = run(all);
      expect(errors).toEqual({});
      near(V[0], V0 + PI * (R * R - (R - d) ** 2) * h);
      const b = bodiesOf(built(single(all)))[0];
      expectUnique(b);
      near(b.faces.find((q) => q.type === 'cylinder')!.radius!, R - d);
      // the plate's top is one face again, of the same name
      near(b.faces.find((q) => q.key === 'f1/end')!.area, 6000 - PI * (R - d) ** 2);
    }
  });

  it('a boss grows by d: π ((r + d)² − r²) h', () => {
    const r = 8, h = 20;
    const boss: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Disc', plane: { ref: 'XY' }, sketch: circles('c', [[0, 0, r]]) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: String(h) }, op: 'new' },
    ];
    const wall = facesAt(boss, [[0, 0, 10]]);
    const { V, errors } = run([...boss, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: wall, d: '2' }]);
    expect(errors).toEqual({});
    near(V[0], PI * 100 * h);
  });

  it('a half-round notch in an edge narrows by d: (π/2)(R² − (R − d)²) h; a rounding is refused', () => {
    // a 100 × 60 × 10 plate with a notch of R = 10 cut into its front edge: a half cylinder whose
    // ends meet the front face, so the ring that grows into it ends in that face
    const R = 10, h = 10, d = 3;
    const sk: CadSketch = {
      points: [[0, 0], [40, 0], [60, 0], [100, 0], [100, 60], [0, 60], [50, 0]].map(([x, y], i) => ({ id: `n${i}`, x, y })),
      entities: [
        { id: 'e0', type: 'line', p1: 'n0', p2: 'n1' },
        { id: 'e1', type: 'arc', c: 'n6', p1: 'n2', p2: 'n1' },
        { id: 'e2', type: 'line', p1: 'n2', p2: 'n3' }, { id: 'e3', type: 'line', p1: 'n3', p2: 'n4' },
        { id: 'e4', type: 'line', p1: 'n4', p2: 'n5' }, { id: 'e5', type: 'line', p1: 'n5', p2: 'n0' },
      ],
      constraints: [],
    };
    const notched: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: sk },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: String(h) }, op: 'new' },
    ];
    const V0 = (6000 - (PI * R * R) / 2) * h;
    // the centroid of a half cylinder's surface lies 2R/π from its axis
    const wall = facesAt(notched, [[50, (2 * R) / PI, 5]]);
    const all: DesignItem[] = [...notched, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: wall, d: String(d) }];
    const { V, errors } = run(all);
    expect(errors).toEqual({});
    near(V[0], V0 + (PI / 2) * (R * R - (R - d) ** 2) * h);
    const b = bodiesOf(built(single(all)))[0];
    expectUnique(b);
    // the front face is one face again, its notch narrower
    // the front face's two pieces keep their names, each 3 longer
    near(b.faces.find((q) => q.key === 'f1/side:e0')!.area, (40 + d) * h);
    near(b.faces.find((q) => q.key === 'f1/side:e2')!.area, (40 + d) * h);

    // a rounded box edge is a part cylinder between two faces it is tangent to
    const items = box(100, 60, 10);
    const edges = edgesAt(items, [TOP_FRONT]);
    const rounded: DesignItem[] = [...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: '3' }] }];
    const round = bodiesOf(built(single(rounded)))[0].faces.find((q) => q.key.startsWith('f2/round:'))!;
    const pulled = run([...rounded, { kind: 'presspull', id: 'f3', name: 'PressPull1', faces: [refTo('face', 'f1', round)], d: '1' }]);
    expect(pulled.errors.f3).toBe('a rounding between two faces cannot be press-pulled: change its radius instead');
  });

  it('faces that meet move as an offset: the gap between their prisms is filled up to where the moved planes meet', () => {
    // two faces of the 100 × 60 × 10 box moved by d give the (100 + d) × 60 × (10 + d) box, three at a
    // corner the (100 + d)(60 + d)(10 + d) one, as an offset of the faces does (pulled: the corner
    // between the prisms filled; pushed: cut away with them)
    const keys = (all: DesignItem[]) => bodiesOf(built(single(all)))[0].faces.map((q) => q.key).sort();
    const six = ['f1/end', 'f1/side:rl0', 'f1/side:rl1', 'f1/side:rl2', 'f1/side:rl3', 'f1/start'];
    const [right, lid, front] = facesAt(items, [[100, 30, 5], [50, 30, 10], [50, 0, 5]]);
    for (const d of [5, -3]) {
      const two: DesignItem[] = [...items, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: [right, lid], d: String(d) }];
      const r2 = run(two);
      expect(r2.errors).toEqual({});
      near(r2.V[0], (100 + d) * 60 * (10 + d));
      expect(keys(two)).toEqual(six);
      const three: DesignItem[] = [...items, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: [right, lid, front], d: String(d) }];
      const r3 = run(three);
      expect(r3.errors).toEqual({});
      near(r3.V[0], (100 + d) * (60 + d) * (10 + d));
      expect(keys(three)).toEqual(six);
    }
    // faces at 45°: a wall and the roof of a house profile (extruded 100), pulled 4: the new profile is
    // bounded by x = 60 + d, x + y = 100 + d√2 and the unmoved roof −x + y = 40 (shoelace area)
    const house: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'House', plane: { ref: 'XY' }, sketch: poly('h', [[0, 0], [60, 0], [60, 40], [30, 70], [0, 40]]) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: '100' }, op: 'new' },
    ];
    const d = 4, s2 = Math.SQRT2;
    const pts: [number, number][] = [[0, 0], [60 + d, 0], [60 + d, 40 + d * (s2 - 1)], [30 + (d * s2) / 2, 70 + (d * s2) / 2], [0, 40]];
    const area = pts.reduce((acc, p, i) => acc + (p[0] * pts[(i + 1) % 5][1] - pts[(i + 1) % 5][0] * p[1]) / 2, 0);
    const pulled: DesignItem[] = [...house, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: facesAt(house, [[60, 20, 50], [45, 55, 50]]), d: String(d) }];
    const rh = run(pulled);
    expect(rh.errors).toEqual({});
    near(rh.V[0], area * 100);
    expect(keys(pulled)).toEqual(['f1/end', 'f1/side:hl0', 'f1/side:hl1', 'f1/side:hl2', 'f1/side:hl3', 'f1/side:hl4', 'f1/start']);
    // a top with a hole moves as a prism, the sides it meets as offsets: the same box, the hole's wall
    // carried on, ((100 + d)(60 + d) − π R²)(10 + d) (the corner cube between their wedges filled)
    const plate: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: withCircles(rect('r', 0, 0, 100, 60), 'h', [[50, 30, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ];
    const pb = bodiesOf(built(single(plate)))[0];
    const face = (f: (q: (typeof pb.faces)[number]) => boolean) => refTo('face', 'f1', pb.faces.find(f)!);
    const [ptop, pright, pfront] = [face((q) => !!q.frame && Math.abs(q.c[2] - 10) < 1e-9), face((q) => Math.abs(q.c[0] - 100) < 1e-9), face((q) => Math.abs(q.c[1]) < 1e-9)];
    for (const d of [5, -3]) {
      const rp = run([...plate, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: [ptop, pright, pfront], d: String(d) }]);
      expect(rp.errors).toEqual({});
      near(rp.V[0], ((100 + d) * (60 + d) - PI * 100) * (10 + d));
    }
    // the inner corner of an L (concave) pushed in by 3: the corner square between the prisms goes too
    const L: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'L', plane: { ref: 'XY' }, sketch: poly('l', [[0, 0], [60, 0], [60, 10], [10, 10], [10, 40], [0, 40]]) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: '50' }, op: 'new' },
    ];
    const inner = facesAt(L, [[35, 10, 25], [10, 25, 25]]);
    for (const [dd, want] of [[-3, 60 * 7 + 7 * 33], [3, 60 * 13 + 13 * 27]]) {
      const rl = run([...L, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: inner, d: String(dd) }]);
      expect(rl.errors).toEqual({});
      near(rl.V[0], want * 50);
    }
  });

  it('the faces around a moved face that stay are extended up to it (a chamfer, a drafted side)', () => {
    // a 100 × 60 × 10 box with both long top edges chamfered 4: the top is 52 wide, and s above it the
    // chamfer planes are 52 − 2s apart, so pulled up by d: ΔV = 100 ∫₀ᵈ (52 − 2s) ds = 100 (52d − d²);
    // pushed in by d (≤ 4) they are 52 + 2s apart: ΔV = −100 (52d + d²)
    const chamfered: DesignItem[] = [...items, { kind: 'chamfer', id: 'f2', name: 'Chamfer1', edges: edgesAt(items, [TOP_FRONT, [50, 60, 10]]), type: 'equal', d: '4' }];
    const lid = facesAt(chamfered, [[50, 30, 10]]);
    const keys = (all: DesignItem[]) => bodiesOf(built(single(all)))[0].faces.map((q) => q.key).sort();
    const V0 = 60000 - 2 * 8 * 100;
    for (const [d, dV] of [[5, 100 * (52 * 5 - 25)], [-3, -100 * (52 * 3 + 9)]]) {
      const all: DesignItem[] = [...chamfered, { kind: 'presspull', id: 'f3', name: 'PressPull1', faces: lid, d: String(d) }];
      const r = run(all);
      expect(r.errors).toEqual({});
      near(r.V[0], V0 + dV);
      // the chamfers are the same faces, larger or smaller
      expect(keys(all)).toEqual(keys(chamfered));
    }
    // pulled 30 the chamfers would cross (they meet 26 above the top)
    expect(run([...chamfered, { kind: 'presspull', id: 'f3', name: 'PressPull1', faces: lid, d: '30' }]).errors.f3).toBe('the faces next to it close in before that distance');
    // the front of a 100 × 60 × 40 box drafted 5° (y = z tan θ), the top pulled up 5: the draft goes on,
    // ΔV = 100 ∫₄₀⁴⁵ (60 − z tan θ) dz = 100 (300 − 212.5 tan θ)
    const tall = box(100, 60, 40);
    const k = tan((5 * PI) / 180);
    const drafted: DesignItem[] = [...tall, { kind: 'draft', id: 'f2', name: 'Draft1', faces: facesAt(tall, [[50, 0, 20]]), plane: 'XY', angle: '5 deg' }];
    const r = run([...drafted, { kind: 'presspull', id: 'f3', name: 'PressPull1', faces: facesAt(tall, [[50, 30, 40]]), d: '5' }]);
    expect(r.errors).toEqual({});
    near(r.V[0], 240000 - (100 * 1600 * k) / 2 + 100 * (300 - 212.5 * k));
    // the top and the right side of a 100 × 60 × 40 box with its top front edge chamfered 4 (plane
    // z − y = 36), both moved by d: the box 0 ≤ x ≤ 100 + d, 0 ≤ z ≤ 40 + d cut by the chamfer plane
    // carried on, V = (100 + d)(60 (40 + d) − (4 + d)²/2)
    const rimmed: DesignItem[] = [...tall, { kind: 'chamfer', id: 'f2', name: 'Chamfer1', edges: edgesAt(tall, [[50, 0, 40]]), type: 'equal', d: '4' }];
    const b = bodiesOf(built(single(rimmed)))[0];
    const two = [b.faces.find((q) => Math.abs(q.c[2] - 40) < 1e-9)!, b.faces.find((q) => Math.abs(q.c[0] - 100) < 1e-9)!].map((f) => refTo('face', 'f1', f));
    for (const d of [3, -3]) {
      const all: DesignItem[] = [...rimmed, { kind: 'presspull', id: 'f3', name: 'PressPull1', faces: two, d: String(d) }];
      const rr = run(all);
      expect(rr.errors).toEqual({});
      near(rr.V[0], (100 + d) * (60 * (40 + d) - (4 + d) ** 2 / 2));
      expect(keys(all)).toEqual(keys(rimmed));
    }
  });

  it('pushed through the whole body is refused', () => {
    const { errors } = run([...items, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: top, d: '-12' }]);
    expect(errors.f2).toBe('the faces are pushed through the whole body');
  });
});

describe('split', () => {
  it('by a midplane: two bodies of V/2 with their centroids a/4 either side', () => {
    // a 100 × 60 × 10 box split by YZ offset 50: x 0…50 and 50…100
    const { res, V, errors, bodies } = run([...box(100, 60, 10), { kind: 'split', id: 'f2', name: 'Split1', body: 'f1', plane: 'YZ', offset: '50' }]);
    expect(errors).toEqual({});
    expect(V).toHaveLength(2);
    near(V[0], 30000);
    near(V[1], 30000);
    near(bodies[0].mass!.xg, 25);
    near(bodies[1].mass!.xg, 75);
    near(bodies[0].mass!.yg, 30);
    near(bodies[1].mass!.zg, 5);
    expect(bodies.map((b) => [b.id, b.name, b.feature])).toEqual([['f1', 'Body1', 'f1'], ['f2.1.f1', 'Body2', 'f2']]);
    // and the whole part is the box still
    near(res.mass!.V, 60000);
    near(res.mass!.xg, 50);
  });

  it('by a picked face plane and a sketch plane; each piece has its cut face', () => {
    const items = box(100, 60, 10);
    const [side] = facesAt(items, [[100, 30, 5]]);
    // the end face x = 100, offset 30 back into the body (its normal points out): x = 70
    const all: DesignItem[] = [...items, { kind: 'split', id: 'f2', name: 'Split1', body: 'f1', plane: side, offset: '-30' }];
    const { V, errors } = run(all);
    expect(errors).toEqual({});
    near(V[0], 70 * 600);
    near(V[1], 30 * 600);
    for (const b of bodiesOf(built(single(all)))) {
      expectUnique(b);
      near(b.faces.find((q) => q.key === 'f2/split')!.area, 600);
    }
    const onSketch = run([...items, { kind: 'sketch', id: 's2', name: 'Cut', plane: { ref: 'XY', offset: '4' }, sketch: rect('q', 0, 0, 1, 1) },
      { kind: 'split', id: 'f2', name: 'Split1', body: 'f1', plane: 's2' }]);
    near(onSketch.V[0], 24000);
    near(onSketch.V[1], 36000);
  });

  it('a plane that misses the body is refused', () => {
    const { errors, V } = run([...box(100, 60, 10), { kind: 'split', id: 'f2', name: 'Split1', body: 'f1', plane: 'XY', offset: '20' }]);
    expect(errors.f2).toBe('the plane does not cross the body');
    expect(V).toEqual([60000]);
  });
});

describe('move and copy', () => {
  it('a move translates the centroid exactly; the faces keep their names', () => {
    const all: DesignItem[] = [...box(100, 60, 10), { kind: 'move', id: 'f2', name: 'Move1', bodies: ['f1'], dx: '10', dy: '-5 mm', dz: '2.5' }];
    const { bodies, errors } = run(all);
    expect(errors).toEqual({});
    const m = bodies[0].mass!;
    near(m.xg, 60);
    near(m.yg, 25);
    near(m.zg, 7.5);
    const b = bodiesOf(built(single(all)))[0];
    near(b.faces.find((q) => q.key === 'f1/end')!.c[2], 12.5);
  });

  it('turned about the Z axis by 90°, then moved', () => {
    // the centroid (50, 30, 5) turns to (−30, 50, 5), then +100 in x
    const { bodies, errors } = run([...box(100, 60, 10), { kind: 'move', id: 'f2', name: 'Move1', bodies: ['f1'], axis: 'Z', angle: '90 deg', dx: '100' }]);
    expect(errors).toEqual({});
    const m = bodies[0].mass!;
    near(m.xg, 70);
    near(m.yg, 50);
    near(m.Ixx, (60000 * (100 ** 2 + 10 ** 2)) / 12);
  });

  it('a copy keeps the original: the volume doubles', () => {
    const { res, bodies, errors } = run([...box(100, 60, 10), { kind: 'move', id: 'f2', name: 'Copy1', bodies: ['f1'], dz: '20', copy: true }]);
    expect(errors).toEqual({});
    expect(bodies.map((b) => b.name)).toEqual(['Body1', 'Body2']);
    near(res.mass!.V, 120000);
    near(bodies[1].mass!.zg, 25);
    near(res.mass!.zg, 15);
  });

  it('about a picked edge', () => {
    // the top front edge (y = 0, z = 10) as the axis, a half turn: the box flips over onto y < 0
    const items = box(100, 60, 10);
    const [axis] = edgesAt(items, [TOP_FRONT]);
    const { bodies, errors } = run([...items, { kind: 'move', id: 'f2', name: 'Move1', bodies: ['f1'], axis, angle: '180 deg' }]);
    expect(errors).toEqual({});
    near(bodies[0].mass!.yg, -30);
    near(bodies[0].mass!.zg, 15);
  });
});

describe('modify features together', () => {
  const items = box(100, 60, 40);
  const top = facesAt(items, [[50, 30, 40]]);
  const all = (): DesignItem[] => {
    const shell: DesignItem = { kind: 'shell', id: 'f2', name: 'Shell1', faces: top, t: '3', side: 'inside' };
    const bottom = edgesAt([...items, shell], [[50, 0, 0]]);
    return [...items, shell,
      { kind: 'fillet', id: 'f3', name: 'Fillet1', sets: [{ edges: bottom, r: '2' }] },
      { kind: 'chamfer', id: 'f4', name: 'Chamfer1', edges: edgesAt([...items, shell], [[50, 60, 0]]), type: 'equal', d: '1' },
      { kind: 'presspull', id: 'f5', name: 'PressPull1', faces: facesAt(items, [[100, 30, 20]]), d: '4' },
      // the XZ plane's normal is −Y (as a sketch on it): y = 30 is offset −30
      { kind: 'split', id: 'f6', name: 'Split1', body: 'f1', plane: 'XZ', offset: '-30' },
      { kind: 'move', id: 'f7', name: 'Copy1', bodies: ['f1'], dz: '-60', copy: true },
    ];
  };

  it('every name stays unique after every one of them', () => {
    const list = all();
    for (let k = 3; k <= list.length; k++) {
      const r = built(single(list.slice(0, k)));
      expect(r.components.c1.errors).toEqual({});
      for (const b of bodiesOf(r)) expectUnique(b);
    }
  });

  it('deletes every OCCT object they make', () => {
    const oc = occ()!;
    const design = single(all());
    const { numbers } = solve(design);
    const watch = watchHandles(oc);
    try {
      const b = buildDesignOcc(oc, design, numbers);
      builtResultOcc(oc, b);
      b.free();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('deletes every OCCT object of the others too: a hole pulled, a draft, a hollow, a variable radius', () => {
    const plate: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: withCircles(rect('r', 0, 0, 100, 60), 'h', [[50, 30, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: '20' }, op: 'new' },
    ];
    const [wall, front] = facesAt(plate, [[50, 30, 10], [50, 0, 10]]);
    const [edge, back] = edgesAt(plate, [[50, 0, 0], [50, 60, 20]]);
    const design = single([...plate,
      { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: [wall], d: '2' },
      { kind: 'draft', id: 'f3', name: 'Draft1', faces: [front], plane: 'XY', angle: '4 deg' },
      { kind: 'fillet', id: 'f4', name: 'Fillet1', sets: [{ edges: [edge], r: '1', r2: '3' }] },
      { kind: 'chamfer', id: 'f5', name: 'Chamfer1', edges: [back], type: 'angle', d: '2', angle: '30 deg' },
      { kind: 'move', id: 'f6', name: 'Copy1', bodies: ['f1'], dx: '150', copy: true },
      { kind: 'shell', id: 'f7', name: 'Shell1', faces: [], body: 'f6.1.f1', t: '1.5', side: 'inside' },
    ]);
    const { res, numbers } = solve(design);
    expect(res.design!.errors).toEqual({});
    const oc = occ()!;
    const watch = watchHandles(oc);
    try {
      const b = buildDesignOcc(oc, design, numbers);
      builtResultOcc(oc, b);
      b.free();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('deletes every OCCT object of a shell next to a rounding (and of the arc joins round three fillets)', () => {
    const [front, right, back] = edgesAt(items, [[50, 0, 40], [100, 30, 40], [50, 60, 40]]);
    const design = single([...items,
      { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [front, right, back], r: '4' }] },
      { kind: 'shell', id: 'f3', name: 'Shell1', faces: top, t: '3', side: 'inside' },
    ]);
    const { res, numbers } = solve(design);
    expect(res.design!.errors).toEqual({});
    const oc = occ()!;
    const watch = watchHandles(oc);
    try {
      const b = buildDesignOcc(oc, design, numbers);
      builtResultOcc(oc, b);
      b.free();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it('deletes every OCCT object of faces pulled together, of walls past a rounding and of refused features', () => {
    const [right, lid, front] = facesAt(items, [[100, 30, 20], [50, 30, 40], [50, 0, 20]]);
    const [vert, rim] = edgesAt(items, [[100, 0, 20], [50, 0, 40]]);
    const oc = occ()!;
    for (const list of [
      [...items, { kind: 'presspull', id: 'f2', name: 'PressPull1', faces: [right, lid, front], d: '5' }],
      [...items, { kind: 'chamfer', id: 'f2', name: 'Chamfer1', edges: [rim], type: 'equal', d: '4' }, { kind: 'presspull', id: 'f3', name: 'PressPull1', faces: [lid, right], d: '-3' }],
      [...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [vert], r: '2' }] }, { kind: 'shell', id: 'f3', name: 'Shell1', faces: top, t: '3', side: 'inside' }],
      [...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [rim], r: '2' }] }, { kind: 'shell', id: 'f3', name: 'Shell1', faces: [], body: 'f1', t: '2', side: 'inside' }],
      [...items, { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges: [rim], r: '45' }] }],
    ] as DesignItem[][]) {
      const design = single(list);
      const { numbers } = solve(design);
      const watch = watchHandles(oc);
      try {
        const b = buildDesignOcc(oc, design, numbers);
        builtResultOcc(oc, b);
        b.free();
        expect(watch.undeleted()).toEqual([]);
      } finally {
        watch.stop();
      }
    }
  });

  it('the mesh kernel says they need the B-rep kernel, and still splits and moves', () => {
    const edges = edgesAt(items, [[50, 0, 40]]);
    setOccEnabled(false);
    try {
      const { errors, V } = run([...items,
        { kind: 'fillet', id: 'f2', name: 'Fillet1', sets: [{ edges, r: '2' }] },
        { kind: 'split', id: 'f3', name: 'Split1', body: 'f1', plane: 'YZ', offset: '50' },
        { kind: 'move', id: 'f4', name: 'Move1', bodies: ['f1'], dx: '-10' },
      ]);
      expect(errors.f2).toMatch(/^needs the B-rep kernel/);
      expect(errors.f3).toBeUndefined();
      expect(errors.f4).toBeUndefined();
      near(V[0], 120000, 1e-6);
      near(V[1], 120000, 1e-6);
    } finally {
      setOccEnabled(true);
    }
  });
});
