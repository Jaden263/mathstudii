// B-rep bodies as BuildResults: a display mesh that knows the face of every triangle,
// the exact faces (surface type, plane frames, cylinder axes and radii, areas), edges
// (curve type, circle centres, lengths, the two faces they join) and vertices with their
// persistent names (topology.ts), exact mass properties and boxes.
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { CadDesign, DesignNumbers } from '../design';
import { meshBuildResult, type BodyMesh, type BodyResult, type BuildResult } from '../buildResult';
import { kernel } from '../solid';
import { buildDesignOcc, isEmptyShape, occMass, type OccBody, type OccBuiltDesign } from './build';
import { occ, scratch, shapeIndex, type OC } from './kernel';
import { props, topologyOcc } from './topology';
import { meshBodyResult } from '../meshBody';

export interface MeshOptions {
  /** Chord deviation of the display mesh as a fraction of the body's size (default 5·10⁻⁴). */
  deflection?: number;
  /**
   * Largest angle between neighbouring mesh normals on a curved face, radians (default 0.25:
   * smooth normals hide the facets, and OCCT's mesher takes 4× as long at 0.1 on a part with
   * many small holes).
   */
  angle?: number;
}

const INT_MAX = 2147483647;

/** Copy n values from the WASM heap at a byte address (the heap may move: always a fresh view). */
export function heap<T extends Float32Array | Uint32Array | Int32Array>(oc: OC, Kind: { new (b: ArrayBuffer, o: number, n: number): T }, ptr: number, n: number): T {
  const view = new Kind(oc.wasmMemory.buffer as ArrayBuffer, ptr >>> 0, n);
  return view.slice() as T;
}

/**
 * OCCT's edge tessellation comes as line segments (a, b, b, c, c, d …): one polyline
 * (a, b, c, d …) without the repeated points.
 */
export function joinSegments(p: Float32Array): Float32Array {
  const out: number[] = [];
  for (let i = 0; i + 2 < p.length; i += 3) {
    const n = out.length;
    if (n && out[n - 3] === p[i] && out[n - 2] === p[i + 1] && out[n - 1] === p[i + 2]) continue;
    out.push(p[i], p[i + 1], p[i + 2]);
  }
  return new Float32Array(out);
}

/** One body: mesh, faces, edges, mass, box. */
export function bodyResultOcc(oc: OC, body: OccBody, o: MeshOptions = {}): BodyResult {
  const shape = body.solid.shape;
  const empty: BodyMesh = { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), faceOf: new Uint32Array(0) };
  const out: BodyResult = { id: body.id, name: body.name, feature: body.feature, mesh: empty, faces: [], edges: [], vertices: [], mass: { V: 0, c: [0, 0, 0], C: new Array(9).fill(0) }, area: 0, box: null };
  if (isEmptyShape(oc, shape)) return out;
  return scratch((t) => {
    // the named faces, edges and vertices, in explorer order (kept with the solid)
    const topo = topologyOcc(oc, body.solid, body.id);
    const faces = shapeIndex(oc, t, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
    const edges = shapeIndex(oc, t, shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    out.mass = occMass(oc, shape);
    out.box = topo.box;
    out.area = props(oc, t, shape, 'surface').Mass();
    out.faces = topo.faces.map((f) => ({ ...f }));
    out.vertices = topo.vertices;
    // display mesh and edge polylines, tessellated by OCCT
    const size = out.box ? Math.hypot(out.box.max[0] - out.box.min[0], out.box.max[1] - out.box.min[1], out.box.max[2] - out.box.min[2]) : 1;
    const tol = Math.max(size * (o.deflection ?? 5e-4), 1e-9), ang = o.angle ?? 0.25;
    const raw = t.add(oc.ReplicadMeshExtractor.extract(shape, tol, ang, false));
    const positions = heap(oc, Float32Array, raw.getVerticesPtr(), raw.getVerticesSize());
    const normals = heap(oc, Float32Array, raw.getNormalsPtr(), raw.getNormalsSize());
    const indices = heap(oc, Uint32Array, raw.getTrianglesPtr(), raw.getTrianglesSize());
    const groups = heap(oc, Int32Array, raw.getFaceGroupsPtr(), raw.getFaceGroupsSize());
    const faceOf = new Uint32Array(indices.length / 3);
    // groups are (first index, index count, face hash) in explorer order; the hash finds the face
    const byHash = new Map<number, number>();
    faces.shapes.forEach((f, i) => {
      const h = oc.ReplicadShapeHasher.HashCode(f, INT_MAX);
      byHash.set(h, byHash.has(h) ? -1 : i);
    });
    for (let g = 0; g < groups.length; g += 3) {
      const hit = byHash.get(groups[g + 2]);
      const fi = hit !== undefined && hit >= 0 ? hit : g / 3;
      faceOf.fill(fi, groups[g] / 3, (groups[g] + groups[g + 1]) / 3);
    }
    out.mesh = { positions, normals, indices, faceOf };
    const lines = t.add(oc.ReplicadEdgeMeshExtractor.extract(shape, tol, ang));
    const pts = heap(oc, Float32Array, lines.getLinesPtr(), lines.getLinesSize());
    const eg = heap(oc, Int32Array, lines.getEdgeGroupsPtr(), lines.getEdgeGroupsSize());
    const polyline = new Map<number, Float32Array>();
    const edgeByHash = new Map<number, number>();
    edges.shapes.forEach((e, i) => {
      const h = oc.ReplicadShapeHasher.HashCode(e, INT_MAX);
      edgeByHash.set(h, edgeByHash.has(h) ? -1 : i);
    });
    for (let g = 0; g < eg.length; g += 3) {
      const ei = edgeByHash.get(eg[g + 2]);
      if (ei !== undefined && ei >= 0) polyline.set(ei, joinSegments(pts.subarray(3 * eg[g], 3 * (eg[g] + eg[g + 1]))));
    }
    out.edges = topo.edges.map((e, i) => ({ ...e, points: polyline.get(i) ?? new Float32Array(0) }));
    return out;
  });
}

// a solid that did not change keeps its display data (shapes are never modified in place)
const shown = new WeakMap<TopoDS_Shape, BodyResult>();

/**
 * BuildResult of a design from the timeline cache: bodies whose solid is the one shown
 * before are not tessellated again (only their names may differ).
 */
export function cachedResultOcc(oc: OC, built: OccBuiltDesign): BuildResult {
  const out: BuildResult = { kernel: 'brep', components: {}, placements: built.placements, errors: built.errors, warnings: built.warnings, ...(built.kin ? { kin: built.kin } : {}) };
  for (const [cid, cb] of built.components) {
    out.components[cid] = {
      bodies: cb.bodies.map((b) => {
        let r = shown.get(b.solid.shape);
        if (!r) shown.set(b.solid.shape, (r = bodyResultOcc(oc, b)));
        return { ...r, id: b.id, name: b.name, feature: b.feature };
      }).concat((cb.meshes ?? []).map(meshBodyResult)),
      errors: cb.errors, warnings: cb.warnings, frames: cb.frames, datums: cb.datums,
    };
  }
  return out;
}

/** BuildResult of a built design (it stays built; free it yourself). */
export function builtResultOcc(oc: OC, built: OccBuiltDesign, o: MeshOptions = {}): BuildResult {
  const out: BuildResult = { kernel: 'brep', components: {}, placements: built.placements, errors: built.errors, warnings: built.warnings, ...(built.kin ? { kin: built.kin } : {}) };
  for (const [cid, cb] of built.components) out.components[cid] = { bodies: [...cb.bodies.map((b) => bodyResultOcc(oc, b, o)), ...(cb.meshes ?? []).map(meshBodyResult)], errors: cb.errors, warnings: cb.warnings, frames: cb.frames, datums: cb.datums };
  return out;
}

/** Build the design with OCCT and return its BuildResult (nothing stays in WASM memory). */
export function buildResultOcc(oc: OC, design: CadDesign, numbers: DesignNumbers, o: MeshOptions = {}): BuildResult {
  const built = buildDesignOcc(oc, design, numbers);
  try {
    return builtResultOcc(oc, built, o);
  } finally {
    built.free();
  }
}

/**
 * The design's BuildResult from the B-rep kernel when it is loaded, else from the mesh
 * kernel (approximate faces and edges); null while neither has loaded.
 */
export function buildResult(design: CadDesign, numbers: DesignNumbers, o: MeshOptions = {}): BuildResult | null {
  const oc = occ();
  if (oc) return buildResultOcc(oc, design, numbers, o);
  const K = kernel();
  return K ? meshBuildResult(K, design, numbers) : null;
}
