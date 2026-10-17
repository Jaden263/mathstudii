// Mesh import: STL (binary and ASCII), OBJ and 3MF read into mesh bodies whose volume
// properties come from the divergence theorem, checked against closed forms of the
// polyhedra the meshes are (a cube; a UV sphere, which is a stack of frustums of regular
// pyramids), and the closed-mesh check that refuses a volume to an open mesh.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { emptyDesign, facePlane, type DesignItem } from './design';
import { prunedFiles } from './imported';
import { refTo } from './topology';
import { insertImport, planImport } from './importDesign';
import { checkMesh, meshBodyOf, meshBodyTopology, meshMass, meshWords, weldMesh } from './meshBody';
import { read3mf, readObj, readStl } from './meshFiles';
import { meshToStl } from './stl';
import { circles, solve } from './occ/fixtures';
import { m4Pose } from './solid';
import { boxTriangles, uvSphere, uvSphereVolume } from './meshFixtures';
import { createRegion, emptyWorksheet, type CadRegion } from '../model/types';
import { evaluateWorksheet, type CadResult } from '../engine/evaluator';

const { PI } = Math;

const stl = (tris: number[][], name = 'part') => meshToStl({ positions: new Float32Array(tris.flat()), normals: new Float32Array(0), edges: new Float32Array(0), bounds: { min: [0, 0, 0], max: [0, 0, 0] } }, name);

function asciiStl(tris: number[][]): Uint8Array {
  const lines = ['solid cube'];
  for (const t of tris) {
    lines.push(' facet normal 0 0 0', '  outer loop');
    for (let k = 0; k < 9; k += 3) lines.push(`   vertex ${t[k]} ${t[k + 1]} ${t[k + 2]}`);
    lines.push('  endloop', ' endfacet');
  }
  lines.push('endsolid cube');
  return strToU8(lines.join('\n'));
}

const body = (positions: Float32Array | Float64Array, indices: Uint32Array, scale = 1) => meshBodyOf('m', 'f', { name: 'm', positions, indices }, scale);

describe('STL import', () => {
  it('a binary STL cube: 1000 mm³ about its centre', () => {
    const f = readStl(stl(boxTriangles(10, 10, 10)), 'cube');
    const m = f.parts[0].meshes[0];
    expect(m.indices.length).toBe(36);
    const b = body(m.positions, m.indices);
    expect(b.positions.length).toBe(8 * 3);
    expect(b.check).toEqual({ open: 0, nonManifold: 0, flipped: 0 });
    expect(b.mass!.V).toBeCloseTo(1000, 9);
    expect(b.mass!.c.map((v) => +v.toFixed(9))).toEqual([5, 5, 5]);
    // ∫(x − c)² dV of a cube of side a about its centre: a⁵/12
    expect(b.mass!.C[0]).toBeCloseTo(1e5 / 12, 6);
    expect(Math.abs(b.mass!.C[1])).toBeLessThan(1e-9);
  });

  it('an ASCII STL reads the same', () => {
    const f = readStl(asciiStl(boxTriangles(20, 10, 5)), 'cube');
    const b = body(f.parts[0].meshes[0].positions, f.parts[0].meshes[0].indices);
    expect(f.parts[0].meshes[0].name).toBe('cube');
    expect(b.mass!.V).toBeCloseTo(1000, 9);
    expect(b.mass!.c).toEqual([10, 5, 2.5]);
  });

  it('a sphere mesh has the volume of the polyhedron it is', () => {
    const [r, n, m] = [10, 48, 24];
    const tris = uvSphere(r, n, m);
    const f = readStl(stl(tris));
    const b = body(f.parts[0].meshes[0].positions, f.parts[0].meshes[0].indices);
    expect(b.check).toEqual({ open: 0, nonManifold: 0, flipped: 0 });
    const exact = uvSphereVolume(r, n, m);
    // the STL holds float32 coordinates: 10⁻⁷ relative on each, so the volume to ~10⁻⁶
    expect(Math.abs(b.mass!.V / exact - 1)).toBeLessThan(1e-6);
    // inscribed, so less than the sphere's 4/3 π r³ (by 0.6 % at this resolution)
    expect(b.mass!.V).toBeLessThan((4 / 3) * PI * r ** 3);
    expect(b.mass!.V / ((4 / 3) * PI * r ** 3)).toBeGreaterThan(0.99);
    for (const c of b.mass!.c) expect(Math.abs(c)).toBeLessThan(1e-5);
  });

  it('refuses a volume to an open mesh and says why', () => {
    // the cube without its top: four edges have one triangle each
    const tris = boxTriangles(10, 10, 10).filter((_, i) => i !== 2 && i !== 3);
    const f = readStl(stl(tris));
    const b = body(f.parts[0].meshes[0].positions, f.parts[0].meshes[0].indices);
    expect(b.check.open).toBe(4);
    expect(b.mass).toBeUndefined();
    expect(meshWords(b)).toMatch(/not closed \(4 edges with one triangle\)/);
    // and a triangle turned over is found too
    const turned = boxTriangles(10, 10, 10);
    const t0 = turned[0];
    turned[0] = [...t0.slice(0, 3), ...t0.slice(6, 9), ...t0.slice(3, 6)];
    const w = weldMesh(new Float32Array(turned.flat()), Uint32Array.from({ length: 36 }, (_, i) => i));
    expect(checkMesh(w.indices, w.positions.length / 3).flipped).toBe(3);
  });

  it('turns a mesh wound inside out the right way round', () => {
    const inside = boxTriangles(10, 10, 10).map((t) => [...t.slice(0, 3), ...t.slice(6, 9), ...t.slice(3, 6)]);
    const w = weldMesh(new Float32Array(inside.flat()), Uint32Array.from({ length: 36 }, (_, i) => i));
    expect(meshMass(w.positions, w.indices).V).toBeCloseTo(-1000, 9);
    expect(body(w.positions, w.indices).mass!.V).toBeCloseTo(1000, 9);
  });

  it('becomes a mesh body of the part, measured in the part’s unit', () => {
    // a 10 mm cube imported into a part in centimetres: 1 cm³
    const plan = planImport('cube.stl', 'stl', stl(boxTriangles(10, 10, 10)));
    const d = insertImport(emptyDesign(), plan, { unit: 'cm', active: 'c1' }).design;
    expect(d.components[0].name).toBe('cube');
    const { res } = solveUnit(d, 'cm');
    const b = res.design!.bodies.c1[0];
    expect(b.mesh).toBe(true);
    expect(b.mass!.V).toBeCloseTo(1, 9);
    // 1 cm³ of water
    expect(b.mass!.m).toBeCloseTo(1e-3, 12);
  });
});

/** Solve a design in a part of the given unit, water's density (the fixtures' solve is in mm, steel). */
function solveUnit(design: ReturnType<typeof emptyDesign>, unit: 'cm' | 'mm') {
  const ws = emptyWorksheet();
  const cad = createRegion('cad', 20, 20, { name: 'part', design, density: '1000 kg/m^3', unit }) as CadRegion;
  ws.regions = [cad];
  return { res: evaluateWorksheet(ws).results.get(cad.id) as CadResult };
}

describe('OBJ and 3MF import', () => {
  it('an OBJ of quads with an MTL colour', () => {
    const v = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `v ${i & 1 ? 10 : 0} ${i & 2 ? 10 : 0} ${i & 4 ? 10 : 0}`);
    // faces counter-clockwise from outside, 1-based, one with negative indices
    const f = ['f 1 3 4 2', 'f 5 6 8 7', 'f 1 2 6 5', 'f 3 7 8 4', 'f 1 5 7 3', 'f -7 -5 -1 -3'];
    const obj = ['# cube', 'mtllib cube.mtl', 'o Cube', ...v, 'usemtl steel', ...f].join('\n');
    const file = readObj(obj, 'cube', { steel: '#8090a0' });
    const m = file.parts[0].meshes[0];
    expect(m.name).toBe('Cube');
    expect(m.color).toBe('#8090a0');
    expect(m.indices.length).toBe(36);
    expect(body(m.positions, m.indices).mass!.V).toBeCloseTo(1000, 9);
  });

  it('a 3MF in inches with a build item moved and turned', () => {
    const verts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<vertex x="${i & 1 ? 1 : 0}" y="${i & 2 ? 1 : 0}" z="${i & 4 ? 1 : 0}"/>`).join('');
    const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    const tris = quads.flatMap(([p, q, r, s]) => [`<triangle v1="${p}" v2="${q}" v3="${r}"/>`, `<triangle v1="${p}" v2="${r}" v3="${s}"/>`]).join('');
    const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
      <resources><basematerials id="1"><base name="Red" displaycolor="#FF0000FF"/></basematerials>
      <object id="2" type="model" name="Inch cube" pid="1" pindex="0"><mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh></object></resources>
      <build><item objectid="2" transform="0 1 0 -1 0 0 0 0 1 10 0 0"/></build></model>`;
    const pkg = zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      '_rels/.rels': strToU8('<Relationships><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
      '3D/3dmodel.model': strToU8(model),
    });
    const f = read3mf(pkg, 'model');
    expect(f.unit).toBe(25.4);
    expect(f.parts.map((p) => [p.name, p.color])).toEqual([['Inch cube', '#ff0000']]);
    // p' = p·M: the x axis goes to +y, y to −x; moved 10 in along x
    expect(f.instances[0].M).toEqual([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 254, 0, 0, 1]);
    // into a part in mm: one inch cube, placed by a grounded occurrence
    const d = insertImport(emptyDesign(), planImport('model.3mf', '3mf', pkg), { unit: 'mm', active: 'c1' }).design;
    expect(d.occurrences).toHaveLength(1);
    expect(d.occurrences[0].pos).toEqual([254, 0, 0]);
    expect(d.occurrences[0].rot).toEqual([0, 0, 90]);
    const M = m4Pose(d.occurrences[0].pos, d.occurrences[0].rot);
    for (let i = 0; i < 16; i++) expect(M[i]).toBeCloseTo(f.instances[0].M[i], 12);
    const { res } = solve(d);
    expect(res.design!.bodies.c1[0].mass!.V).toBeCloseTo(25.4 ** 3, 6);
    expect(res.design!.total!.xg).toBeCloseTo(254 - 12.7, 6);
  });
});

describe('what the features do with a mesh body', () => {
  const cube = () => {
    const bytes = stl(boxTriangles(20, 20, 20));
    const d = insertImport(emptyDesign(), planImport('cube.stl', 'stl', bytes), { unit: 'mm', active: 'c1' }).design;
    const f = d.components[0].items[0];
    return { d, topo: meshBodyTopology(meshBodyOf(f.id, f.id, readStl(bytes, 'cube').parts[0].meshes[0], 1)) };
  };

  it('a sketch on one of its faces stays on it, without a warning, and a boss grows from it', () => {
    const { d, topo } = cube();
    const top = topo.faces.find((q) => q.frame && Math.abs(q.frame.n[2] - 1) < 1e-9)!;
    const items: DesignItem[] = [
      { kind: 'sketch', id: 'sk', name: 'On the cube', plane: facePlane(topo, top, 'top'), sketch: circles('h', [[10, 10, 5]]) },
      { kind: 'extrude', id: 'ex', name: 'Boss', sketch: 'sk', extent: { type: 'one', d: '7' }, op: 'new' },
    ];
    const { res } = solve({ ...d, components: [{ ...d.components[0], items: [...d.components[0].items, ...items] }] });
    expect(res.design!.errors).toEqual({});
    expect(res.design!.warnings).toEqual({});
    expect(res.design!.frames.sk.o[2]).toBeCloseTo(20, 12);
    // the boss π r² h on the cube's top (its own body: features do not join mesh bodies)
    expect(res.design!.bodies.c1.map((b) => b.mass!.V)).toEqual([expect.closeTo(PI * 25 * 7, 9), expect.closeTo(8000, 9)]);
  });

  it('a fillet on one of its edges says that a mesh body has none to round', () => {
    const { d, topo } = cube();
    const fillet: DesignItem = { kind: 'fillet', id: 'r', name: 'Round', sets: [{ edges: [refTo('edge', topo.id, topo.edges[0])], r: '2' }] };
    const { res } = solve({ ...d, components: [{ ...d.components[0], items: [...d.components[0].items, fillet] }] });
    expect(res.design!.errors.r).toMatch(/^Fillet cannot work on a mesh body .*convert it to a solid/);
  });

  it('the file goes from the document with the last import feature that used it', () => {
    const { d } = cube();
    expect(Object.keys(d.files!)).toHaveLength(1);
    // the same object while the file is used
    expect(prunedFiles(d)).toBe(d);
    const gone = prunedFiles({ ...d, components: [{ ...d.components[0], items: [] }] });
    expect(gone.files).toBeUndefined();
  });
});
