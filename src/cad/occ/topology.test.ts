// Persistent names on the B-rep kernel and the references that follow edits: unique
// names after every feature, split and merged faces, thin walls, sketches on faces that
// move with their face, joints on circle centres, honest "reference lost" errors, and
// older documents that build as before.
import { describe, expect, it } from 'vitest';
import { circles, points, poly, rect, single, solve, volumes, watchHandles, withCircles } from './fixtures';
import { occ } from './kernel';
import { buildDesignOcc } from './build';
import { buildResultOcc } from './result';
import { topologyOcc } from './topology';
import { meshBuildResult, type BodyResult, type BuildResult } from '../buildResult';
import { buildInputs, exactComponent, facePlane, planeFrame, type CadDesign, type DesignItem, type DesignSketch } from '../design';
import { resolveRef, refTo } from '../topology';
import { snapsOn } from '../snaps';
import { kernel, m4Point, type Vec3 } from '../solid';

const { PI } = Math;
const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.max(Math.abs(want), 1e-300)).toBeLessThan(rel);
const close = (a: Vec3, b: Vec3, tol = 1e-9) => expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(tol);

const built = (d: CadDesign, pre: string[] = []): BuildResult => buildResultOcc(occ()!, d, solve(d, pre).numbers);
const first = (r: BuildResult, cid = 'c1') => r.components[cid].bodies[0];
const face = (b: BodyResult, key: string) => b.faces.find((f) => f.key === key)!;

/** Every name of a body is there and different from the others. */
function expectUnique(b: BodyResult) {
  for (const list of [b.faces, b.edges, b.vertices]) {
    const keys = list.map((x) => x.key);
    expect(keys.every((k) => k && !k.includes('?'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  }
}

/** A 100 × 60 base of height `h` (a worksheet expression). */
const base = (h: string, w = 100): DesignItem[] => [
  { kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, w, 60) },
  { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: h }, op: 'new' },
];

/** The plane of a sketch on face `key` of the body that `items` build, as the CAD window makes it. */
function planeOn(items: DesignItem[], key: string, pre: string[] = []): DesignSketch['plane'] {
  const b = first(built(single(items), pre));
  return facePlane(b, face(b, key), 'end face of Extrude1');
}

describe('names on the B-rep kernel', () => {
  it('every face, edge and vertex has a unique name after every feature', () => {
    // every kind of feature, two holes that overlap, a pattern of a cut, a loft, a thin wall, a revolve
    const items: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: poly('a', [[0, 0], [80, 0], [80, 30], [40, 50], [0, 30]]) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '20' }, op: 'new', edgeEnd: { type: 'fillet', r: '2' }, edgeStart: { type: 'chamfer', r: '1' } },
      { kind: 'sketch', id: 's2', name: 'T', plane: { ref: 'XY', offset: '20' }, sketch: points('h', [[20, 15], [26, 15], [60, 15]]) },
      { kind: 'hole', id: 'f2', name: 'H', sketch: 's2', d: '6', depth: '', through: true, style: 'countersink', csD: '12', csAngle: '90 deg' },
      { kind: 'pattern', id: 'f3', name: 'P', of: 'bodies', refs: ['f1'], type: 'rect', axis: 'Y', count: '2', spacing: '60', join: true },
      { kind: 'sketch', id: 's3', name: 'L', plane: { ref: 'XY', offset: '40' }, sketch: circles('l', [[40, 20, 8]]) },
      { kind: 'loft', id: 'f4', name: 'Loft', sketch: 's1', sketch2: 's3', op: 'new' },
      { kind: 'extrude', id: 'f5', name: 'Thin', sketch: 's3', extent: { type: 'one', d: '10' }, op: 'new', thin: { t: '1', side: 'center', cap: 'end' } },
      { kind: 'sketch', id: 's4', name: 'R', plane: { ref: 'XZ' }, sketch: rect('r', 100, 0, 110, 20) },
      { kind: 'revolve', id: 'f6', name: 'Rev', sketch: 's4', axis: 'y', angle: '270 deg', op: 'new' },
      { kind: 'sketch', id: 's5', name: 'Slot', plane: { ref: 'XY', offset: '20' }, sketch: rect('k', 30, -10, 34, 120) },
      { kind: 'extrude', id: 'f7', name: 'Cut', sketch: 's5', extent: { type: 'one', d: '5' }, op: 'cut', targets: ['f1'] },
      { kind: 'pattern', id: 'f9', name: 'PH', of: 'features', refs: ['f2'], type: 'rect', axis: 'X', count: '2', spacing: '5' },
    ];
    for (let k = 1; k <= items.length; k++) {
      const d = single(items.slice(0, k));
      const r = built(d);
      expect(r.components.c1.errors).toEqual({});
      for (const b of first(r) ? r.components.c1.bodies : []) expectUnique(b);
    }
  });

  it('a slot across the top splits it into #1 and #2 along the face’s x axis', () => {
    const d = single([...base('10'),
      { kind: 'sketch', id: 's2', name: 'T', plane: { ref: 'XY', offset: '10' }, sketch: rect('b', 40, -10, 60, 70) },
      { kind: 'extrude', id: 'f2', name: 'Slot', sketch: 's2', extent: { type: 'one', d: '4' }, op: 'cut' },
    ]);
    const b = first(built(d));
    expectUnique(b);
    // the pieces left (x 0…40) and right (60…100) of the slot, each 40 × 60
    near(face(b, 'f1/end#1').c[0], 20);
    near(face(b, 'f1/end#2').c[0], 80);
    near(face(b, 'f1/end#1').area, 2400);
    // the front's top edge is cut in two, each piece between its top piece and the front
    const front = b.edges.filter((e) => e.key.endsWith('|f1/side:al0') && e.key.startsWith('f1/end#'));
    expect(front.map((e) => e.key).sort()).toEqual(['f1/end#1|f1/side:al0', 'f1/end#2|f1/side:al0']);
  });

  it('faces merged by a join list both features; two edges between the same faces count along x', () => {
    // a block joined to the right of the base, flush, and a notch in the front of both
    const d = single([...base('10'),
      { kind: 'sketch', id: 's2', name: 'B', plane: { ref: 'XY' }, sketch: rect('c', 100, 0, 130, 60) },
      { kind: 'extrude', id: 'f2', name: 'Side', sketch: 's2', extent: { type: 'one', d: '10' }, op: 'join' },
      { kind: 'sketch', id: 's3', name: 'N', plane: { ref: 'XY', offset: '10' }, sketch: rect('n', 70, -10, 80, 10) },
      { kind: 'extrude', id: 'f3', name: 'Notch', sketch: 's3', extent: { type: 'one', d: '3' }, op: 'cut' },
    ]);
    const b = first(built(d));
    expectUnique(b);
    near(face(b, 'f1/end+f2/end').area, 130 * 60 - 100);
    const top = b.edges.filter((e) => e.key.startsWith('f1/end+f2/end|f1/side:al0+f2/side:cl0'));
    expect(top.map((e) => e.key).sort()).toEqual(['f1/end+f2/end|f1/side:al0+f2/side:cl0~1', 'f1/end+f2/end|f1/side:al0+f2/side:cl0~2']);
    // ~1 is the piece left of the notch (0 … 70), ~2 the one right of it (80 … 130)
    near(top.find((e) => e.key.endsWith('~1'))!.length, 70);
    near(top.find((e) => e.key.endsWith('~2'))!.length, 50);
  });

  it('thin walls name their faces after the entities they offset, out or in', () => {
    const d = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 40, 20) },
      { kind: 'extrude', id: 'f1', name: 'Box', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new', thin: { t: '2', side: 'center', cap: 'start' } },
    ]);
    const b = first(built(d));
    expectUnique(b);
    // the wall along line al0 (y = 0) is 1 out and 1 in of it: y = −1 and y = 1
    near(face(b, 'f1/side:al0:out').c[1], -1);
    near(face(b, 'f1/side:al0:in').c[1], 1);
    expect(face(b, 'f1/side:al0:out').frame!.n[1]).toBeCloseTo(-1, 12);
    expect(face(b, 'f1/side:al0:in').frame!.n[1]).toBeCloseTo(1, 12);
    // the floor of the open box is the hollow's start, 2 up
    near(face(b, 'f1/inner-start').c[2], 2);
    // the wall's top ring: the extrusion's end, 42 × 22 less 38 × 18
    near(face(b, 'f1/end').area, 42 * 22 - 38 * 18);
  });

  it('a box corner is named by its three faces', () => {
    const b = first(built(single(base('10'))));
    expect(b.vertices).toHaveLength(8);
    const corner = b.vertices.find((v) => Math.hypot(...v.p.map((x, i) => x - [0, 0, 10][i])) < 1e-9)!;
    // line al0 runs along y = 0, al3 along x = 0
    expect(corner.key).toBe('f1/end|f1/side:al0|f1/side:al3');
    expect(corner.edges).toHaveLength(3);
  });
});

describe('references that follow edits', () => {
  /** The top front edge of the base and the corner at its start, as picked on the plain base. */
  const plain = first(built(single(base('10'))));
  const topFront = plain.edges.find((e) => e.key === 'f1/end|f1/side:al0')!;
  const edgeRef = refTo('edge', 'f1', topFront);
  const cornerRef = refTo('vertex', 'f1', plain.vertices.find((v) => v.key === 'f1/end|f1/side:al0|f1/side:al3')!);
  const edgeAt = (b: BodyResult) => {
    const r = resolveRef(edgeRef, [b]);
    return r.ok ? b.edges[r.index] : null;
  };

  it('an edge keeps its name through an unrelated edit (a hole elsewhere)', () => {
    const d = single([...base('10'),
      { kind: 'sketch', id: 's2', name: 'P', plane: { ref: 'XY', offset: '10' }, sketch: points('h', [[70, 40]]) },
      { kind: 'hole', id: 'f2', name: 'Hole1', sketch: 's2', d: '8', depth: '', through: true, style: 'simple' },
    ]);
    const b = first(built(d));
    const e = edgeAt(b)!;
    expect(e.key).toBe(topFront.key);
    close(e.line!.a, topFront.line!.a);
    close(e.line!.b, topFront.line!.b);
    expect(resolveRef(cornerRef, [b])).toMatchObject({ ok: true, by: 'key' });
  });

  it('an edge split by a later cut: the half that holds its old midpoint, the first one on a tie', () => {
    const slot = (x0: number, x1: number): CadDesign => single([...base('10'),
      { kind: 'sketch', id: 's2', name: 'T', plane: { ref: 'XY', offset: '10' }, sketch: rect('b', x0, -10, x1, 70) },
      { kind: 'extrude', id: 'f2', name: 'Slot', sketch: 's2', extent: { type: 'one', d: '4' }, op: 'cut' },
    ]);
    // the slot from x = 55 to 70 leaves the old midpoint (50, 0, 10) on the left piece, 0 … 55
    const off = edgeAt(first(built(slot(55, 70))))!;
    expect(off.key).toBe('f1/end#1|f1/side:al0');
    near(off.length, 55);
    // a centred slot: both pieces are as far from it; the first along the face's x axis wins
    const mid = edgeAt(first(built(slot(40, 60))))!;
    expect(mid.key).toBe('f1/end#1|f1/side:al0');
    near(mid.line!.a[0] + mid.line!.b[0], 40);
    // the same every time it is rebuilt
    expect(edgeAt(first(built(slot(40, 60))))!.key).toBe(mid.key);
  });

  it('a vertex follows by its name when the base gets taller', () => {
    const b = first(built(single(base('h')), ['h := 25 mm']));
    const r = resolveRef(cornerRef, [b]);
    expect(r).toMatchObject({ ok: true, by: 'key' });
    close(b.vertices[r.ok ? r.index : 0].p, [0, 0, 25]);
  });
});

describe('sketches on faces', () => {
  /** A Ø10 hole 4 deep at (30, 20) on a sketch on the base's top face. */
  const holeOnTop = (h: string, w = 100): CadDesign => single([...base(h, w),
    { kind: 'sketch', id: 's2', name: 'Top', plane: planeOn(base('10'), 'f1/end'), sketch: points('p', [[30, 20]]) },
    { kind: 'hole', id: 'f2', name: 'Hole1', sketch: 's2', d: '10', depth: '4', style: 'simple' },
  ]);

  it('the base extruded taller moves the sketch up; its hole still cuts the top', () => {
    for (const h of [10, 25, 6]) {
      const d = holeOnTop('h');
      const { res, numbers } = solve(d, [`h := ${h} mm`]);
      expect(res.featureError).toBeUndefined();
      expect(res.design!.warnings).toEqual({});
      // the plane as built: on the top, whatever its height; the stored plane stays as made
      close(res.design!.frames.s2.o, [0, 0, h]);
      close(res.design!.resolveFrames!.s2.o, [0, 0, 10]);
      // V = 100 · 60 · h − π r² · 4: the hole goes down from the top, 4 deep
      near(volumes(res)[0], 6000 * h - PI * 25 * 4);
      const b = first(buildResultOcc(occ()!, d, numbers));
      near(face(b, 'f2/hole0:bottom').c[2], h - 4);
    }
  });

  it('a wider base leaves it where it was', () => {
    const { res } = solve(holeOnTop('10', 150));
    const f = res.design!.frames.s2;
    close(f.o, [0, 0, 10]);
    close(f.u, [1, 0, 0]);
    // the hole at the same place, (30, 20)
    near(volumes(res)[0], 9000 * 10 - PI * 100);
  });

  it('a base moved in its plane takes the sketch along: its origin sits on the base’s corner', () => {
    // the 100 × 60 base with its corner at (xb, 0): a fixed point at the origin drives it
    const driven = (h: string): DesignItem[] => {
      const r = rect('a', 0, 0, 100, 60);
      const sketch = {
        points: [...r.points, { id: 'o', x: 0, y: 0 }], entities: [...r.entities, { id: 'oe', type: 'point' as const, p: 'o' }],
        constraints: [
          { id: 'fo', type: 'fix', refs: ['o'] }, { id: 'px', type: 'distanceX', refs: ['o', 'ap0'], value: 'xb' }, { id: 'py', type: 'distanceY', refs: ['o', 'ap0'], value: '0 mm' },
          { id: 'h0', type: 'horizontal', refs: ['al0'] }, { id: 'h2', type: 'horizontal', refs: ['al2'] }, { id: 'v1', type: 'vertical', refs: ['al1'] }, { id: 'v3', type: 'vertical', refs: ['al3'] },
          { id: 'w', type: 'distanceX', refs: ['ap0', 'ap1'], value: '100 mm' }, { id: 'd', type: 'distanceY', refs: ['ap0', 'ap3'], value: '60 mm' },
        ],
      } as DesignSketch['sketch'];
      return [{ kind: 'sketch', id: 's1', name: 'Base', plane: { ref: 'XY' }, sketch }, { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: h }, op: 'new' }];
    };
    const plane = planeOn(driven('10'), 'f1/end', ['xb := 0 mm']);
    // made at xb = 0, the sketch origin (0, 0, 10) is the corner where lines al0 and al3 meet
    expect('anchor' in plane && plane.anchor?.ref.key).toBe('f1/end|f1/side:al0|f1/side:al3');
    const d = single([...driven('h'),
      { kind: 'sketch', id: 's2', name: 'Top', plane, sketch: points('p', [[30, 20]]) },
      { kind: 'hole', id: 'f2', name: 'Hole1', sketch: 's2', d: '10', depth: '4', style: 'simple' },
    ]);
    for (const [xb, h] of [[0, 10], [50, 10], [-30, 25]]) {
      const { res, numbers } = solve(d, [`xb := ${xb} mm`, `h := ${h} mm`]);
      expect(res.design!.warnings).toEqual({});
      close(res.design!.frames.s2.o, [xb, 0, h]);
      // still a Ø10 hole 4 deep in the top: V = 100 · 60 · h − π · 5² · 4, at (xb + 30, 20)
      near(volumes(res)[0], 6000 * h - PI * 25 * 4);
      close(face(first(buildResultOcc(occ()!, d, numbers)), 'f2/hole0:bottom').c, [xb + 30, 20, h - 4]);
    }
  });

  it('a sketch centred on a disc stays centred when the disc moves and grows', () => {
    // a disc of radius R about (cx, 0), a Ø8 hole 3 deep on a sketch on its top, 10 off its centre
    const disc = (cx: string, R: string): DesignItem[] => {
      const c = circles('k', [[0, 0, 20]]);
      const sketch = {
        points: [...c.points, { id: 'o', x: 0, y: 0 }], entities: [...c.entities, { id: 'oe', type: 'point' as const, p: 'o' }],
        constraints: [
          { id: 'fo', type: 'fix', refs: ['o'] }, { id: 'px', type: 'distanceX', refs: ['o', 'kc0'], value: cx }, { id: 'py', type: 'distanceY', refs: ['o', 'kc0'], value: '0 mm' },
          { id: 'r', type: 'radius', refs: ['kk0'], value: R },
        ],
      } as DesignSketch['sketch'];
      return [{ kind: 'sketch', id: 's1', name: 'Disc', plane: { ref: 'XY' }, sketch }, { kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' }];
    };
    const plane = planeOn(disc('cx', 'R'), 'f1/end', ['cx := 0 mm', 'R := 20 mm']);
    // the origin is the centre of the disc's top rim
    expect('anchor' in plane && plane.anchor?.ref.key).toBe('f1/end|f1/side:kk0');
    const d = single([...disc('cx', 'R'),
      { kind: 'sketch', id: 's2', name: 'Top', plane, sketch: points('p', [[10, 0]]) },
      { kind: 'hole', id: 'f2', name: 'Hole1', sketch: 's2', d: '8', depth: '3', style: 'simple' },
    ]);
    for (const [cx, R] of [[0, 20], [35, 20], [35, 30]]) {
      const { res, numbers } = solve(d, [`cx := ${cx} mm`, `R := ${R} mm`]);
      expect(res.design!.warnings).toEqual({});
      close(res.design!.frames.s2.o, [cx, 0, 10]);
      // V = π R² · 10 − π · 4² · 3, the hole 10 from the disc's centre
      near(volumes(res)[0], PI * R * R * 10 - PI * 16 * 3);
      close(face(first(buildResultOcc(occ()!, d, numbers)), 'f2/hole0:bottom').c, [cx + 10, 0, 7]);
    }
  });

  it('a face with no vertex or centre where the sketch origin lands: no anchor, it keeps its place in the plane', () => {
    // a boss away from the origin: its top has nothing at (0, 0, 25)
    const boss: DesignItem[] = [...base('10'),
      { kind: 'sketch', id: 'sb', name: 'B', plane: { ref: 'XY', offset: '10' }, sketch: rect('b', 20, 10, 40, 30) },
      { kind: 'extrude', id: 'fb', name: 'Boss', sketch: 'sb', extent: { type: 'one', d: '15' }, op: 'join' },
    ];
    const bb = first(built(single(boss)));
    expect('anchor' in facePlane(bb, face(bb, 'fb/end'))).toBe(false);
  });

  it('offset planes from faces follow too', () => {
    const d = single([...base('h'),
      { kind: 'sketch', id: 's2', name: 'Above', plane: { ...planeOn(base('10'), 'f1/end'), offset: '5' }, sketch: rect('b', 10, 10, 30, 30) },
      { kind: 'extrude', id: 'f2', name: 'Float', sketch: 's2', extent: { type: 'one', d: '2' }, op: 'new' },
    ]);
    const { res } = solve(d, ['h := 20 mm']);
    close(res.design!.frames.s2.o, [0, 0, 25]);
    near(res.design!.bodies.c1[1].mass!.zg, 26);
  });

  it('features that take the sketch’s plane follow it too: a mirror about it', () => {
    // the base mirrored about a (geometry-less) sketch on its own top, joined: twice as tall
    const d = single([...base('h'),
      { kind: 'sketch', id: 's2', name: 'Top', plane: planeOn(base('10'), 'f1/end'), sketch: { points: [], entities: [], constraints: [] } },
      { kind: 'mirror', id: 'f2', name: 'Mirror1', of: 'bodies', refs: ['f1'], plane: 's2', join: true },
    ]);
    for (const h of [10, 18]) {
      const { res } = solve(d, [`h := ${h} mm`]);
      near(res.design!.box!.max[2], 2 * h);
      near(volumes(res)[0], 2 * 6000 * h);
    }
  });

  it('a joint on a point of such a sketch goes with it', () => {
    const d = single([...base('h'),
      { kind: 'sketch', id: 's2', name: 'Top', plane: planeOn(base('10'), 'f1/end'), sketch: points('p', [[30, 20]]) },
    ]);
    const pin: DesignItem[] = [
      { kind: 'sketch', id: 's9', name: 'Pin', plane: { ref: 'XY' }, sketch: circles('k', [[0, 0, 4]]) },
      { kind: 'extrude', id: 'f9', name: 'Pin', sketch: 's9', extent: { type: 'one', d: '30' }, op: 'new' },
    ];
    const asm: CadDesign = {
      ...d,
      components: [...d.components, { id: 'c2', name: 'Pin', items: pin }],
      occurrences: [...d.occurrences, { id: 'o2', component: 'c2' }],
      joints: [{ id: 'j1', name: 'J', type: 'rigid', a: { occ: 'o1', origin: { kind: 'point', sketch: 's2', point: 'pq0' } }, b: { occ: 'o2', origin: { kind: 'origin' } }, angle: '0', offset: '0' }],
    };
    const { res } = solve(asm, ['h := 22 mm']);
    close(m4Point(res.design!.placements.o2.matrix, [0, 0, 0]), [30, 20, 22]);
  });

  it('without a kernel, a part with a sketch on a face waits for one', () => {
    const d = holeOnTop('10');
    const { numbers } = solve(d);
    expect(exactComponent(d, d.components[0], buildInputs(d, numbers))).toBeNull();
    expect(exactComponent(single(base('10')), single(base('10')).components[0], buildInputs(single(base('10')), solve(single(base('10'))).numbers))).not.toBeNull();
  });

  it('the face gone: "reference lost", the sketch stays where the face was, nothing else is picked', () => {
    // a boss on the base, a sketch on the boss's top; the boss then deleted
    const boss: DesignItem[] = [...base('10'),
      { kind: 'sketch', id: 'sb', name: 'B', plane: { ref: 'XY', offset: '10' }, sketch: rect('b', 20, 10, 40, 30) },
      { kind: 'extrude', id: 'fb', name: 'Boss', sketch: 'sb', extent: { type: 'one', d: '15' }, op: 'join' },
    ];
    const bb = first(built(single(boss)));
    const plane = facePlane(bb, face(bb, 'fb/end'), 'end face of Boss');
    const onBoss = (items: DesignItem[]) => single([...items,
      { kind: 'sketch', id: 's2', name: 'OnBoss', plane, sketch: points('p', [[30, 20]]) },
      { kind: 'hole', id: 'f2', name: 'Hole1', sketch: 's2', d: '6', depth: '3', style: 'simple' },
    ]);
    const ok = solve(onBoss(boss)).res;
    expect(ok.design!.warnings).toEqual({});
    close(ok.design!.frames.s2.o, [0, 0, 25]);
    // without the boss the base's top (z = 10) is flat and right below: it must not be taken
    const { res } = solve(onBoss(base('10')));
    expect(res.design!.warnings!.s2).toMatch(/^reference lost: the end face of Boss, which the sketch is on, is gone/);
    expect(res.featureError).toMatch(/^OnBoss: reference lost/);
    close(res.design!.frames.s2.o, [0, 0, 25]);
    // the hole is still made, where the face was (above the base: it cuts nothing)
    near(volumes(res)[0], 60000);
  });

  it('a sketch only finds faces built before it in the timeline', () => {
    // the sketch refers to the top of a boss that comes after it
    const boss: DesignItem[] = [...base('10'),
      { kind: 'sketch', id: 'sb', name: 'B', plane: { ref: 'XY', offset: '10' }, sketch: rect('b', 20, 10, 40, 30) },
      { kind: 'extrude', id: 'fb', name: 'Boss', sketch: 'sb', extent: { type: 'one', d: '15' }, op: 'join' },
    ];
    const bb = first(built(single(boss)));
    const plane = facePlane(bb, face(bb, 'fb/end'));
    const d = single([...base('10'), { kind: 'sketch', id: 's2', name: 'Early', plane, sketch: rect('p', 22, 12, 38, 28) }, ...boss.slice(2)]);
    expect(solve(d).res.design!.warnings!.s2).toMatch(/^reference lost/);
  });

  it('documents from before references: a captured face plane builds as it always did', () => {
    const captured: DesignSketch['plane'] = { frame: { o: [0, 0, 10], u: [1, 0, 0], v: [0, 1, 0] }, label: 'face of Body1' };
    const d = single([...base('h'),
      { kind: 'sketch', id: 's2', name: 'Top', plane: captured, sketch: points('p', [[30, 20]]) },
      { kind: 'hole', id: 'f2', name: 'Hole1', sketch: 's2', d: '10', depth: '4', style: 'simple', dir: '-' },
    ]);
    near(volumes(solve(d, ['h := 10 mm']).res)[0], 60000 - PI * 25 * 4);
    for (const h of [10, 25]) {
      const { res, numbers } = solve(d, [`h := ${h} mm`]);
      expect(res.design!.warnings).toEqual({});
      expect(res.design!.frames.s2).toEqual(planeFrame(captured));
      // the hole stays where the plane was captured: 4 down from z = 10
      near(face(first(buildResultOcc(occ()!, d, numbers)), 'f2/hole0:bottom').c[2], 6);
    }
  });

  it('the mesh kernel finds a face only where it has not moved, and says so', () => {
    const K = kernel()!;
    const d = holeOnTop('h');
    const same = meshBuildResult(K, d, solve(d, ['h := 10 mm']).numbers);
    expect(same.components.c1.warnings).toEqual({});
    const taller = meshBuildResult(K, d, solve(d, ['h := 25 mm']).numbers);
    expect(taller.components.c1.warnings!.s2).toMatch(/mesh kernel cannot follow/);
    expect(taller.components.c1.frames!.s2.o).toEqual([0, 0, 10]);
  });
});

describe('joints on geometry', () => {
  /** A plate with a hole at (x, 30) of diameter D, and a Ø8 pin jointed into the hole's top rim. */
  function assembly(x = 'x', D = 'D'): CadDesign {
    const plate: DesignItem[] = [
      { kind: 'sketch', id: 's1', name: 'P', plane: { ref: 'XY' }, sketch: withCircles(rect('a', 0, 0, 100, 60), 'h', [[50, 30, 10]]) },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ];
    const pin: DesignItem[] = [
      { kind: 'sketch', id: 's9', name: 'Pin', plane: { ref: 'XY' }, sketch: circles('k', [[0, 0, 4]]) },
      { kind: 'extrude', id: 'f9', name: 'Pin', sketch: 's9', extent: { type: 'one', d: '30' }, op: 'new' },
    ];
    // the circle placed by expressions: its centre and diameter are driven
    plate[0] = { ...plate[0], sketch: { ...(plate[0] as DesignSketch).sketch, constraints: [
      { id: 'dx', type: 'distanceX', refs: ['ap0', 'hc0'], value: x }, { id: 'dy', type: 'distanceY', refs: ['ap0', 'hc0'], value: '30' },
      { id: 'dd', type: 'diameter', refs: ['hk0'], value: D }, { id: 'fx', type: 'fix', refs: ['ap0'] },
    ] } } as DesignSketch;
    const d: CadDesign = {
      version: 2,
      components: [{ id: 'c1', name: 'Plate', items: plate }, { id: 'c2', name: 'Pin', items: pin }],
      occurrences: [{ id: 'o1', component: 'c1', grounded: true }, { id: 'o2', component: 'c2', pos: [200, 0, 0] }],
      joints: [],
    };
    const r = built(d, ['x := 50 mm', 'D := 20 mm']);
    // the CAD window's snaps: the rim's centre on the plate's top, the pin's bottom rim
    const topFace = face(first(r, 'c1'), 'f1/end');
    const rim = snapsOn(first(r, 'c1'), { face: topFace.index }).find((s) => s.snap === 'centre')!;
    const bottom = face(first(r, 'c2'), 'f9/start');
    const end = snapsOn(first(r, 'c2'), { face: bottom.index }).find((s) => s.snap === 'centre')!;
    return { ...d, joints: [{ id: 'j1', name: 'Joint1', type: 'rigid', a: { occ: 'o1', origin: { kind: 'snap', ...rim } }, b: { occ: 'o2', origin: { kind: 'snap', ...end } }, angle: '0', offset: '0', flip: true }] };
  }
  const pinAt = (d: CadDesign, pre: string[]) => {
    const { res } = solve(d, pre);
    expect(res.design!.errors.j1).toBeUndefined();
    const M = res.design!.placements.o2.matrix;
    return { res, base: m4Point(M, [0, 0, 0]), tip: m4Point(M, [0, 0, 30]) };
  };

  it('a joint on a hole’s rim follows the hole when it moves and grows', () => {
    const d = assembly();
    const a = pinAt(d, ['x := 50 mm', 'D := 20 mm']);
    close(a.base, [50, 30, 10]);
    // the pin stands up out of the plate (faces mate: its bottom on the top)
    close(a.tip, [50, 30, 40]);
    const b = pinAt(d, ['x := 70 mm', 'D := 30 mm']);
    expect(b.res.design!.warnings).toEqual({});
    close(b.base, [70, 30, 10]);
    close(b.tip, [70, 30, 40]);
  });

  it('the hole gone: "reference lost", the pin stays where it was put, not on another rim', () => {
    const d = assembly();
    // the plate's sketch now has another Ø20 hole elsewhere instead of the one the joint is on
    const c1 = d.components[0];
    const other = { ...d, components: [{ ...c1, items: [{ ...(c1.items[0] as DesignSketch), sketch: withCircles(rect('a', 0, 0, 100, 60), 'g', [[20, 15, 10]]) }, c1.items[1]] }, d.components[1]] };
    const { res } = solve(other);
    expect(res.design!.warnings!.j1).toMatch(/^reference lost: the centre of the ⌀20 circle is gone/);
    const M = res.design!.placements.o2.matrix;
    close(m4Point(M, [0, 0, 0]), [50, 30, 10]);
  });
});

describe('B-rep memory', () => {
  it('naming, sketches on faces and joints on geometry delete every OCCT object', () => {
    const oc = occ()!;
    const d = single([...base('10'),
      { kind: 'sketch', id: 's2', name: 'Top', plane: planeOn(base('10'), 'f1/end'), sketch: points('p', [[30, 20], [70, 40]]) },
      { kind: 'hole', id: 'f2', name: 'Hole1', sketch: 's2', d: '10', depth: '4', style: 'counterbore', cbD: '16', cbDepth: '2' },
      { kind: 'extrude', id: 'f3', name: 'Thin', sketch: 's1', extent: { type: 'one', d: '5' }, op: 'new', thin: { t: '1', side: 'inside', cap: 'none' } },
    ]);
    const { numbers } = solve(d);
    const watch = watchHandles(oc);
    try {
      const b = buildDesignOcc(oc, d, numbers);
      for (const body of b.components.get('c1')!.bodies) topologyOcc(oc, body.solid, body.id);
      b.free();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
