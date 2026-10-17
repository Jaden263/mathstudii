// Drawing views from the exact solids: OpenCascade's hidden-line removal (HLRBRep_Algo,
// the exact one, not the polygonal) of the visible bodies seen along a view, read back as
// lines, circles, ellipses and B-splines in the plane of the paper (drawing2d.ts). A
// section keeps the part of every body beyond the cutting plane (a boolean with a
// half-space box) and outlines its cut faces where the plane meets the body
// (BRepAlgoAPI_Section). Axes of holes and shafts come from their cylindrical faces, and
// cosmetic threads are lines that the hidden-line removal hides like any edge.
//
// The exact HLR takes minutes on helical faces (a modeled M12 thread seen along its axis:
// over two), so bodies with coils and modeled threads are drawn from their facets: their
// lines are hidden by every body's facets, and the others' exact lines where a coil's
// facets lie in front of them.
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { BuildResult } from '../buildResult';
import type { CadDesign, ThreadMark } from '../design';
import { Occluder, projectView, type DrawMesh, type ViewSpec } from '../drawing';
import {
  overlayPrims, primAt, primLength, primsBox, recognise, subPrim, type DrawView, type DrawViewRequest, type Prim, type ViewAxis,
} from '../drawing2d';
import { weldedMesh } from '../display';
import { chainLoops } from '../outline';
import { add3, cross3, dot3, frameFromNormal, len3, m4Dir, m4Point, norm3, scale3, sub3, type Arena, type M4, type Vec3 } from '../solid';
import { occBox, type OccBuiltDesign } from './build';
import { ax2, guard, hasSolid, pnt, scratch, subShapes, trsf, xyz, type OC } from './kernel';
import { cleared, common, placedBodies } from './query';
import { cachedResultOcc, heap } from './result';

const { abs, atan2, sqrt, min, max, PI } = Math;

interface Placed {
  occ: string;
  component: string;
  body: string;
  /** Place among the drawing's bodies (hatching). */
  index: number;
  M: M4;
  /** In the assembly; for a section, what is left of it. */
  shape: TopoDS_Shape;
  helical: boolean;
}

/**
 * Whether a body has faces the exact hidden-line removal cannot take in reasonable time:
 * a coil, a sweep along a coil, a modeled thread's groove.
 */
function helical(design: CadDesign, component: string, tags: { key: string }[]): boolean {
  const comp = design.components.find((c) => c.id === component);
  return tags.some((g) => {
    if (/:groove$/.test(g.key)) return true;
    // the feature behind the face, past any pattern or mirror prefixes
    const id = g.key.split('/')[0].replace(/^(?:[^.]+\.\d+\.)+/, '');
    const item = comp?.items.find((i) => i.id === id);
    return item?.kind === 'coil' || (item?.kind === 'sweep' && item.path.kind === 'coil');
  });
}

/** The axes of a view in assembly coordinates. */
function frameOf(req: DrawViewRequest) {
  const d = norm3(req.dir);
  const right = norm3(cross3(d, req.up));
  return { d, right, up: cross3(right, d) };
}

/** One view of the visible bodies of a built design, by OpenCascade's exact hidden-line removal. */
export function drawViewOcc(oc: OC, built: OccBuiltDesign, design: CadDesign, req: DrawViewRequest): DrawView {
  return scratch((t) => {
    const { d, right, up } = frameOf(req);
    const to2 = (q: Vec3): [number, number] => [dot3(q, right), dot3(q, up)];
    const placed: Placed[] = [];
    placedBodies(built, design).forEach((pb, index) => {
      if (!hasSolid(oc, pb.shape)) return;
      const shape = t.add(t.add(new oc.BRepBuilderAPI_Transform(pb.shape, trsf(oc, t, pb.M), false, false)).Shape());
      const tags = built.components.get(pb.component)?.bodies.find((b) => b.id === pb.id)?.solid.tags ?? [];
      placed.push({ occ: pb.occ, component: pb.component, body: pb.id, index, M: pb.M, shape, helical: helical(design, pb.component, tags) });
    });
    const box = occBox(oc, placed.map((p) => p.shape));
    const view: DrawView = { name: req.name, visible: [], hidden: [], tangent: [], thin: [], axes: [], box: { x0: 0, y0: 0, x1: 0, y1: 0 } };
    if (!box) return view;
    const size = len3(sub3(box.max, box.min)) || 1;
    const eps = size * 1e-5;

    // a section: what lies beyond the plane, and the outline of the cut faces
    let shown = placed;
    if (req.cut) {
      const o = req.cut;
      view.cuts = [];
      shown = [];
      for (const p of placed) {
        const kept = keptBeyond(oc, t, p.shape, o, d);
        if (!kept) continue;
        shown.push({ ...p, shape: kept });
        const loops = cutLoops(oc, t, p.shape, o, d, right, size);
        if (loops.length) view.cuts.push({ body: `${p.occ}/${p.body}`, index: p.index, loops });
      }
    }
    const exact = shown.filter((p) => !p.helical), facetted = shown.filter((p) => p.helical);

    // cylinders and cones: centre marks and lines, and where cosmetic threads may run
    const cyls = cylinders(oc, t, exact.map((p) => p.shape));
    view.axes = axesSeen(cyls, d, to2);

    // cosmetic threads as edges of their own, hidden by the bodies like any other
    const marks = threadMarks(built, design, exact, cyls);
    const lines = threadEdges(oc, t, marks, d, right, req.cut, eps);

    const visible: Prim[] = [], hidden: Prim[] = [], tangent: Prim[] = [], thin: Prim[] = [];
    if (exact.length) {
      const algo = t.add(new oc.HLRBRep_Algo());
      for (const p of exact) algo.Add(p.shape, 0);
      for (const c of [lines.roots, lines.limits, lines.ends]) if (c) algo.Add(c, 0);
      algo.Projector(t.add(new oc.HLRAlgo_Projector(ax2(oc, t, [0, 0, 0], scale3(d, -1), right))));
      guard(oc, 'the hidden lines could not be found', () => {
        algo.Update();
        algo.Hide();
      });
      const h = t.add(new oc.HLRBRep_HLRToShape(algo));
      const read = (c: TopoDS_Shape, out: Prim[]) => {
        if (!c.IsNull()) out.push(...edgePrims(oc, t, c, size));
      };
      for (const p of exact) {
        read(t.add(h.VCompound(p.shape)), visible);
        read(t.add(h.OutLineVCompound(p.shape)), visible);
        read(t.add(h.Rg1LineVCompound(p.shape)), tangent);
        if (req.hidden) {
          read(t.add(h.HCompound(p.shape)), hidden);
          read(t.add(h.OutLineHCompound(p.shape)), hidden);
        }
      }
      if (lines.roots) {
        read(t.add(h.VCompound(lines.roots)), thin);
        if (req.hidden) read(t.add(h.HCompound(lines.roots)), hidden);
      }
      if (lines.limits) {
        read(t.add(h.VCompound(lines.limits)), visible);
        if (req.hidden) read(t.add(h.HCompound(lines.limits)), hidden);
      }
      // a hidden ¾ circle in an end view is left out
      if (lines.ends) read(t.add(h.VCompound(lines.ends)), thin);
    }

    if (facetted.length) {
      view.mesh = exact.length ? 'some' : 'all';
      const display = req.cut ? null : cachedResultOcc(oc, built);
      const meshes = shown.map((p) => meshOf(oc, t, display, p, size));
      const spec: ViewSpec = { name: req.name, dir: d, up };
      const fromMesh = projectView(meshes, spec, { hidden: req.hidden, drawn: (i) => shown[i].helical });
      const segs = (s: number[]): Prim[] => {
        const out: Prim[] = [];
        for (let i = 0; i + 3 < s.length; i += 4) out.push({ k: 'line', x1: s[i], y1: s[i + 1], x2: s[i + 2], y2: s[i + 3] });
        return out;
      };
      // the exact lines where a coil's facets lie in front of them
      if (exact.length) {
        const front = new Occluder(meshes.filter((_, i) => !shown[i].helical), spec);
        const coils = new Occluder(meshes.filter((_, i) => shown[i].helical), spec);
        const split = (ps: Prim[], keep: Prim[], behind: Prim[] | null) => {
          const out: Prim[] = [];
          for (const p of ps) {
            for (const [s0, s1, hid] of occludedRuns(p, front, coils, size)) {
              const q = subPrim(p, s0, s1);
              if (!hid) out.push(q);
              else behind?.push(q);
            }
          }
          keep.splice(0, keep.length, ...out);
        };
        split(visible, visible, req.hidden ? hidden : null);
        split(tangent, tangent, null);
        split(thin, thin, req.hidden ? hidden : null);
      }
      visible.push(...segs(fromMesh.visible));
      hidden.push(...segs(fromMesh.hidden));
    }

    [view.visible, view.tangent, view.hidden] = overlayPrims([visible, tangent, hidden], size);
    [view.thin] = overlayPrims([thin], size);
    view.box = primsBox(view.visible, view.hidden, view.tangent, view.thin);
    if (!(view.box.x1 >= view.box.x0)) view.box = { x0: 0, y0: 0, x1: 0, y1: 0 };
    return view;
  });
}

// ------------------------------------------------------------ sections

/**
 * What of a shape lies on the far side of the plane through o square to n (the side n
 * points to): the shape itself, its common part with a half-space box, or null.
 */
function keptBeyond(oc: OC, t: Arena, shape: TopoDS_Shape, o: Vec3, n: Vec3): TopoDS_Shape | null {
  const box = occBox(oc, [shape]);
  if (!box) return null;
  const c: Vec3 = scale3(add3(box.min, box.max), 0.5);
  const r = len3(sub3(box.max, box.min)) / 2 || 1;
  const h = dot3(sub3(c, o), n);
  if (h <= -r) return null;
  if (h >= r) return shape;
  const f = frameFromNormal(sub3(c, scale3(n, h)), n);
  const R = r * 1.05 + 1e-6;
  const corner = sub3(f.o, scale3(add3(f.u, f.v), R));
  const half = t.add(t.add(new oc.BRepPrimAPI_MakeBox(ax2(oc, t, corner, f.n, f.u), 2 * R, 2 * R, h + R)).Shape());
  return common(oc, t, shape, half, 'the section view could not be cut');
}

/** The closed outlines a plane cuts from a shape, in the view's coordinates. */
function cutLoops(oc: OC, t: Arena, shape: TopoDS_Shape, o: Vec3, n: Vec3, right: Vec3, size: number): number[][] {
  const up = cross3(right, n);
  const pln = t.add(new oc.gp_Pln(t.add(new oc.gp_Ax3(pnt(oc, t, o), t.add(new oc.gp_Dir(n[0], n[1], n[2])), t.add(new oc.gp_Dir(right[0], right[1], right[2]))))));
  const op = t.add(new oc.BRepAlgoAPI_Section(shape, pln, false));
  try {
    guard(oc, 'the section view could not be cut', () => op.Build(t.add(new oc.Message_ProgressRange())));
    if (op.HasErrors()) return [];
    const pieces: { x: number; y: number }[][] = [];
    for (const e of subShapes(oc, t, t.add(op.Shape()), oc.TopAbs_ShapeEnum.TopAbs_EDGE)) {
      const a = t.add(new oc.BRepAdaptor_Curve(t.add(oc.TopoDS.Edge(e))));
      const at = (u: number): [number, number] => {
        const q = xyz(t.add(a.EvalD0(u)));
        return [dot3(q, right), dot3(q, up)];
      };
      const pts = curvePoints(oc, a, at, size * 2e-5);
      const piece: { x: number; y: number }[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) piece.push({ x: pts[i], y: pts[i + 1] });
      pieces.push(piece);
    }
    return chainLoops(pieces, size * 1e-6 + 1e-9)
      .filter((l) => l.length >= 3)
      .map((l) => l.flatMap((q) => [q.x, q.y]));
  } finally {
    cleared(oc, op);
  }
}

// ------------------------------------------------------------ curves of the projection

/** Points along a curve: a line's two ends, an arc by its angle, anything else subdivided until flat within tol. */
function curvePoints(oc: OC, a: InstanceType<OC['BRepAdaptor_Curve']>, at: (u: number) => [number, number], tol: number): number[] {
  const C = oc.GeomAbs_CurveType;
  const u0 = a.FirstParameter(), u1 = a.LastParameter(), ty = a.GetType();
  if (ty === C.GeomAbs_Line) return [...at(u0), ...at(u1)];
  if (ty === C.GeomAbs_Circle) {
    const r = scratch((s) => s.add(a.Circle()).Radius());
    const step = r > tol ? 2 * Math.acos(max(-1, 1 - tol / r)) : PI / 8;
    const n = max(4, Math.ceil((u1 - u0) / max(step, 1e-3)));
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(...at(u0 + ((u1 - u0) * i) / n));
    return out;
  }
  // 32 even steps, each halved while its middle is off the chord (8 times at most)
  const out: number[] = [...at(u0)];
  const rec = (ua: number, pa: [number, number], ub: number, pb: [number, number], depth: number) => {
    const um = (ua + ub) / 2, pm = at(um);
    const dx = pb[0] - pa[0], dy = pb[1] - pa[1], l = Math.hypot(dx, dy);
    const off = l > 0 ? abs((pm[0] - pa[0]) * dy - (pm[1] - pa[1]) * dx) / l : Math.hypot(pm[0] - pa[0], pm[1] - pa[1]);
    if (depth < 8 && off > tol) {
      rec(ua, pa, um, pm, depth + 1);
      rec(um, pm, ub, pb, depth + 1);
    } else out.push(...pb);
  };
  const N = 32;
  let pa = at(u0);
  for (let i = 1; i <= N; i++) {
    const ub = u0 + ((u1 - u0) * i) / N, pb = at(ub);
    rec(u0 + ((u1 - u0) * (i - 1)) / N, pa, ub, pb, 0);
    pa = pb;
  }
  return out;
}

/** The edges of an HLR result (2-D edges in the projection plane) as primitives. */
function edgePrims(oc: OC, t: Arena, c: TopoDS_Shape, size: number): Prim[] {
  const C = oc.GeomAbs_CurveType;
  const out: Prim[] = [];
  for (const e of subShapes(oc, t, c, oc.TopAbs_ShapeEnum.TopAbs_EDGE)) {
    const E = t.add(oc.TopoDS.Edge(e));
    // the result has curves on the projection plane only
    oc.BRepLib.BuildCurves3d(E);
    const a = t.add(new oc.BRepAdaptor_Curve(E));
    const u0 = a.FirstParameter(), u1 = a.LastParameter(), ty = a.GetType();
    if (!(u1 > u0)) continue;
    const at = (u: number): [number, number] => {
      const q = t.add(a.EvalD0(u));
      return [q.X(), q.Y()];
    };
    if (ty === C.GeomAbs_Line) {
      const [x1, y1] = at(u0), [x2, y2] = at(u1);
      out.push({ k: 'line', x1, y1, x2, y2 });
    } else if (ty === C.GeomAbs_Circle) {
      const circ = t.add(a.Circle());
      const [cx, cy] = xyz(t.add(circ.Location()));
      const ccw = t.add(t.add(circ.Axis()).Direction()).Z() > 0;
      const p0 = at(u0), th = atan2(p0[1] - cy, p0[0] - cx), span = min(u1 - u0, 2 * PI);
      out.push({ k: 'arc', cx, cy, r: circ.Radius(), a0: ccw ? th : th - span, a1: ccw ? th + span : th });
    } else if (ty === C.GeomAbs_Ellipse) {
      const el = t.add(a.Ellipse());
      const [cx, cy] = xyz(t.add(el.Location()));
      const X = xyz(t.add(t.add(el.XAxis()).Direction())), Y = xyz(t.add(t.add(el.YAxis()).Direction()));
      const ccw = X[0] * Y[1] - X[1] * Y[0] > 0;
      out.push({ k: 'ellipse', cx, cy, rx: el.MajorRadius(), ry: el.MinorRadius(), rot: atan2(X[1], X[0]), t0: ccw ? u0 : -u1, t1: ccw ? u1 : -u0 });
    } else {
      // B-splines: a line or an arc if that is what they are (a circle seen edge-on), else fine polylines
      out.push(recognise(curvePoints(oc, a, at, size * 2e-5), size * 1e-7));
    }
  }
  return out;
}

// ------------------------------------------------------------ axes and threads

interface Cyl {
  p: Vec3;
  d: Vec3;
  r: number;
  /** Extent along d from p. */
  t0: number;
  t1: number;
  /** The angle it goes round its axis. */
  span: number;
}

/**
 * Cylinders (and cones) that go round half a turn or more: holes, shafts, slot ends, not
 * roundings. Faces of one cylinder count together: a boolean splits a cylinder at its seam.
 */
function cylinders(oc: OC, t: Arena, shapes: TopoDS_Shape[]): Cyl[] {
  const all = shapes.flatMap((s) => cylinderFaces(oc, t, s));
  const tol = 1e-7 * all.reduce((m, c) => max(m, c.r, abs(c.t1 - c.t0)), 1e-9);
  const same = (a: Cyl, b: Cyl) => abs(abs(dot3(a.d, b.d)) - 1) < 1e-9 && abs(a.r - b.r) < tol && len3(sub3(sub3(b.p, a.p), scale3(a.d, dot3(sub3(b.p, a.p), a.d)))) < tol;
  return all.filter((c) => all.reduce((s, q) => s + (same(c, q) ? q.span : 0), 0) >= PI - 1e-3);
}

function cylinderFaces(oc: OC, t: Arena, shape: TopoDS_Shape): Cyl[] {
  const S = oc.GeomAbs_SurfaceType;
  const out: Cyl[] = [];
  for (const f of subShapes(oc, t, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE)) {
    const face = t.add(oc.TopoDS.Face(f));
    const a = t.add(new oc.BRepAdaptor_Surface(face, true));
    const ty = a.GetType();
    if (ty !== S.GeomAbs_Cylinder && ty !== S.GeomAbs_Cone) continue;
    const { UMin, UMax, VMin, VMax } = oc.BRepTools.UVBounds(face);
    let p: Vec3, d: Vec3;
    if (ty === S.GeomAbs_Cylinder) {
      const ax = t.add(t.add(a.Cylinder()).Axis());
      p = xyz(t.add(ax.Location()));
      d = norm3(xyz(t.add(ax.Direction())));
    } else {
      // gp_Cone is not bound: the axis through the centres of the face's two end circles
      const c0 = coneCentre(t, a, UMin, VMin), c1 = coneCentre(t, a, UMin, VMax);
      if (len3(sub3(c1, c0)) < 1e-12) continue;
      p = c0;
      d = norm3(sub3(c1, c0));
    }
    // v runs along the axis on both: the ends of the face from its corners
    const q0 = xyz(t.add(a.Value(UMin, VMin))), q1 = xyz(t.add(a.Value(UMin, VMax)));
    const s0 = dot3(sub3(q0, p), d), s1 = dot3(sub3(q1, p), d);
    const radial = (q: Vec3, s: number) => len3(sub3(sub3(q, p), scale3(d, s)));
    out.push({ p, d, r: max(radial(q0, s0), radial(q1, s1)), t0: min(s0, s1), t1: max(s0, s1), span: UMax - UMin });
  }
  return out;
}

/** Centre of the circle a surface of revolution's parameter line v makes (three points on it). */
function coneCentre(t: Arena, a: InstanceType<OC['BRepAdaptor_Surface']>, u: number, v: number): Vec3 {
  const A = xyz(t.add(a.Value(u, v))), B = xyz(t.add(a.Value(u + (2 * PI) / 3, v))), C = xyz(t.add(a.Value(u + (4 * PI) / 3, v)));
  return scale3(add3(add3(A, B), C), 1 / 3);
}

/** Centre marks for axes seen end-on and centre lines for axes seen side-on (coaxial faces merged). */
function axesSeen(cyls: Cyl[], d: Vec3, to2: (q: Vec3) => [number, number]): ViewAxis[] {
  const groups: { p: Vec3; d: Vec3; r: number; t0: number; t1: number }[] = [];
  const size = cyls.reduce((s, c) => max(s, c.r, abs(c.t1 - c.t0)), 0) || 1;
  const tol = size * 1e-7;
  for (const c of cyls) {
    const g = groups.find((q) => abs(abs(dot3(q.d, c.d)) - 1) < 1e-9 && len3(sub3(sub3(c.p, q.p), scale3(q.d, dot3(sub3(c.p, q.p), q.d)))) < tol);
    const a = g ? dot3(sub3(c.p, g.p), g.d) : 0, s = g ? Math.sign(dot3(c.d, g.d)) : 1;
    const t0 = a + s * c.t0, t1 = a + s * c.t1;
    if (g) {
      g.r = max(g.r, c.r);
      g.t0 = min(g.t0, t0, t1);
      g.t1 = max(g.t1, t0, t1);
    } else groups.push({ p: c.p, d: c.d, r: c.r, t0: min(t0, t1), t1: max(t0, t1) });
  }
  const out: ViewAxis[] = [];
  for (const g of groups) {
    const c = abs(dot3(g.d, d));
    if (c > 1 - 1e-9) {
      const [x, y] = to2(g.p);
      out.push({ kind: 'mark', x, y, r: g.r });
    } else if (c < 1e-9) {
      const [x1, y1] = to2(add3(g.p, scale3(g.d, g.t0))), [x2, y2] = to2(add3(g.p, scale3(g.d, g.t1)));
      out.push({ kind: 'line', x1, y1, x2, y2 });
    }
  }
  return out;
}

interface PlacedMark extends ThreadMark {
  /** The thread's run along the axis, kept to its face. */
  a: number;
  b: number;
  /** Limit lines at the start and at the end (ISO 6410: where the full thread stops). */
  limitA: boolean;
  limitB: boolean;
}

/**
 * The cosmetic threads of the bodies drawn exactly, in the assembly, kept to the faces
 * they are on (a tapped hole's runs where the hole is; a section's, where the half left is).
 */
function threadMarks(built: OccBuiltDesign, design: CadDesign, exact: Placed[], cyls: Cyl[]): PlacedMark[] {
  const out: PlacedMark[] = [];
  const occs = new Map<string, Placed[]>();
  for (const p of exact) occs.set(p.occ, [...(occs.get(p.occ) ?? []), p]);
  for (const [occ, ps] of occs) {
    const o = design.occurrences.find((q) => q.id === occ);
    const marks = (o && built.components.get(o.component)?.threads) ?? [];
    const M = ps[0].M;
    for (const m of marks) {
      if (m.body && !ps.some((p) => p.body === m.body)) continue;
      const mo = m4Point(M, m.o), ax = norm3(m4Dir(M, m.axis));
      const tol = 1e-6 * max(m.R, m.d);
      // the faces it may run on: coaxial, of its radius
      const on = cyls.filter((c) => abs(abs(dot3(c.d, ax)) - 1) < 1e-9 && abs(c.r - m.R) < tol + 1e-9 * m.R
        && len3(sub3(sub3(c.p, mo), scale3(ax, dot3(sub3(c.p, mo), ax)))) < tol);
      if (!on.length) continue;
      let f0 = Infinity, f1 = -Infinity;
      for (const c of on) for (const s of [c.t0, c.t1]) {
        const z = dot3(sub3(add3(c.p, scale3(c.d, s)), mo), ax);
        f0 = min(f0, z);
        f1 = max(f1, z);
      }
      const a = max(m.z0, f0), b = min(m.z1 ?? Infinity, f1);
      if (!(b > a + tol)) continue;
      out.push({ ...m, o: mo, axis: ax, a, b, limitA: a > f0 + tol, limitB: b < f1 - tol });
    }
  }
  return out;
}

/**
 * The lines of cosmetic threads (ISO 6410), placed where hiding them by the bodies says
 * whether they show: an external thread's root line just off the threaded surface on the
 * viewer's side (it shows where that surface does), an internal one's in the plane of the
 * axis (inside the material: hidden, unless a section took the material away), ¾ circles
 * at the end nearest the viewer. Lines a section takes away are put on its plane.
 */
function threadEdges(oc: OC, t: Arena, marks: PlacedMark[], d: Vec3, right: Vec3, cut: Vec3 | undefined, eps: number) {
  const roots: TopoDS_Shape[] = [], limits: TopoDS_Shape[] = [], ends: TopoDS_Shape[] = [];
  /** A point a section took away goes onto the plane, just before it. */
  const kept = (q: Vec3): Vec3 => {
    if (!cut) return q;
    const s = dot3(sub3(q, cut), d);
    return s >= -eps ? q : add3(q, scale3(d, -s - eps));
  };
  const line = (a: Vec3, b: Vec3) => t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, t, kept(a)), pnt(oc, t, kept(b)))).Edge());
  const inCut = (q: Vec3) => !cut || dot3(sub3(q, cut), d) >= -eps;
  for (const m of marks) {
    const c = dot3(m.axis, d);
    const P = (z: number) => add3(m.o, scale3(m.axis, z));
    const root = (m.internal ? m.d : m.d1) / 2;
    const toViewer = (h: number) => scale3(d, -h);
    if (abs(c) < 1e-6) {
      // side-on: two root lines and the limit lines across the major diameter
      const s = norm3(cross3(m.axis, d));
      const depth = toViewer(m.internal ? eps : sqrt(max(m.R * m.R - root * root, 0)) + eps);
      for (const sg of [1, -1]) {
        const off = add3(scale3(s, sg * root), depth);
        roots.push(line(add3(P(m.a), off), add3(P(m.b), off)));
      }
      const across = toViewer(m.internal ? eps : m.R + eps);
      for (const [z, on] of [[m.a, m.limitA], [m.b, m.limitB]] as const) {
        if (!on) continue;
        limits.push(line(add3(add3(P(z), scale3(s, m.d / 2)), across), add3(add3(P(z), scale3(s, -m.d / 2)), across)));
      }
    } else if (abs(c) > 1 - 1e-6) {
      // end-on: a ¾ circle at the root, open in the upper right quadrant, at the end nearest the viewer
      const za = dot3(P(m.a), d), zb = dot3(P(m.b), d);
      let z = za <= zb ? m.a : m.b;
      if (cut) {
        const sa = dot3(sub3(P(m.a), cut), d), sb = dot3(sub3(P(m.b), cut), d);
        // the plane cuts across the thread: the circle is on the cut face
        if (sa * sb < 0) z = m.a + ((m.b - m.a) * sa) / (sa - sb);
        else if (!inCut(P(z)) && !inCut(P(z === m.a ? m.b : m.a))) continue;
        else if (!inCut(P(z))) z = z === m.a ? m.b : m.a;
      }
      const centre = add3(P(z), toViewer(eps));
      const circ = t.add(new oc.gp_Circ(ax2(oc, t, centre, scale3(d, -1), right), root));
      ends.push(t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(circ, (100 * PI) / 180, (370 * PI) / 180)).Edge()));
    }
  }
  const comp = (es: TopoDS_Shape[]) => {
    if (!es.length) return null;
    const c = t.add(new oc.TopoDS_Compound());
    const b = t.add(new oc.TopoDS_Builder());
    b.MakeCompound(c);
    for (const e of es) b.Add(c, e);
    return c;
  };
  return { roots: comp(roots), limits: comp(limits), ends: comp(ends) };
}

// ------------------------------------------------------------ bodies drawn from their facets

/** Facets of a placed body: its display mesh, or (a section's half) a tessellation of what is left. */
function meshOf(oc: OC, t: Arena, display: BuildResult | null, p: Placed, size: number): DrawMesh {
  const body = display?.components[p.component]?.bodies.find((b) => b.id === p.body);
  if (body) return weldedMesh(body, p.M);
  const raw = t.add(oc.ReplicadMeshExtractor.extract(p.shape, max(size * 5e-4, 1e-9), 0.25, false));
  const P = heap(oc, Float32Array, raw.getVerticesPtr(), raw.getVerticesSize());
  const I = heap(oc, Uint32Array, raw.getTrianglesPtr(), raw.getTrianglesSize());
  // vertices that coincide are one (faces meet along edges tessellated once)
  const index = new Map<string, number>(), map = new Uint32Array(P.length / 3), pos: number[] = [];
  for (let v = 0; v < map.length; v++) {
    const k = `${P[3 * v]},${P[3 * v + 1]},${P[3 * v + 2]}`;
    let i = index.get(k);
    if (i === undefined) {
      index.set(k, (i = pos.length / 3));
      pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
    }
    map[v] = i;
  }
  return { pos: new Float64Array(pos), tri: Uint32Array.from(I, (i) => map[i]) };
}

/**
 * Runs [s0, s1, hidden] of a primitive: hidden where a facetted body is nearer the viewer
 * than the exact surface the line lies on (the nearest of the exact bodies' facets there).
 */
function occludedRuns(p: Prim, exact: Occluder, coils: Occluder, size: number): [number, number, boolean][] {
  const n = max(2, min(2000, Math.ceil(primLength(p) / (size / 400))));
  const reach = size * 2e-3, tol = size * 1e-4;
  const runs: [number, number, boolean][] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = primAt(p, (i + 0.5) / n);
    // where the exact bodies' facets miss the line (past an outline), it is left visible
    const de = exact.frontDepth(x, y, reach);
    const hid = de < Infinity && coils.frontDepth(x, y) < de - tol;
    const last = runs[runs.length - 1];
    if (last && last[2] === hid) last[1] = (i + 1) / n;
    else runs.push([i / n, (i + 1) / n, hid]);
  }
  return runs;
}
