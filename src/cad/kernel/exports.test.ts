// The mesh exports and the face DXF as the UI asks for them, parsed back: 3MF (the package's
// parts, the core schema's essentials, closed objects, build items placed as the
// occurrences), glTF binary (header, chunks, every accessor's bytes in its buffer view, the
// node per occurrence), OBJ + MTL, STL with mesh bodies, and a face's true arcs and circles.
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { circles, rect, roundedRect, single, solve, withCircles } from '../occ/fixtures';
import type { CadDesign } from '../design';
import { insertImport, planImport } from '../importDesign';
import { boxTriangles } from '../meshFixtures';
import { checkMesh, meshMass, weldMesh } from '../meshBody';
import { read3mf, readMtl, readObj } from '../meshFiles';
import { dxfToSketch } from '../dxf';
import { meshToStl } from '../stl';
import { linearRgb } from '../meshExport';
import { answer, displayFor } from './service';
import type { KernelRequest, KernelValues } from './protocol';

const { PI } = Math;

async function ask<K extends KernelRequest['op']>(req: Extract<KernelRequest, { op: K }>): Promise<KernelValues[K]> {
  return (await answer(req)).value as KernelValues[K];
}

/** A flange plate (#8fa3bf) and a shaft (Ø20 × 80) placed twice, once turned to lie along X. */
function assembly(): CadDesign {
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
      { id: 'o2', component: 'cs', grounded: true, pos: [0, 0, -20], name: 'Main shaft' },
      { id: 'o3', component: 'cs', grounded: true, pos: [200, 0, 0], rot: [0, 90, 0] },
    ],
    joints: [],
  };
}

const V_FLANGE = 100 * 100 * 10 - PI * 144 * 10, V_SHAFT = PI * 100 * 80;

describe('3MF export', () => {
  it('writes a package of closed objects placed by build items, in millimetres', async () => {
    const design = assembly();
    const { numbers, res } = solve(design);
    const data = await ask({ op: 'export', design, numbers, format: '3mf', scope: { kind: 'assembly' }, unit: 'mm', name: 'Rig' });
    const files = unzipSync(data);
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    expect(strFromU8(files['[Content_Types].xml'])).toContain('Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"');
    expect(strFromU8(files['_rels/.rels'])).toMatch(/Target="\/3D\/3dmodel\.model"[^>]*Type="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/2013\/01\/3dmodel"/);
    const model = strFromU8(files['3D/3dmodel.model']);
    expect(model).toMatch(/<model unit="millimeter" xml:lang="en-US" xmlns="http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/core\/2015\/02">/);
    expect(model).toContain('<base name="#8FA3BF" displaycolor="#8FA3BF"/>');
    // the shaft once, placed twice: two objects, three items
    expect(model.match(/<object /g)).toHaveLength(2);
    expect(model.match(/<item /g)).toHaveLength(3);
    // read back: every vertex and triangle count, closed meshes, volumes and placements
    const back = read3mf(data, 'Rig');
    expect(back.parts.map((p) => p.name)).toEqual(['Flange', 'Shaft']);
    expect(back.parts[0].color).toBe('#8fa3bf');
    for (const [i, V] of [[0, V_FLANGE], [1, V_SHAFT]] as const) {
      const m = back.parts[i].meshes[0];
      const verts = (strFromU8(files['3D/3dmodel.model']).split('<object ')[i + 1].match(/<vertex /g) ?? []).length;
      expect(m.positions.length / 3).toBe(verts);
      expect(checkMesh(m.indices, m.positions.length / 3)).toEqual({ open: 0, nonManifold: 0, flipped: 0 });
      // facets within 10⁻⁴ of the size from the true surface: the volume to a few 10⁻⁴
      // (polygons inscribed in the circles: the shaft a little smaller, the flange with its bore a little larger)
      const v = meshMass(m.positions, m.indices).V;
      expect(i ? v < V : v > V).toBe(true);
      expect(Math.abs(v / V - 1)).toBeLessThan(5e-4);
    }
    const want = [res.design!.placements.o1.matrix, res.design!.placements.o2.matrix, res.design!.placements.o3.matrix];
    back.instances.forEach((inst, k) => want[k].forEach((v, i) => expect(inst.M[i]).toBeCloseTo(v, 6)));
  });

  it('writes the numbers of a part in centimetres as millimetres', async () => {
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 2, 1) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '0.5' }, op: 'new' },
    ]);
    const { numbers } = solve(design);
    const back = read3mf(await ask({ op: 'export', design, numbers, format: '3mf', scope: { kind: 'component', component: 'c1' }, unit: 'cm', name: 'Block' }));
    expect(back.unit).toBe(1);
    const m = back.parts[0].meshes[0];
    expect(meshMass(m.positions, m.indices).V).toBeCloseTo(20 * 10 * 5, 6);
  });
});

describe('glTF binary export', () => {
  it('has a JSON and a binary chunk whose views hold every accessor, a node per occurrence', async () => {
    const design = assembly();
    const { numbers, res } = solve(design);
    const glb = await ask({ op: 'export', design, numbers, format: 'glb', scope: { kind: 'assembly' }, unit: 'mm', name: 'Rig' });
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(glb.length);
    const jsonLen = dv.getUint32(12, true);
    expect(dv.getUint32(16, true)).toBe(0x4e4f534a);
    expect(jsonLen % 4).toBe(0);
    const json = JSON.parse(strFromU8(glb.subarray(20, 20 + jsonLen)));
    const binLen = dv.getUint32(20 + jsonLen, true);
    expect(dv.getUint32(24 + jsonLen, true)).toBe(0x004e4942);
    expect(28 + jsonLen + binLen).toBe(glb.length);
    expect(json.asset.version).toBe('2.0');
    expect(json.buffers).toEqual([{ byteLength: binLen }]);
    const size = { 5126: 4, 5125: 4 } as Record<number, number>;
    const comps = { VEC3: 3, SCALAR: 1 } as Record<string, number>;
    for (const a of json.accessors) {
      const v = json.bufferViews[a.bufferView];
      expect(v.byteLength).toBe(a.count * comps[a.type] * size[a.componentType]);
      expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(binLen);
      expect(v.byteOffset % 4).toBe(0);
    }
    // two meshes (flange, shaft), the root turning Z up to Y up in metres, three occurrences
    expect(json.meshes.map((m: { name: string }) => m.name)).toEqual(['Flange', 'Shaft']);
    expect(json.nodes[0].matrix).toEqual([0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1]);
    expect(json.nodes[0].children).toEqual([1, 2, 3]);
    expect(json.nodes.slice(1).map((n: { name: string }) => n.name)).toEqual(['Flange:1', 'Main shaft', 'Shaft:3']);
    json.nodes[3].matrix.forEach((v: number, i: number) => expect(v).toBeCloseTo(res.design!.placements.o3.matrix[i], 9));
    // the flange's base colour is #8fa3bf in linear RGB
    expect(json.materials[0].pbrMetallicRoughness.baseColorFactor[0]).toBeCloseTo(linearRgb(0x8f / 255), 9);
    // positions: as many as normals, the box of the shaft's within its accessor's min and max
    const prim = json.meshes[1].primitives[0];
    const pos = json.accessors[prim.attributes.POSITION], nrm = json.accessors[prim.attributes.NORMAL], idx = json.accessors[prim.indices];
    expect(nrm.count).toBe(pos.count);
    expect(idx.count % 3).toBe(0);
    expect(pos.min[2]).toBeCloseTo(0, 6);
    expect(pos.max[2]).toBeCloseTo(80, 6);
    // and they are the triangles of the display's tessellation family: the shaft's volume from them
    const view = json.bufferViews[pos.bufferView], iview = json.bufferViews[idx.bufferView];
    const P = new Float32Array(glb.slice(28 + jsonLen + view.byteOffset, 28 + jsonLen + view.byteOffset + view.byteLength).buffer);
    const I = new Uint32Array(glb.slice(28 + jsonLen + iview.byteOffset, 28 + jsonLen + iview.byteOffset + iview.byteLength).buffer);
    const w = weldMesh(P, I);
    expect(Math.abs(meshMass(w.positions, w.indices).V / V_SHAFT - 1)).toBeLessThan(5e-4);
  });
});

describe('OBJ and STL export', () => {
  it('OBJ with its MTL: every occurrence placed, in millimetres, coloured', async () => {
    const design = assembly();
    const { numbers } = solve(design);
    const zip = unzipSync(await ask({ op: 'export', design, numbers, format: 'obj', scope: { kind: 'assembly' }, unit: 'mm', name: 'Rig' }));
    const obj = strFromU8(zip['Rig.obj']), mtl = strFromU8(zip['Rig.mtl']);
    expect(obj).toContain('mtllib Rig.mtl');
    expect(obj.match(/^o /gm)).toHaveLength(3);
    const colours = readMtl(mtl);
    expect(Object.values(colours)).toContain('#8fa3bf');
    const back = readObj(obj, 'Rig', colours);
    const vols = back.parts[0].meshes.map((m) => {
      const w = weldMesh(m.positions, m.indices);
      return meshMass(w.positions, w.indices).V;
    });
    expect(vols).toHaveLength(3);
    for (const [v, V] of vols.map((v, i) => [v, i ? V_SHAFT : V_FLANGE])) expect(Math.abs(v / V - 1)).toBeLessThan(5e-4);
    expect(back.parts[0].meshes[0].color).toBe('#8fa3bf');
  });

  it('STL takes mesh bodies along with the exact ones', async () => {
    const plate = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 100, 60) },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new' },
    ]);
    const stl = meshToStl({ positions: new Float32Array(boxTriangles(10, 10, 10).flat()), normals: new Float32Array(0), edges: new Float32Array(0), bounds: { min: [0, 0, 0], max: [0, 0, 0] } });
    const design = insertImport({ ...plate, components: [...plate.components, { id: 'cm', name: 'Cube', items: [] }], occurrences: [...plate.occurrences, { id: 'om', component: 'cm', grounded: true, pos: [0, 0, 10] }] },
      planImport('cube.stl', 'stl', stl), { unit: 'mm', active: 'cm' }).design;
    const { numbers } = solve(design);
    const out = await ask({ op: 'export', design, numbers, format: 'stl', scope: { kind: 'assembly' }, unit: 'mm', name: 'P' });
    const n = new DataView(out.buffer, out.byteOffset).getUint32(80, true);
    // a box's tessellation is its 12 triangles; the cube's 12 more
    expect(n).toBe(24);
    expect(displayFor(design, numbers)!.components.cm.bodies[0].meshOnly).toBe(true);
  });
});

describe('face DXF', () => {
  it('writes the outer loop and the holes of a flat face with true arcs and circles', async () => {
    // 100 × 60 with corners rounded to R10, a Ø20 hole and a Ø8 one
    const sk = withCircles(roundedRect('p', 100, 60, 10), 'h', [[30, 30, 10], [75, 30, 4]]);
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: sk },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '5' }, op: 'new' },
    ]);
    const { numbers } = solve(design);
    const shown = displayFor(design, numbers)!;
    const top = shown.components.c1.bodies[0].faces.find((f) => f.frame && f.frame.n[2] > 0.999)!;
    const dxf = await ask({ op: 'faceDxf', design, numbers, component: 'c1', body: shown.components.c1.bodies[0].id, face: top.index, unit: 'mm' });
    const { sketch, unit } = dxfToSketch(dxf);
    expect(unit).toBe('mm');
    const byType = (t: string) => sketch.entities.filter((e) => e.type === t);
    expect(byType('line')).toHaveLength(4);
    expect(byType('arc')).toHaveLength(4);
    expect(byType('circle').map((c) => (c as { r: number }).r).sort((a, b) => a - b)).toEqual([4, 10]);
    // the arcs' radii from their centres and ends
    const P = new Map(sketch.points.map((p) => [p.id, p]));
    for (const a of byType('arc') as { c: string; p1: string; p2: string }[]) {
      const c = P.get(a.c)!, p1 = P.get(a.p1)!, p2 = P.get(a.p2)!;
      expect(Math.hypot(p1.x - c.x, p1.y - c.y)).toBeCloseTo(10, 9);
      expect(Math.hypot(p2.x - c.x, p2.y - c.y)).toBeCloseTo(10, 9);
      // a quarter, counter-clockwise from p1 to p2 seen from outside (the top, +z)
      const turn = Math.atan2(p2.y - c.y, p2.x - c.x) - Math.atan2(p1.y - c.y, p1.x - c.x);
      expect(((turn + 2 * PI) % (2 * PI))).toBeCloseTo(PI / 2, 9);
    }
    // the raw entities: CIRCLE and ARC with group 40 the radius
    expect(dxf.match(/\nCIRCLE\n/g)).toHaveLength(2);
    expect(dxf.match(/\nARC\n/g)).toHaveLength(4);
    // a cylindrical face is refused
    const wall = shown.components.c1.bodies[0].faces.find((f) => f.type === 'cylinder')!;
    await expect(answer({ op: 'faceDxf', design, numbers, component: 'c1', body: shown.components.c1.bodies[0].id, face: wall.index, unit: 'mm' })).rejects.toThrow(/only a flat face/);
  });
});

describe('face DXF of a face seen from below', () => {
  it('is the mirror image of the top, its arcs still counter-clockwise as seen from outside', async () => {
    // 80 × 50 with corners rounded to R5 and a Ø10 hole at (15, 35), off the centre lines so that a mirror shows
    const sk = withCircles(roundedRect('p', 80, 50, 5), 'h', [[15, 35, 5]]);
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: sk },
      { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '6' }, op: 'new' },
    ]);
    const { numbers } = solve(design);
    const body = displayFor(design, numbers)!.components.c1.bodies[0];
    const faces = { top: body.faces.find((f) => f.frame && f.frame.n[2] > 0.999)!, bottom: body.faces.find((f) => f.frame && f.frame.n[2] < -0.999)! };
    for (const [side, face] of Object.entries(faces)) {
      const { sketch } = dxfToSketch(await ask({ op: 'faceDxf', design, numbers, component: 'c1', body: body.id, face: face.index, unit: 'mm' }));
      const P = new Map(sketch.points.map((p) => [p.id, p]));
      // seen from below, x stays and y turns round (u × v is the outward normal −z)
      const hole = sketch.entities.find((e) => e.type === 'circle') as { c: string };
      expect([P.get(hole.c)!.x, P.get(hole.c)!.y].map((v) => +v.toFixed(9))).toEqual(side === 'top' ? [15, 35] : [15, -35]);
      const arcs = sketch.entities.filter((e) => e.type === 'arc') as { c: string; p1: string; p2: string }[];
      expect(arcs).toHaveLength(4);
      for (const a of arcs) {
        const c = P.get(a.c)!, p1 = P.get(a.p1)!, p2 = P.get(a.p2)!;
        const turn = Math.atan2(p2.y - c.y, p2.x - c.x) - Math.atan2(p1.y - c.y, p1.x - c.x);
        expect((turn + 2 * PI) % (2 * PI)).toBeCloseTo(PI / 2, 9);
        // the quarter bulges outwards: its middle further from the plate's centre than its ends' chord
        const mid = Math.atan2(p1.y - c.y, p1.x - c.x) + PI / 4;
        const centre = { x: 40, y: side === 'top' ? 25 : -25 };
        const m = { x: c.x + 5 * Math.cos(mid), y: c.y + 5 * Math.sin(mid) };
        expect(Math.hypot(m.x - centre.x, m.y - centre.y)).toBeGreaterThan(Math.hypot((p1.x + p2.x) / 2 - centre.x, (p1.y + p2.y) / 2 - centre.y));
      }
    }
  });
});
