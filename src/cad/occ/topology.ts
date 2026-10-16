// The named topology of B-rep bodies: every face, edge and vertex with its persistent
// name (topology.ts) and its exact geometry (surface or curve type, plane frames, axes,
// radii, areas, lengths). Names come from the history tags a solid carries (ops.ts):
// faces that merged join their tags, pieces of a split face are told apart by their
// place on the face's own surface, edges and vertices are named after their faces.
//
// A solid never changes, so its topology is worked out once and kept with it.
import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from 'replicad-opencascadejs';
import type { CurveKind, EdgeInfo, FaceInfo, SurfaceKind, VertexInfo } from '../buildResult';
import { edgeKey, faceName, uniqueNames, vertexKey, type BodyTopology, type EdgeFacts } from '../topology';
import { add3, cross3, dot3, len3, norm3, scale3, sub3, type Arena, type Vec3 } from '../solid';
import { occBox, scratch, shapeIndex, xyz, type OC } from './kernel';
import type { OccSolid } from './ops';

export function props(oc: OC, t: Arena, s: TopoDS_Shape, kind: 'surface' | 'linear') {
  const p = t.add(new oc.GProp_GProps());
  if (kind === 'surface') oc.BRepGProp.SurfaceProperties(s, p, false, false);
  else oc.BRepGProp.LinearProperties(s, p, false, false);
  return p;
}

export function faceInfo(oc: OC, t: Arena, face: TopoDS_Face, index: number): FaceInfo {
  const S = oc.GeomAbs_SurfaceType;
  const a = t.add(new oc.BRepAdaptor_Surface(face, true));
  const ty = a.GetType();
  const type: SurfaceKind = ty === S.GeomAbs_Plane ? 'plane' : ty === S.GeomAbs_Cylinder ? 'cylinder' : ty === S.GeomAbs_Cone ? 'cone'
    : ty === S.GeomAbs_Sphere ? 'sphere' : ty === S.GeomAbs_Torus ? 'torus' : ty === S.GeomAbs_BSplineSurface || ty === S.GeomAbs_BezierSurface ? 'bspline' : 'other';
  const p = props(oc, t, face, 'surface');
  const info: FaceInfo = { index, key: '', feature: '', type, area: p.Mass(), c: xyz(t.add(p.CentreOfMass())) };
  const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  if (type === 'plane') {
    const pos = t.add(t.add(a.Plane()).Position());
    const u = xyz(t.add(pos.XDirection()));
    // the surface normal is X × Y (a mirrored plane's axes are left-handed, so not its
    // Direction), turned out of the material
    const n0 = norm3(cross3(u, xyz(t.add(pos.YDirection()))));
    const n: Vec3 = reversed ? [-n0[0], -n0[1], -n0[2]] : n0;
    info.frame = { o: info.c, u, v: norm3(cross3(n, u)), n };
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

export function edgeInfo(oc: OC, t: Arena, edge: TopoDS_Edge, index: number): Omit<EdgeInfo, 'points' | 'faces' | 'key' | 'v'> {
  const C = oc.GeomAbs_CurveType;
  const a = t.add(new oc.BRepAdaptor_Curve(edge));
  const ty = a.GetType();
  const type: CurveKind = ty === C.GeomAbs_Line ? 'line' : ty === C.GeomAbs_Circle ? 'circle' : ty === C.GeomAbs_Ellipse ? 'ellipse'
    : ty === C.GeomAbs_BSplineCurve || ty === C.GeomAbs_BezierCurve ? 'bspline' : 'other';
  const at = (u: number) => xyz(t.add(a.EvalD0(u)));
  const info: Omit<EdgeInfo, 'points' | 'faces' | 'key' | 'v'> = { index, type, length: props(oc, t, edge, 'linear').Mass(), mid: at((a.FirstParameter() + a.LastParameter()) / 2) };
  if (type === 'circle') {
    const c = t.add(a.Circle()), ax = t.add(c.Axis());
    info.circle = { c: xyz(t.add(c.Location())), axis: xyz(t.add(ax.Direction())), r: c.Radius() };
  } else if (type === 'line') {
    info.line = { a: at(a.FirstParameter()), b: at(a.LastParameter()) };
  }
  return info;
}

/** Explorer-ordered sub-shapes, and for each one of `of` the indices of the `sub` ones it holds. */
function within(oc: OC, t: Arena, of: TopoDS_Shape[], sub: ReturnType<typeof shapeIndex>, type: TopAbs_ShapeEnum): number[][] {
  return of.map((s) => {
    const out: number[] = [];
    const ex = t.add(new oc.TopExp_Explorer(s, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
    for (; ex.More(); ex.Next()) {
      const i = sub.indexOf(t.add(ex.Current()));
      if (i >= 0 && !out.includes(i)) out.push(i);
    }
    return out;
  });
}

const named = new WeakMap<TopoDS_Shape, Omit<BodyTopology, 'id'>>();

/**
 * The faces, edges and vertices of a B-rep solid with their names, in explorer order
 * (the order of the display data's face and edge tables).
 */
export function topologyOcc(oc: OC, solid: OccSolid, id: string): BodyTopology {
  let got = named.get(solid.shape);
  if (!got) named.set(solid.shape, (got = nameTopology(oc, solid)));
  return { id, ...got };
}

function nameTopology(oc: OC, solid: OccSolid): Omit<BodyTopology, 'id'> {
  const A = oc.TopAbs_ShapeEnum;
  return scratch((t) => {
    const shape = solid.shape;
    const box = occBox(oc, [shape]);
    const size = box ? Math.max(len3(sub3(box.max, box.min)), 1e-9) : 1;
    const tol = 1e-7 * (1 + size);
    const F = shapeIndex(oc, t, shape, A.TopAbs_FACE), E = shapeIndex(oc, t, shape, A.TopAbs_EDGE), V = shapeIndex(oc, t, shape, A.TopAbs_VERTEX);
    const faceShapes = F.shapes.map((f) => t.add(oc.TopoDS.Face(f)));

    // faces: the history keys reaching each one; merged faces list them all
    const tags = F.shapes.map(() => [] as { key: string; feature: string }[]);
    for (const g of solid.tags) {
      const i = F.indexOf(g.face);
      if (i >= 0) tags[i].push(g);
    }
    const faces = faceShapes.map((f, i) => faceInfo(oc, t, f, i));
    // pieces of a split face share its surface: they go by the middle of their parameter
    // range on it, u then v (on a plane, along its x then y axis)
    const place = (i: number) => {
      const r = oc.BRepTools.UVBounds(faceShapes[i]);
      return [(r.UMin + r.UMax) / 2, (r.VMin + r.VMax) / 2, ...faces[i].c];
    };
    const fkeys = uniqueNames(tags.map((g) => faceName(g.map((x) => x.key))), place, '#', tol);
    faces.forEach((f, i) => {
      f.key = fkeys[i];
      f.feature = [...tags[i]].sort((a, b) => (a.key < b.key ? -1 : 1))[0]?.feature ?? '';
    });

    // edges: named after the two faces they join, several between the same two along the
    // first face's u axis (where it is flat)
    const faceEdges = within(oc, t, F.shapes, E, A.TopAbs_EDGE);
    const sides = E.shapes.map(() => [] as number[]);
    faceEdges.forEach((es, fi) => {
      for (const ei of es) sides[ei].push(fi);
    });
    // a seam has the same face on both sides
    const pairs = sides.map(([a = -1, b = a]) => [a, b] as [number, number]);
    const edgeVerts = within(oc, t, E.shapes, V, A.TopAbs_VERTEX);
    const edges: EdgeFacts[] = E.shapes.map((e, i) => {
      const [v0 = -1, v1 = v0] = edgeVerts[i];
      return { ...edgeInfo(oc, t, t.add(oc.TopoDS.Edge(e)), i), key: '', faces: pairs[i], v: [v0, v1] as [number, number] };
    });
    const along = (i: number) => {
      const [a, b] = pairs[i];
      const first = fkeys[a] <= fkeys[b] ? [a, b] : [b, a];
      const fr = faces[first[0]]?.frame ?? faces[first[1]]?.frame;
      const m = edges[i].mid;
      return fr ? [dot3(m, fr.u), dot3(m, fr.v), ...m] : m;
    };
    const ekeys = uniqueNames(pairs.map(([a, b]) => edgeKey(fkeys[a], fkeys[b]) || '?'), along, '~', tol);
    edges.forEach((e, i) => (e.key = ekeys[i]));

    // vertices: where faces (or, fewer than three, edges) meet
    const vertFaces = V.shapes.map(() => [] as number[]), vertEdges = V.shapes.map(() => [] as number[]);
    within(oc, t, F.shapes, V, A.TopAbs_VERTEX).forEach((vs, fi) => vs.forEach((vi) => vertFaces[vi].push(fi)));
    edgeVerts.forEach((vs, ei) => vs.forEach((vi) => vertEdges[vi].push(ei)));
    const points = V.shapes.map((v) => xyz(t.add(oc.BRep_Tool.Pnt(t.add(oc.TopoDS.Vertex(v))))));
    const vkeys = uniqueNames(V.shapes.map((_, i) => vertexKey(vertFaces[i].map((f) => fkeys[f]), vertEdges[i].map((e) => ekeys[e]))), (i) => points[i], '~', tol);
    const vertices: VertexInfo[] = V.shapes.map((_, i) => ({ index: i, key: vkeys[i], p: points[i], edges: vertEdges[i] }));
    return { faces, edges, vertices, box, named: true };
  });
}
