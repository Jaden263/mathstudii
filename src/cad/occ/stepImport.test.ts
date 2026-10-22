// STEP import: what our exporter writes comes back with the same solids (volumes and
// centroids from OCCT's exact integration, so 10⁻⁶ is the tolerance of the file's numbers,
// not of facets), names, colours and placements; imported faces keep their names through
// Replace file, so a sketch on one and the cut through it survive.
import { describe, expect, it } from 'vitest';
import { evaluateWorksheet, type CadResult } from '../../engine/evaluator';
import { cadExample } from '../../model/examples';
import type { CadRegion } from '../../model/types';
import { designOf, emptyDesign, facePlane, type CadDesign, type CadJoint, type DesignItem } from '../design';
import { snapsOn } from '../snaps';
import { refTo } from '../topology';
import { designNumbers } from '../keys';
import { m4Pose, type M4 } from '../solid';
import { insertImport, planImport, poseOf, replaceImport } from '../importDesign';
import { decodeString, parseEntity, stepStructure } from '../step21';
import { circles, rect, single, solve, watchHandles, withCircles } from './fixtures';
import { occ } from './kernel';
import { buildDesignOcc, occMass } from './build';
import { stepFile } from './exchange';
import { topologyOcc } from './topology';
import { clearStepFiles } from './stepImport';

const { PI } = Math;
const enc = (s: string) => new TextEncoder().encode(s);
const near = (v: number, want: number, rel: number) => expect(Math.abs(v - want) / Math.max(Math.abs(want), 1)).toBeLessThan(rel);

/** A plate with a bore, its top rim rounded (r = 2): a filleted body, as in exchange.test.ts. */
function plate(): CadDesign {
  return {
    version: 2,
    components: [{ id: 'cf', name: 'Flange plate', color: '#8fa3bf', items: [
      { kind: 'sketch', id: 's1', name: 'Plate', plane: { ref: 'XY' }, sketch: withCircles(rect('p', -50, -50, 50, 50), 'b', [[0, 0, 12]]) },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new', edgeEnd: { type: 'fillet', r: '2' } },
    ] }],
    occurrences: [{ id: 'o1', component: 'cf', grounded: true }],
    joints: [],
  };
}

/** Export a design's scope as STEP text. */
function exported(design: CadDesign, scope: Parameters<typeof stepFile>[3], unit: 'mm' | 'in' = 'mm', name?: string): string {
  const oc = occ()!;
  const { numbers } = solve(design);
  const built = buildDesignOcc(oc, design, numbers);
  try {
    return stepFile(oc, built, design, scope, { unit, name });
  } finally {
    built.free();
  }
}

/** Import STEP text into a new part in `unit`. */
function imported(text: string, name = 'part.step', into = emptyDesign()): CadDesign {
  const plan = planImport(name, 'step', enc(text));
  return insertImport(into, plan, { unit: 'mm', active: into.components[0].id }).design;
}


/** A flange plate (#8fa3bf) and a shaft (Ø20 × 80) placed twice, once turned to lie along X. */
function rig(shaftAt: [number, number, number] = [0, 0, -20], extra = false): CadDesign {
  return {
    version: 2,
    components: [
      { id: 'cf', name: 'Flange', color: '#8fa3bf', items: [
        { kind: 'sketch', id: 's1', name: 'Plate', plane: { ref: 'XY' }, sketch: withCircles(rect('p', -50, -50, 50, 50), 'b', [[0, 0, 12]]) },
        { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
      ] },
      { id: 'cs', name: 'Shaft', items: [
        { kind: 'sketch', id: 's2', name: 'Shaft', plane: { ref: 'XY' }, sketch: circles('s', [[0, 0, 10]]) },
        { kind: 'extrude', id: 'f2', name: 'Shaft', sketch: 's2', extent: { type: 'one', d: '80' }, op: 'new' },
      ] },
      ...(extra ? [{ id: 'ck', name: 'Key', items: [
        { kind: 'sketch' as const, id: 's3', name: 'Key', plane: { ref: 'XY' as const }, sketch: rect('k', 0, 0, 6, 6) },
        { kind: 'extrude' as const, id: 'f3', name: 'Key', sketch: 's3', extent: { type: 'one' as const, d: '20' }, op: 'new' as const },
      ] }] : []),
    ],
    occurrences: [
      { id: 'o1', component: 'cf', grounded: true },
      { id: 'o2', component: 'cs', grounded: true, pos: shaftAt, name: 'Main shaft' },
      { id: 'o3', component: 'cs', grounded: true, pos: [200, 0, 0], rot: [0, 90, 0] },
      ...(extra ? [{ id: 'o4', component: 'ck', grounded: true, pos: [60, 0, 0] as [number, number, number] }] : []),
    ],
    joints: [],
  };
}

describe('Replace file of an assembly', () => {
  it('moves the occurrences the import placed and adds the parts new to the file', () => {
    const first = exported(rig(), { kind: 'assembly' }, 'mm', 'Rig');
    const d = imported(first, 'rig.step');
    const shaft = d.occurrences.find((o) => o.name === 'Main shaft')!;
    expect(shaft.pos).toEqual([0, 0, -20]);
    const file = (d.components[0].items[0] as { file: string }).file;
    // version 2: the main shaft 30 lower, and a key
    const plan = planImport('rig-v2.step', 'step', enc(exported(rig([0, 0, -50], true), { kind: 'assembly' }, 'mm', 'Rig')));
    const r = replaceImport(d, file, plan, { unit: 'mm' });
    expect(r.added).toEqual(['Key']);
    expect(r.missing).toEqual([]);
    expect(r.design.components.map((c) => c.name)).toEqual(['Flange', 'Shaft', 'Key']);
    // the same occurrence (its id kept), where the new file has it; one more for the key
    expect(r.design.occurrences.find((o) => o.id === shaft.id)!.pos).toEqual([0, 0, -50]);
    expect(r.design.occurrences).toHaveLength(4);
    const { res } = solve(r.design);
    expect(res.design!.errors).toEqual({});
    near(res.design!.total!.V, 100 * 100 * 10 - PI * 144 * 10 + 2 * PI * 100 * 80 + 6 * 6 * 20, 1e-9);
  });
});

describe('references to imported geometry', () => {
  /** An imported plate, and what the test adds on it, solved; then the plate's file replaced by another file of the same plate. */
  function throughReplace(add: (d: CadDesign, topo: ReturnType<typeof topologyOcc>) => CadDesign) {
    const oc = occ()!;
    const text = exported(plate(), { kind: 'component', component: 'cf' });
    const d0 = imported(text, 'plate.step');
    const built = buildDesignOcc(oc, d0, solve(d0).numbers);
    const topo = topologyOcc(oc, built.components.get('c1')!.bodies[0].solid, d0.components[0].items[0].id);
    built.free();
    const d = add(d0, topo);
    const before = solve(d).res.design!;
    const again = text.replace(/'\d{4}-\d\d-\d\dT[\d:]+'/, "'2030-01-01T00:00:00'");
    const r = replaceImport(d, (d.components[0].items[0] as { file: string }).file, planImport('plate-v2.step', 'step', enc(again)), { unit: 'mm' });
    return { before, after: solve(r.design).res.design! };
  }

  it('a fillet on an imported edge keeps rounding it', () => {
    const { before, after } = throughReplace((d, topo) => {
      // the straight bottom edge along x at y = −50
      const e = topo.edges.find((q) => q.line && Math.abs(q.mid[1] + 50) < 1e-9 && Math.abs(q.mid[2]) < 1e-9)!;
      return { ...d, components: [{ ...d.components[0], items: [...d.components[0].items, { kind: 'fillet', id: 'r', name: 'Round', sets: [{ edges: [refTo('edge', topo.id, e)], r: '4' }] }] }] };
    });
    for (const x of [before, after]) {
      expect(x.errors).toEqual({});
      expect(x.warnings).toEqual({});
    }
    // the plate less (1 − π/4) r² along its 100 mm edge
    near(after.bodies.c1[0].mass!.V, before.bodies.c1[0].mass!.V, 1e-12);
    near(before.bodies.c1[0].mass!.V, solve(plateOnly()).res.design!.bodies.cf[0].mass!.V - (1 - PI / 4) * 16 * 100, 1e-9);
  });

  it('a joint on an imported circle keeps the shaft in the bore', () => {
    const { before, after } = throughReplace((d, topo) => {
      // a shaft component jointed to the centre of the bore's bottom circle
      const bore = topo.edges.find((q) => q.circle && Math.abs(q.circle.r - 12) < 1e-9 && Math.abs(q.circle.c[2]) < 1e-9)!;
      const snap = snapsOn(topo, { edge: bore.index }).find((q) => q.snap === 'centre')!;
      const shaft = single([
        { kind: 'sketch', id: 'ss', name: 'S', plane: { ref: 'XY' }, sketch: circles('s', [[0, 0, 10]]) },
        { kind: 'extrude', id: 'fs', name: 'Shaft', sketch: 'ss', extent: { type: 'one', d: '50' }, op: 'new' },
      ]).components[0];
      const joint: CadJoint = { id: 'j', name: 'Seat', type: 'revolute', a: { occ: d.occurrences[0].id, origin: { kind: 'snap', ...snap } }, b: { occ: 'os', origin: { kind: 'origin' } }, angle: '0', offset: '0' };
      return { ...d, components: [...d.components, { ...shaft, id: 'cs', name: 'Shaft' }], occurrences: [...d.occurrences, { id: 'os', component: 'cs', pos: [300, 0, 0] }], joints: [joint] };
    });
    for (const x of [before, after]) {
      expect(x.errors).toEqual({});
      expect(x.warnings).toEqual({});
      expect(x.placements.os.by).toBe('joint');
      // at the bore's centre on the bottom face, its axis down out of the plate
      expect(x.placements.os.matrix.slice(12, 15).map((v) => +v.toFixed(9))).toEqual([0, 0, 0]);
      expect(x.placements.os.matrix[10]).toBeCloseTo(-1, 9);
    }
  });
});

/** The plate without its import, to measure the closed forms against (built from its own timeline). */
const plateOnly = () => plate();


describe('STEP text reader', () => {
  it('decodes strings and complex entities', () => {
    expect(decodeString("B\\X2\\00FC\\X0\\gel \\X2\\00D8\\X0\\")).toBe('Bügel Ø');
    expect(decodeString('\\X4\\0001D6FC\\X0\\ \\X\\E9 \\S\\i')).toBe('𝛼 é é');
    const e = parseEntity(28, " ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )")!;
    expect(e.types).toEqual(['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
    expect(e.parts.SI_UNIT).toEqual([{ e: 'MILLI' }, { e: 'METRE' }]);
    const p = parseEntity(7, "PRODUCT('it''s','x /* not a comment */',$,(#8,#9))")!;
    expect(p.parts.PRODUCT).toEqual(["it's", 'x /* not a comment */', null, [{ ref: 8 }, { ref: 9 }]]);
  });

  it('reads placements whichever way round a writer puts the representations', () => {
    const text = exported(rig(), { kind: 'assembly' }, 'in', 'Rig');
    const want = stepStructure(text);
    expect(want.unit).toBe(25.4);
    // ITEM_DEFINED_TRANSFORMATION from the parent's placement to the child's, and the
    // representations swapped to match (what some writers do); and a name holding ENDSEC;
    const swapped = text
      .replace(/REPRESENTATION_RELATIONSHIP\('([^']*)','([^']*)',(#\d+),(#\d+)\)/g, "REPRESENTATION_RELATIONSHIP('$1','$2',$4,$3)")
      .replace(/ITEM_DEFINED_TRANSFORMATION\('([^']*)','([^']*)',(#\d+),(#\d+)\)/g, "ITEM_DEFINED_TRANSFORMATION('$1','$2',$4,$3)")
      .replace("'Main shaft'", "'Main shaft; ENDSEC;'");
    // (each of the three usages' relationships was turned round)
    expect(text.match(/REPRESENTATION_RELATIONSHIP\('[^']*','[^']*',#\d+,#\d+\)/g)).toHaveLength(3);
    expect(swapped.split('\n').filter((l, i) => l !== text.split('\n')[i]).length).toBeGreaterThanOrEqual(7);
    const got = stepStructure(swapped);
    expect(got.instances.map((i) => i.name)).toEqual(['Flange:1', 'Main shaft; ENDSEC;', 'Shaft:3']);
    got.instances.forEach((inst, k) => inst.M.forEach((v, i) => expect(v).toBeCloseTo(want.instances[k].M[i], 9)));
    // in inches: the main shaft 20 in down is 508 mm
    expect(got.instances[1].M[14]).toBeCloseTo(-508, 9);
  });
});

describe('STEP import', () => {
  it('reads a filleted body back with its volume, centroid and name', () => {
    const oc = occ()!;
    const src = plate();
    const { numbers } = solve(src);
    const built = buildDesignOcc(oc, src, numbers);
    const body = built.components.get('cf')!.bodies[0];
    const want = occMass(oc, body.solid.shape);
    const text = stepFile(oc, built, src, { kind: 'body', component: 'cf', body: body.id });
    built.free();
    const d = imported(text, 'plate.step');
    // one part at the origin: an import feature in the (empty) active component, named after the part
    expect(d.components).toHaveLength(1);
    expect(d.components[0].name).toBe('Body1');
    expect(d.components[0].items.map((i) => i.kind)).toEqual(['import']);
    const { res } = solve(d);
    expect(res.design!.errors).toEqual({});
    const b = res.design!.bodies.c1[0];
    // the body's name in the file (Body1, the exported body's)
    expect(b.name).toBe('Body1');
    near(b.mass!.V, want.V, 1e-6);
    for (let k = 0; k < 3; k++) expect(Math.abs([b.mass!.xg, b.mass!.yg, b.mass!.zg][k] - want.c[k])).toBeLessThan(1e-6 * 100);
    // and that is the closed form (exchange.test.ts): the square's rim and the bore's rim rounded
    const r = 2, A = (1 - PI / 4) * r * r, k = r ** 3 * (5 / 6 - PI / 4);
    near(b.mass!.V, 100 * 100 * 10 - PI * 144 * 10 - A * 400 + 8 * k - 2 * PI * (12 * A + k), 1e-6);
    // the colour, written as the sRGB it is
    expect(d.components[0].color).toBe('#8fa3bf');
  });

  it('brings the flange assembly back as components and grounded occurrences where they were', () => {
    const ws = cadExample();
    const out = evaluateWorksheet(ws);
    const region = ws.regions.find((r): r is CadRegion => r.kind === 'cad' && r.name === 'asm')!;
    const src = designOf(region);
    const res0 = out.results.get(region.id) as CadResult;
    const oc = occ()!;
    const built = buildDesignOcc(oc, src, designNumbers(res0.design!));
    const text = stepFile(oc, built, src, { kind: 'assembly' }, { name: 'Flange with shaft' });
    built.free();
    const s = stepStructure(text);
    expect(s.name).toBe('Flange with shaft');
    expect(s.parts.map((p) => p.name)).toEqual(['Flange', 'Shaft']);
    const d = imported(text, 'asm.step');
    expect(d.components.map((c) => c.name)).toEqual(['Flange', 'Shaft']);
    expect(d.components.map((c) => c.color)).toEqual(['#8fa3bf', '#c9a36b']);
    expect(d.occurrences.every((o) => o.grounded)).toBe(true);
    const { res } = solve(d);
    expect(res.design!.errors).toEqual({});
    // every component's solid as it was (the flange with its six counterbored holes)
    const [cf, cs] = d.components.map((c) => c.id);
    near(res.design!.components[cf]!.V, res0.design!.components.cf!.V, 1e-6);
    near(res.design!.components[cs]!.V, res0.design!.components.cs!.V, 1e-6);
    for (let k = 0; k < 3; k++) {
      const key = (['xg', 'yg', 'zg'] as const)[k];
      expect(Math.abs(res.design!.components[cf]![key] - res0.design!.components.cf![key])).toBeLessThan(1e-6);
    }
    // the occurrences where the joint had put them, by the names the exporter wrote
    const was: Record<string, M4> = { 'Flange:1': res0.design!.placements.of.matrix, 'Shaft:2': res0.design!.placements.os.matrix };
    expect(d.occurrences.map((o) => o.name).sort()).toEqual(Object.keys(was).sort());
    for (const o of d.occurrences) {
      const M = m4Pose(o.pos, o.rot), W = was[o.name!];
      for (let i = 0; i < 16; i++) expect(Math.abs(M[i] - W[i])).toBeLessThan(1e-6);
      expect(res.design!.placements[o.id].by).toBe('ground');
    }
    // the assembly's mass properties with the densities given again (volumes: the same)
    near(res.design!.total!.V, res0.design!.total!.V, 1e-6);
  });

  it('converts the file’s unit to the part’s', () => {
    // a 2 × 1 × 0.5 in block written in inches, read into millimetres
    const src: CadDesign = { ...emptyDesign('Block'), components: [{ id: 'c1', name: 'Block', items: [
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 2, 1) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '0.5' }, op: 'new' },
    ] }] };
    const s = stepStructure(exported(src, { kind: 'component', component: 'c1' }, 'in'));
    expect(s.unit).toBe(25.4);
    const { res } = solve(imported(exported(src, { kind: 'component', component: 'c1' }, 'in')));
    near(res.design!.bodies.c1[0].mass!.V, 2 * 1 * 0.5 * 25.4 ** 3, 1e-9);
  });

  it('places an occurrence by the pose it reads from a placement', () => {
    for (const [pos, rot] of [[[200, 0, 0], [0, 90, 0]], [[1, 2, 3], [10, -20, 30]], [[0, 0, -20], [0, 0, 0]], [[5, 5, 5], [170, -45, 95]]] as const) {
      const M = m4Pose([...pos], [...rot]);
      const p = poseOf(M, 'mm')!;
      const back = m4Pose(p.pos, p.rot);
      for (let i = 0; i < 16; i++) expect(Math.abs(back[i] - M[i])).toBeLessThan(1e-12);
    }
    // centimetres: the position in the part's unit
    expect(poseOf(m4Pose([25, 0, 0]), 'cm')!.pos[0]).toBeCloseTo(2.5, 12);
  });

  it('keeps a sketch on an imported face, and the cut through it, through Replace file', () => {
    const oc = occ()!;
    const text = exported(plate(), { kind: 'component', component: 'cf' });
    let d = imported(text, 'plate.step');
    const f = d.components[0].items[0];
    // the top of the plate (z = 10, away from the rounded rim), found on the imported body
    const { numbers } = solve(d);
    const built = buildDesignOcc(oc, d, numbers);
    const topo = topologyOcc(oc, built.components.get('c1')!.bodies[0].solid, f.id);
    built.free();
    const top = topo.faces.find((q) => q.frame && Math.abs(q.frame.n[2] - 1) < 1e-9 && Math.abs(q.c[2] - 10) < 1e-9)!;
    expect(top.key).toMatch(/\/b0:p[0-9a-f]{10}$/);
    const cut: DesignItem[] = [
      { kind: 'sketch', id: 'sk', name: 'OnTop', plane: facePlane(topo, top, 'top face'), sketch: circles('h', [[30, 30, 5]]) },
      { kind: 'extrude', id: 'cut', name: 'Pocket', sketch: 'sk', extent: { type: 'one', d: '4' }, op: 'cut' },
    ];
    d = { ...d, components: [{ ...d.components[0], items: [...d.components[0].items, ...cut] }] };
    const before = solve(d).res.design!;
    expect(before.errors).toEqual({});
    expect(before.warnings).toEqual({});
    const pocket = PI * 25 * 4;
    const V0 = before.bodies.c1[0].mass!.V;
    // the same plate written again: another file (its header has another time), the same faces
    const again = exported(plate(), { kind: 'component', component: 'cf' }).replace(/'\d{4}-\d\d-\d\dT[\d:]+'/, "'2030-01-01T00:00:00'");
    expect(again).not.toBe(text);
    const plan = planImport('plate-v2.step', 'step', enc(again));
    const old = (f as { file: string }).file;
    expect(plan.file.hash).not.toBe(old);
    const r = replaceImport(d, old, plan, { unit: 'mm' });
    expect(r.missing).toEqual([]);
    // every face has the name it had (they are found by name, not only by where they are)
    const keysOf = (x: CadDesign) => {
      const b = buildDesignOcc(oc, x, solve(x).numbers);
      try {
        return topologyOcc(oc, b.components.get('c1')!.bodies[0].solid, 'b').faces.map((q) => q.key).sort();
      } finally {
        b.free();
      }
    };
    const onlyImport = (x: CadDesign): CadDesign => ({ ...x, components: [{ ...x.components[0], items: x.components[0].items.slice(0, 1) }] });
    expect(keysOf(onlyImport(r.design))).toEqual(keysOf(onlyImport(d)));
    const after = solve(r.design).res.design!;
    expect(after.errors).toEqual({});
    expect(after.warnings).toEqual({});
    near(after.bodies.c1[0].mass!.V, V0, 1e-9);
    expect(after.frames.sk.o[2]).toBeCloseTo(10, 9);
    // the old file is gone from the document, the new one is there
    expect(Object.keys(r.design.files!)).toEqual([plan.file.hash]);

    // a new version with the plate 2 mm thicker: the top face is another plane now, and the
    // sketch says so (it stays where it was) rather than jump to some other face
    const thick = plate();
    (thick.components[0].items[1] as { extent: { d: string } }).extent.d = '12';
    const r2 = replaceImport(r.design, plan.file.hash, planImport('plate-v3.step', 'step', enc(exported(thick, { kind: 'component', component: 'cf' }))), { unit: 'mm' });
    const lost = solve(r2.design).res.design!;
    expect(lost.warnings?.sk).toMatch(/reference lost/);
    expect(lost.frames.sk.o[2]).toBeCloseTo(10, 9);
    // the plate 2 mm thicker (less the bore through it), the pocket still cut 4 deep down from z = 10
    near(lost.bodies.c1[0].mass!.V, V0 + (100 * 100 - PI * 144) * 2, 1e-9);
    near(V0, 100 * 100 * 10 - PI * 144 * 10 - pocket - (1 - PI / 4) * 4 * 400 + 8 * 8 * (5 / 6 - PI / 4) - 2 * PI * (12 * (1 - PI / 4) * 4 + 8 * (5 / 6 - PI / 4)), 1e-9);
  });

  it('deletes every OCCT object of the import once the build and its files are freed', () => {
    const oc = occ()!;
    const d = imported(exported(plate(), { kind: 'component', component: 'cf' }));
    const { numbers } = solve(d);
    clearStepFiles();
    const watch = watchHandles(oc);
    try {
      const built = buildDesignOcc(oc, d, numbers);
      expect(built.components.get('c1')!.errors).toEqual({});
      built.free();
      clearStepFiles();
      expect(watch.undeleted()).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});
