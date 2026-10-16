// B-rep bodies as BuildResults: a display mesh that knows the face of every triangle,
// the exact faces (surface type, plane frames, cylinder axes and radii, areas) and edges
// (curve type, circle centres, lengths, the two faces they join), exact mass properties
// and boxes. Face keys come from the feature history the solids carry (ops.ts).
import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from 'replicad-opencascadejs';
import type { CadDesign, DesignNumbers } from '../design';
import { edgeKey, meshBuildResult, type BodyMesh, type BodyResult, type BuildResult, type CurveKind, type EdgeInfo, type FaceInfo, type SurfaceKind } from '../buildResult';
import { Arena, add3, cross3, dot3, kernel, norm3, scale3, sub3, type Vec3 } from '../solid';
import { buildDesignOcc, isEmptyShape, occBox, occMass, type OccBody, type OccBuiltDesign } from './build';
import { occ, scratch, shapeIndex, xyz, type OC } from './kernel';

export interface MeshOptions {
  /** Chord deviation of the display mesh as a fraction of the body's size (default 5·10⁻⁴). */
  deflection?: number;
  /** Largest angle between neighbouring mesh normals on a curved face, radians (default 0.1). */
  angle?: number;
}

const INT_MAX = 2147483647;

/** Copy n values from the WASM heap at a byte address (the heap may move: always a fresh view). */
function heap<T extends Float32Array | Uint32Array | Int32Array>(oc: OC, Kind: { new (b: ArrayBuffer, o: number, n: number): T }, ptr: number, n: number): T {
  const view = new Kind(oc.wasmMemory.buffer as ArrayBuffer, ptr >>> 0, n);
  return view.slice() as T;
}

function props(oc: OC, t: Arena, s: TopoDS_Shape, kind: 'surface' | 'linear') {
  const p = t.add(new oc.GProp_GProps());
  if (kind === 'surface') oc.BRepGProp.SurfaceProperties(s, p, false, false);
  else oc.BRepGProp.LinearProperties(s, p, false, false);
  return p;
}

function faceInfo(oc: OC, t: Arena, face: TopoDS_Face, index: number): FaceInfo {
  const S = oc.GeomAbs_SurfaceType;
  const a = t.add(new oc.BRepAdaptor_Surface(face, true));
  const ty = a.GetType();
  const type: SurfaceKind = ty === S.GeomAbs_Plane ? 'plane' : ty === S.GeomAbs_Cylinder ? 'cylinder' : ty === S.GeomAbs_Cone ? 'cone'
    : ty === S.GeomAbs_Sphere ? 'sphere' : ty === S.GeomAbs_Torus ? 'torus' : ty === S.GeomAbs_BSplineSurface || ty === S.GeomAbs_BezierSurface ? 'bspline' : 'other';
  const p = props(oc, t, face, 'surface');
  const info: FaceInfo = { index, key: '', feature: '', type, area: p.Mass() };
  const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  if (type === 'plane') {
    const pos = t.add(t.add(a.Plane()).Position());
    const u = xyz(t.add(pos.XDirection()));
    // the surface normal is X × Y (a mirrored plane's axes are left-handed, so not its
    // Direction), turned out of the material
    const n0 = norm3(cross3(u, xyz(t.add(pos.YDirection()))));
    const n: Vec3 = reversed ? [-n0[0], -n0[1], -n0[2]] : n0;
    info.frame = { o: xyz(t.add(p.CentreOfMass())), u, v: norm3(cross3(n, u)), n };
  } else if (type === 'cylinder') {
    const c = t.add(a.Cylinder()), ax = t.add(c.Axis());
    info.axis = { p: xyz(t.add(ax.Location())), d: xyz(t.add(ax.Direction())) };
    info.radius = c.Radius();
  } else if (type === 'sphere') {
    const sp = t.add(a.Sphere());
    const c = xyz(t.add(sp.Location()));
    info.axis = { p: c, d: [0, 0, 1] };
    info.radius = sp.Radius();
  } else if (type === 'cone') {
    // gp_Cone is not bound; the face's own surface (located) is
    const g = t.add(oc.BRep_Tool.Surface(face)) as unknown as {
      Axis(): { Location(): { X(): number; Y(): number; Z(): number; delete(): void }; Direction(): { X(): number; Y(): number; Z(): number; delete(): void }; delete(): void };
      RefRadius?: () => number; SemiAngle?: () => number;
    };
    if (typeof g.Axis === 'function') {
      const ax = t.add(g.Axis());
      info.axis = { p: xyz(t.add(ax.Location())), d: xyz(t.add(ax.Direction())) };
    }
    if (g.RefRadius && g.SemiAngle) {
      info.radius = g.RefRadius();
      info.angle = Math.abs(g.SemiAngle());
    }
  } else if (type === 'torus') {
    // neither gp_Torus nor Geom_ToroidalSurface is bound: read them off the surface,
    // P(u, v) = C + (R + r cos v)(cos u X + sin u Y) + r sin v Z
    const P = (u: number, v: number) => xyz(t.add(a.Value(u, v)));
    const p0 = P(0, 0), c = scale3(add3(p0, P(Math.PI, 0)), 0.5);
    const x = norm3(sub3(p0, c));
    const outer = dot3(sub3(p0, c), x), inner = dot3(sub3(P(0, Math.PI), c), x);
    const R = (outer + inner) / 2, r = (outer - inner) / 2;
    info.axis = { p: c, d: norm3(sub3(P(0, Math.PI / 2), add3(c, scale3(x, R)))) };
    info.radius = R;
    info.minorRadius = r;
  }
  return info;
}

function edgeInfo(oc: OC, t: Arena, edge: TopoDS_Edge, index: number): Omit<EdgeInfo, 'points' | 'faces' | 'key'> {
  const C = oc.GeomAbs_CurveType;
  const a = t.add(new oc.BRepAdaptor_Curve(edge));
  const ty = a.GetType();
  const type: CurveKind = ty === C.GeomAbs_Line ? 'line' : ty === C.GeomAbs_Circle ? 'circle' : ty === C.GeomAbs_Ellipse ? 'ellipse'
    : ty === C.GeomAbs_BSplineCurve || ty === C.GeomAbs_BezierCurve ? 'bspline' : 'other';
  const info: Omit<EdgeInfo, 'points' | 'faces' | 'key'> = { index, type, length: props(oc, t, edge, 'linear').Mass() };
  if (type === 'circle') {
    const c = t.add(a.Circle()), ax = t.add(c.Axis());
    info.circle = { c: xyz(t.add(c.Location())), axis: xyz(t.add(ax.Direction())), r: c.Radius() };
  } else if (type === 'line') {
    info.line = { a: xyz(t.add(a.EvalD0(a.FirstParameter()))), b: xyz(t.add(a.EvalD0(a.LastParameter()))) };
  }
  return info;
}

/** One body: mesh, faces, edges, mass, box. */
export function bodyResultOcc(oc: OC, body: OccBody, o: MeshOptions = {}): BodyResult {
  const shape = body.solid.shape;
  const empty: BodyMesh = { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), faceOf: new Uint32Array(0) };
  const out: BodyResult = { id: body.id, name: body.name, feature: body.feature, mesh: empty, faces: [], edges: [], mass: { V: 0, c: [0, 0, 0], C: new Array(9).fill(0) }, area: 0, box: null };
  if (isEmptyShape(oc, shape)) return out;
  return scratch((t) => {
    const faces = shapeIndex(oc, t, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
    const edges = shapeIndex(oc, t, shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    out.mass = occMass(oc, shape);
    out.box = occBox(oc, [shape]);
    out.area = props(oc, t, shape, 'surface').Mass();
    // faces with their history keys (the first tag wins where a merge joined several)
    const keyed = new Map<number, { key: string; feature: string }>();
    for (const g of body.solid.tags) {
      const i = faces.indexOf(g.face);
      if (i >= 0 && !keyed.has(i)) keyed.set(i, g);
    }
    out.faces = faces.shapes.map((f, i) => ({ ...faceInfo(oc, t, t.add(oc.TopoDS.Face(f)), i), key: keyed.get(i)?.key ?? '', feature: keyed.get(i)?.feature ?? '' }));
    // the faces on either side of every edge
    const sides = edges.shapes.map(() => [] as number[]);
    faces.shapes.forEach((f, fi) => {
      const ex = t.add(new oc.TopExp_Explorer(f, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
      for (; ex.More(); ex.Next()) {
        const ei = edges.indexOf(t.add(ex.Current()));
        if (ei >= 0) sides[ei].push(fi);
      }
    });
    // display mesh and edge polylines, tessellated by OCCT
    const size = out.box ? Math.hypot(out.box.max[0] - out.box.min[0], out.box.max[1] - out.box.min[1], out.box.max[2] - out.box.min[2]) : 1;
    const tol = Math.max(size * (o.deflection ?? 5e-4), 1e-9), ang = o.angle ?? 0.1;
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
      if (ei !== undefined && ei >= 0) polyline.set(ei, pts.slice(3 * eg[g], 3 * (eg[g] + eg[g + 1])));
    }
    out.edges = edges.shapes.map((e, i) => {
      const [a = -1, b = a] = sides[i];
      return {
        ...edgeInfo(oc, t, t.add(oc.TopoDS.Edge(e)), i),
        key: edgeKey(out.faces[a]?.key, out.faces[b]?.key),
        points: polyline.get(i) ?? new Float32Array(0),
        faces: [a, b] as [number, number],
      };
    });
    return out;
  });
}

/** BuildResult of a built design (it stays built; free it yourself). */
export function builtResultOcc(oc: OC, built: OccBuiltDesign, o: MeshOptions = {}): BuildResult {
  const out: BuildResult = { kernel: 'brep', components: {}, placements: built.placements, errors: built.errors };
  for (const [cid, cb] of built.components) out.components[cid] = { bodies: cb.bodies.map((b) => bodyResultOcc(oc, b, o)), errors: cb.errors };
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
