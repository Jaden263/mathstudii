// STEP files as other writers make them, built from what our exporter writes by editing
// its text the way those writers differ: Creo names every usage "Next assembly
// relationship"; Fusion and Onshape put an assembly's own bodies beside its sub-assemblies;
// some writers send circles as rational B-splines. And Replace file leaves an occurrence the
// user moved where the user put it. Reference values: the closed-form volumes of the plate
// (100 × 100 × 10 less a Ø24 bore) and the shaft (Ø20 × 80), and OpenCascade's own reading of
// the whole file (its assembly placements, not ours).
import { describe, expect, it } from 'vitest';
import { emptyDesign, type CadDesign } from '../design';
import { insertImport, planImport, replaceImport } from '../importDesign';
import { Part21, stepStructure } from '../step21';
import { circles, rect, solve, withCircles } from './fixtures';
import { occ, scratch, subShapes } from './kernel';
import { buildDesignOcc, occMass } from './build';
import { stepFile } from './exchange';
import { faceDxf } from './faceDxf';
import { topologyOcc } from './topology';

const { PI, SQRT1_2 } = Math;
const enc = (s: string) => new TextEncoder().encode(s);
const near = (v: number, want: number, rel: number) => expect(Math.abs(v - want) / Math.max(Math.abs(want), 1)).toBeLessThan(rel);
const V_PLATE = 100 * 100 * 10 - PI * 144 * 10, V_SHAFT = PI * 100 * 80;

/** A plate with a Ø24 bore and a Ø20 × 80 shaft placed twice, once turned to lie along X. */
function rig(shaftAt: [number, number, number] = [0, 0, -20]): CadDesign {
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
    ],
    occurrences: [
      { id: 'o1', component: 'cf', grounded: true },
      { id: 'o2', component: 'cs', grounded: true, pos: shaftAt, name: 'Main shaft' },
      { id: 'o3', component: 'cs', grounded: true, pos: [200, 0, 0], rot: [0, 90, 0] },
    ],
    joints: [],
  };
}

function exported(design: CadDesign, scope: Parameters<typeof stepFile>[3] = { kind: 'assembly' }): string {
  const oc = occ()!;
  const built = buildDesignOcc(oc, design, solve(design).numbers);
  try {
    return stepFile(oc, built, design, scope, { name: 'Rig' });
  } finally {
    built.free();
  }
}

function imported(text: string, name = 'rig.step'): CadDesign {
  const d0 = emptyDesign();
  return insertImport(d0, planImport(name, 'step', enc(text)), { unit: 'mm', active: d0.components[0].id }).design;
}

/** The entities of a Part 21 file's data section as text, by id. */
function entities(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of text.split('DATA;')[1].matchAll(/#(\d+)\s*=([\s\S]*?);\s*(?=#\d+\s*=|ENDSEC;)/g)) out.set(+m[1], m[2]);
  return out;
}

const withData = (text: string, more: string[]) => text.replace(/ENDSEC;\s*END-ISO-10303-21;/, `${more.join('\n')}\nENDSEC;\nEND-ISO-10303-21;`);

/** Every usage named "Next assembly relationship", the product's name as its description (as Creo writes them). */
const creo = (text: string) => text.replace(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\('([^']*)','[^']*','[^']*'/g, "NEXT_ASSEMBLY_USAGE_OCCURRENCE('$1','Next assembly relationship','PART'");

/** OpenCascade's reading of the whole file: its solids' total volume and centroid. */
function occWhole(text: string): { n: number; V: number; c: number[] } {
  const oc = occ()!;
  return scratch((t) => {
    oc.FS.writeFile('/whole.step', enc(text));
    try {
      const r = t.add(new oc.STEPControl_Reader());
      r.ReadFile('/whole.step');
      r.SetSystemLengthUnit(1);
      r.TransferRoots(t.add(new oc.Message_ProgressRange()));
      const solids = subShapes(oc, t, t.add(r.OneShape()), oc.TopAbs_ShapeEnum.TopAbs_SOLID);
      let V = 0;
      const c = [0, 0, 0];
      for (const s of solids) {
        const m = occMass(oc, s);
        V += m.V;
        for (let k = 0; k < 3; k++) c[k] += m.V * m.c[k];
      }
      return { n: solids.length, V, c: c.map((x) => x / V) };
    } finally {
      oc.FS.unlink('/whole.step');
    }
  });
}

describe('usages that share a name (Creo)', () => {
  it('gives every instance a path and a name of its own, and Replace file moves the right one', () => {
    const text = creo(exported(rig()));
    const s = stepStructure(text);
    expect(new Set(s.instances.map((i) => i.path)).size).toBe(3);
    // the shared name says nothing: the parts' names with a count, as Fusion names occurrences
    expect(s.instances.map((i) => i.name)).toEqual(['Flange:1', 'Shaft:1', 'Shaft:2']);
    const d = imported(text);
    const shaft = d.occurrences.find((o) => o.name === 'Shaft:1')!, other = d.occurrences.find((o) => o.name === 'Shaft:2')!;
    expect(shaft.pos).toEqual([0, 0, -20]);
    // version 2: the first shaft 30 lower; only that occurrence moves
    const v2 = planImport('rig-v2.step', 'step', enc(creo(exported(rig([0, 0, -50])))));
    const r = replaceImport(d, (d.components[0].items[0] as { file: string }).file, v2, { unit: 'mm' });
    expect(r.design.occurrences).toHaveLength(3);
    expect(r.design.occurrences.find((o) => o.id === shaft.id)!.pos).toEqual([0, 0, -50]);
    expect(r.design.occurrences.find((o) => o.id === other.id)!.pos).toEqual(other.pos);
    expect(r.design.occurrences.find((o) => o.id === other.id)!.rot).toEqual(other.rot);
  });
});

describe('an assembly with bodies of its own (Fusion, Onshape)', () => {
  it('imports them beside its sub-assemblies, as OpenCascade reads the file', () => {
    // the shaft's solid copied into the top assembly's own representation, at its origin
    const text0 = exported(rig());
    const ents = entities(text0);
    const f = new Part21(text0);
    const children = new Set(f.ofType('NEXT_ASSEMBLY_USAGE_OCCURRENCE').map((id) => (f.args(id, 'NEXT_ASSEMBLY_USAGE_OCCURRENCE')![4] as { ref: number }).ref));
    const top = f.ofType('PRODUCT_DEFINITION').find((pd) => !children.has(pd))!;
    const pds = f.ofType('PRODUCT_DEFINITION_SHAPE').find((id) => (f.args(id, 'PRODUCT_DEFINITION_SHAPE')![2] as { ref: number }).ref === top)!;
    const sdr = f.ofType('SHAPE_DEFINITION_REPRESENTATION').find((id) => (f.args(id, 'SHAPE_DEFINITION_REPRESENTATION')![0] as { ref: number }).ref === pds)!;
    const sr = (f.args(sdr, 'SHAPE_DEFINITION_REPRESENTATION')![1] as { ref: number }).ref;
    const ctx = (f.args(sr, 'SHAPE_REPRESENTATION')![2] as { ref: number }).ref;
    const brep = f.ofType('MANIFOLD_SOLID_BREP').at(-1)!;
    // the solid and everything it is made of, renumbered
    const off = Math.max(...ents.keys()) + 1;
    const copy = new Set<number>([brep]);
    for (const id of copy) for (const m of ents.get(id)!.matchAll(/#(\d+)/g)) copy.add(+m[1]);
    const more = [...copy].map((id) => `#${id + off} =${ents.get(id)!.replace(/#(\d+)/g, (_, n) => `#${+n + off}`)};`);
    more.push(`#${2 * off} = ADVANCED_BREP_SHAPE_REPRESENTATION('',(#${brep + off}),#${ctx});`, `#${2 * off + 1} = SHAPE_REPRESENTATION_RELATIONSHIP('','',#${sr},#${2 * off});`);
    const text = withData(text0, more);

    const s = stepStructure(text);
    expect(s.parts.map((p) => p.name)).toEqual(['Rig', 'Flange', 'Shaft']);
    expect(s.instances.map((i) => i.name)).toEqual(['Rig:1', 'Flange:1', 'Main shaft', 'Shaft:3']);
    const d = imported(text);
    const { res } = solve(d);
    expect(res.design!.errors).toEqual({});
    // the plate, the shaft twice where the file places it and once more at the assembly's origin
    near(res.design!.total!.V, V_PLATE + 3 * V_SHAFT, 1e-9);
    const whole = occWhole(text);
    expect(whole.n).toBe(4);
    near(res.design!.total!.V, whole.V, 1e-9);
    const t = res.design!.total!;
    expect(Math.hypot(t.xg - whole.c[0], t.yg - whole.c[1], t.zg - whole.c[2])).toBeLessThan(1e-6);
    const own = d.occurrences.find((o) => o.name === 'Rig:1')!;
    expect(own.pos).toBeUndefined();
    near(res.design!.components[own.component]!.V, V_SHAFT, 1e-9);
  });
});

describe('Replace file and the user’s moves', () => {
  it('leaves an occurrence the user moved off the file’s placement where the user put it', () => {
    const d0 = imported(exported(rig()));
    const main = d0.occurrences.find((o) => o.name === 'Main shaft')!, other = d0.occurrences.find((o) => o.name === 'Shaft:3')!;
    const d: CadDesign = { ...d0, occurrences: d0.occurrences.map((o) => (o.id === main.id ? { ...o, pos: [5, 5, 5] } : o)) };
    // version 2 moves both shafts
    const v2design = rig([0, 0, -50]);
    v2design.occurrences[2].pos = [250, 0, 0];
    const r = replaceImport(d, (d.components[0].items[0] as { file: string }).file, planImport('rig-v2.step', 'step', enc(exported(v2design))), { unit: 'mm' });
    expect(r.kept).toEqual(['Main shaft']);
    expect(r.design.occurrences.find((o) => o.id === main.id)!.pos).toEqual([5, 5, 5]);
    expect(r.design.occurrences.find((o) => o.id === other.id)!.pos).toEqual([250, 0, 0]);
  });
});

describe('circles written as rational B-splines', () => {
  /** The plate's circles as the exact rational quadratic B-splines (nine points) some writers send, without pcurves. */
  function asSplines(text: string): string {
    const ents = entities(text);
    let next = Math.max(...ents.keys()) + 1;
    const more: string[] = [];
    let out = text;
    const f = new Part21(text);
    for (const ec of f.ofType('EDGE_CURVE')) {
      const sc = (f.args(ec, 'EDGE_CURVE')![3] as { ref: number }).ref;
      const c = (f.args(sc, 'SURFACE_CURVE')?.[1] as { ref: number } | undefined)?.ref;
      const circle = c ? f.args(c, 'CIRCLE') : null;
      if (!circle) continue;
      const ax = f.args((circle[1] as { ref: number }).ref, 'AXIS2_PLACEMENT_3D')!;
      const o = f.args((ax[1] as { ref: number }).ref, 'CARTESIAN_POINT')![1] as number[];
      const z = f.args((ax[2] as { ref: number }).ref, 'DIRECTION')![1] as number[];
      const x = f.args((ax[3] as { ref: number }).ref, 'DIRECTION')![1] as number[];
      const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
      const r = circle[2] as number;
      // the corners and the middles of the square round the circle, from the x axis anticlockwise about z
      const at = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0]];
      const pts = at.map(([a, b]) => {
        more.push(`#${next} = CARTESIAN_POINT('',(${[0, 1, 2].map((k) => (o[k] + r * (a * x[k] + b * y[k])).toFixed(12)).join(',')}));`);
        return `#${next++}`;
      });
      const w = at.map((_, i) => (i % 2 ? SQRT1_2 : 1).toFixed(15)).join(',');
      more.push(`#${next} = ( BOUNDED_CURVE() B_SPLINE_CURVE(2,(${pts.join(',')}),.CIRCULAR_ARC.,.T.,.F.) B_SPLINE_CURVE_WITH_KNOTS((3,2,2,2,3),(0.,0.25,0.5,0.75,1.),.UNSPECIFIED.) CURVE() GEOMETRIC_REPRESENTATION_ITEM() RATIONAL_B_SPLINE_CURVE((${w})) REPRESENTATION_ITEM('') );`);
      out = out.replace(new RegExp(`#${ec} = EDGE_CURVE\\('([^']*)',(#\\d+),(#\\d+),#${sc},`), `#${ec} = EDGE_CURVE('$1',$2,$3,#${next++},`);
    }
    return withData(out, more);
  }

  it('reads them as the same solid, and the face DXF writes them as circles', () => {
    const oc = occ()!;
    const plate: CadDesign = { ...rig(), occurrences: [{ id: 'o1', component: 'cf', grounded: true }] };
    const text = asSplines(exported(plate, { kind: 'component', component: 'cf' }));
    expect(text).toContain('RATIONAL_B_SPLINE_CURVE');
    expect(text).not.toMatch(/EDGE_CURVE\('[^']*',#\d+,#\d+,#(\d+),[^;]*;[\s\S]*#\1 = SURFACE_CURVE\('',#\d+ = CIRCLE/);
    const d = imported(text, 'plate.step');
    const { res, numbers } = solve(d);
    expect(res.design!.errors).toEqual({});
    // as OpenCascade reads the file (its pcurves, which the file no longer has, approximated: 10⁻⁴)
    near(res.design!.total!.V, occWhole(text).V, 1e-9);
    near(res.design!.total!.V, V_PLATE, 1e-3);
    const cid = d.components[0].id;
    const built = buildDesignOcc(oc, d, numbers);
    try {
      const body = built.components.get(cid)!.bodies[0];
      const topo = topologyOcc(oc, body.solid, 'b');
      // the bore's edges really are B-splines now
      expect(topo.edges.filter((e) => !e.line && !e.circle).length).toBeGreaterThanOrEqual(2);
      const top = topo.faces.find((q) => q.frame && q.frame.n[2] > 0.999)!;
      const dxf = faceDxf(oc, built, cid, body.id, top.index, 'mm');
      // the square's four lines and the bore as one circle of radius 12 (not a polyline)
      expect(dxf.match(/\nLINE\n/g)).toHaveLength(4);
      const c = dxf.split('\nCIRCLE\n');
      expect(c).toHaveLength(2);
      expect(+/\n40\n([^\n]+)/.exec(c[1])![1]).toBeCloseTo(12, 9);
    } finally {
      built.free();
    }
  });
});
