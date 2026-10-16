// Sweeps on the B-rep kernel: a profile along a path (BRepOffsetAPI_MakePipeShell), the
// helix of a coil and the groove of a screw thread, and points along edges.
//
// - The path (spine) is made of exact lines, arcs and circles, a helix on a cylinder (its
//   3-D curve approximated to 10⁻⁷) or the edges of a body. Where it turns a corner the
//   pieces meet mitred (right corner).
// - Perpendicular sweeps keep the profile square to the path (corrected Frenet); parallel
//   ones only move it; coils and threads turn it about their axis only (a fixed binormal),
//   so a thread's profile stays in its axial plane.
// - A twist makes OCCT point the profile at an auxiliary path that turns about the spine
//   (an interpolated curve, sweep.ts); a taper scales it by a linear law from 1 to k.
// - Before anything is built the path is checked against the profile (sweepClash): OCCT
//   makes a "valid" solid of a sweep that cuts through itself.
import type { NCollection_List_TopoDS_Shape, TopoDS_Edge, TopoDS_Shape, TopoDS_Wire } from 'replicad-opencascadejs';
import type { ProfileRegion } from '../profile';
import { add3, cross3, len3, norm3, scale3, sub3, type Arena, type Frame, type Vec3 } from '../solid';
import { sweepClash, twistGuide, type Helix, type PathGeom, type PathSample, type SweepOptions, type ThreadGeom } from '../sweep';
import { loopWire, reversedLoop, type TaggedEdge } from './geometry';
import { ax2, dir, guard, pnt, scratch, shapeIndex, xyz, type OC } from './kernel';
import type { FaceTag, OccSolid } from './ops';

/** What the sweeps borrow from the rest of the kernel's operations (ops.ts). */
export interface SweepKit {
  keep<T extends { delete(): void }>(t: Arena, x: T): T;
  generated(mk: { Generated(s: TopoDS_Shape): NCollection_List_TopoDS_Shape }, edges: TaggedEdge[], key: (entity: string) => string, feature: string): FaceTag[];
  capTags(t: Arena, cap: TopoDS_Shape, key: string, feature: string): FaceTag[];
  within(tags: FaceTag[], shape: TopoDS_Shape): FaceTag[];
  boolean(kind: 'fuse' | 'cut' | 'common', a: OccSolid, tools: OccSolid[], what: string): OccSolid;
  featureOf(tag: string): string;
  /** Throws `what` unless the shape is a sound solid of positive volume. */
  sound(t: Arena, shape: TopoDS_Shape, what: string): void;
  volume(s: TopoDS_Shape): number;
}

// 8-point Gauss–Legendre on [0, 1]: arc lengths of curved edges
const GL = [
  [0.0198550717512319, 0.0506142681451881], [0.1016667612931866, 0.1111905172266872], [0.2372337950418355, 0.1568533229389436], [0.4082826787521751, 0.1813418916891810],
  [0.5917173212478249, 0.1813418916891810], [0.7627662049581645, 0.1568533229389436], [0.8983332387068134, 0.1111905172266872], [0.9801449282487681, 0.0506142681451881],
];

export function sweepOps(oc: OC, kit: SweepKit) {
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const progress = (t: Arena) => t.add(new oc.Message_ProgressRange());
  const vertex = (t: Arena, p: Vec3) => t.add(t.add(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, t, p))).Vertex());

  /** The 3-D curve of an edge: point, first and second derivative at parameter u. */
  const curveOf = (t: Arena, e: TopoDS_Edge) => {
    const c = t.add(new oc.BRepAdaptor_Curve(e));
    const P = t.add(new oc.gp_Pnt(0, 0, 0)), V1 = t.add(new oc.gp_Vec(0, 0, 0)), V2 = t.add(new oc.gp_Vec(0, 0, 0));
    return {
      u0: c.FirstParameter(), u1: c.LastParameter(),
      d2(u: number) {
        c.D2(u, P, V1, V2);
        return { p: xyz(P), d1: xyz(V1), d2: xyz(V2) };
      },
    };
  };

  /**
   * A helix: lines on the unrolled cylinder, one edge per turn, their 3-D curves approximated
   * to 10⁻⁷. In one edge of many turns the swept faces wind round many times, and booleans
   * with them fail for some start angles (a thread cut leaving the shaft whole or empty).
   */
  const helixWire = (t: Arena, h: Helix): { wire: TopoDS_Wire; edges: TopoDS_Edge[] } => guard(oc, 'the helix cannot be made', () => {
    // the cylinder's own frame: u turns anticlockwise about its z; a left-hand helix turns the other way
    const ax3 = t.add(new oc.gp_Ax3(pnt(oc, t, h.o), dir(oc, t, h.axis), dir(oc, t, h.x)));
    const surf = t.add(new oc.Geom_CylindricalSurface(ax3, h.r));
    const s = h.left ? -1 : 1;
    const line = t.add(new oc.Geom2d_Line(t.add(new oc.gp_Pnt2d(0, 0)), t.add(new oc.gp_Dir2d(s * 2 * Math.PI, h.pitch))));
    const turn = Math.hypot(2 * Math.PI, h.pitch);
    const n = Math.max(1, Math.ceil(h.turns - 1e-9));
    const mw = t.add(new oc.BRepBuilderAPI_MakeWire());
    const edges: TopoDS_Edge[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * h.turns * turn, b = ((k + 1) / n) * h.turns * turn;
      const seg = t.add(new oc.GC_MakeSegment2d(t.add(line.EvalD0(a)), t.add(line.EvalD0(b))));
      const edge = t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(t.add(seg.Value()), surf)).Edge());
      oc.BRepLib.BuildCurves3d(edge, 1e-7, oc.GeomAbs_Shape.GeomAbs_C2, 14, 16);
      mw.Add(edge);
      edges.push(edge);
    }
    if (!mw.IsDone()) throw new Error('the helix cannot be made');
    return { wire: t.add(mw.Wire()), edges };
  });

  /** The spine of a sweep: its wire and its edges in order. */
  const spineOf = (t: Arena, path: PathGeom<OccSolid>): { wire: TopoDS_Wire; edges: TopoDS_Edge[] } => guard(oc, 'the path cannot be made', () => {
    if (path.kind === 'helix') return helixWire(t, path.helix);
    const mw = t.add(new oc.BRepBuilderAPI_MakeWire());
    const edges: TopoDS_Edge[] = [];
    if (path.kind === 'edges') {
      const E = shapeIndex(oc, t, path.body.shape, EDGE);
      for (const i of path.edges) {
        const e = E.shapes[i];
        if (!e) throw new Error('a path edge is not on the body');
        const edge = t.add(oc.TopoDS.Edge(e));
        mw.Add(edge);
        if (!mw.IsDone()) throw new Error('the path edges are not joined end to end');
        edges.push(edge);
      }
    } else {
      // consecutive pieces share their vertices, so the wire is connected exactly
      let first: ReturnType<typeof vertex> | null = null, prev: ReturnType<typeof vertex> | null = null;
      path.segs.forEach((s, i) => {
        if (s.kind === 'circle') {
          const circ = t.add(new oc.gp_Circ(ax2(oc, t, s.c, s.n, s.x), s.r));
          edges.push(t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge()));
          return;
        }
        const s0 = path.segs[0] as { a: Vec3 };
        const closes = i === path.segs.length - 1 && i > 0 && len3(sub3(s.b, s0.a)) <= 1e-9 * (1 + len3(s.b));
        const v1 = prev ?? vertex(t, s.a);
        first ??= v1;
        const v2 = closes ? first : vertex(t, s.b);
        const mk = s.kind === 'line'
          ? t.add(new oc.BRepBuilderAPI_MakeEdge(v1, v2))
          : t.add(new oc.BRepBuilderAPI_MakeEdge(t.add(t.add(new oc.GC_MakeArcOfCircle(pnt(oc, t, s.a), pnt(oc, t, s.m), pnt(oc, t, s.b))).Value()), v1, v2));
        edges.push(t.add(mk.Edge()));
        prev = v2;
      });
      for (const e of edges) mw.Add(e);
      if (!mw.IsDone()) throw new Error('the path pieces are not joined end to end');
    }
    return { wire: t.add(mw.Wire()), edges };
  });

  /**
   * Points along the spine with tangents and curvatures, about `step` apart (at least 16 per
   * edge), each edge run the way that joins it to the next (an edge's own direction may be
   * either way along the chain).
   */
  const samplesOf = (t: Arena, edges: TopoDS_Edge[], step: number): PathSample[] => {
    const out: PathSample[] = [];
    let s = 0;
    const curves = edges.map((e) => curveOf(t, e));
    const ends = curves.map((c) => [c.d2(c.u0).p, c.d2(c.u1).p]);
    const gap = (a: Vec3, b: Vec3) => len3(sub3(a, b));
    curves.forEach((c, j) => {
      // forward unless the chain goes on from (or came to) this edge's first end
      const reversed = j + 1 < curves.length
        ? Math.min(gap(ends[j][0], ends[j + 1][0]), gap(ends[j][0], ends[j + 1][1])) < Math.min(gap(ends[j][1], ends[j + 1][0]), gap(ends[j][1], ends[j + 1][1]))
        : j > 0 && gap(ends[j][1], out[out.length - 1].p) < gap(ends[j][0], out[out.length - 1].p);
      // the edge's length by quadrature, for the number of samples
      let L = 0;
      for (const [x, w] of GL) L += w * len3(c.d2(c.u0 + (c.u1 - c.u0) * x).d1) * (c.u1 - c.u0);
      const n = Math.min(4000, Math.max(16, Math.ceil(L / Math.max(step, 1e-12))));
      let last: Vec3 | null = out.length ? out[out.length - 1].p : null;
      for (let i = out.length ? 1 : 0; i <= n; i++) {
        const f = reversed ? 1 - i / n : i / n;
        const q = c.d2(c.u0 + (c.u1 - c.u0) * f);
        const sp = len3(q.d1);
        const tan = scale3(q.d1, (reversed ? -1 : 1) / (sp || 1));
        const k = sp > 0 ? len3(cross3(q.d1, q.d2)) / sp ** 3 : 0;
        if (last) s += len3(sub3(q.p, last));
        out.push({ p: q.p, t: tan, k, s });
        last = q.p;
      }
    });
    return out;
  };

  /** A wire through the points, as one interpolated B-spline. */
  const throughPoints = (t: Arena, pts: Vec3[]): TopoDS_Wire => guard(oc, 'the twist cannot be made', () => {
    const a1 = t.add(new oc.NCollection_Array1_gp_Pnt(1, pts.length));
    pts.forEach((q, i) => a1.SetValue(i + 1, pnt(oc, t, q)));
    const arr = t.add(new oc.NCollection_HArray1_gp_Pnt(a1));
    const ip = t.add(new oc.GeomAPI_Interpolate(arr, false, 1e-9));
    ip.Perform();
    if (!ip.IsDone()) throw new Error('the twist cannot be made');
    const edge = t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(t.add(ip.Curve()))).Edge());
    return t.add(t.add(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
  });

  /** One closed wire swept along the spine as a solid; its faces named after the profile's edges and the start and end caps. */
  const sweepWire = (t: Arena, spine: { wire: TopoDS_Wire; closed: boolean }, profile: { wire: TopoDS_Wire; edges: TaggedEdge[] }, f: Frame, o: SweepOptions, aux: TopoDS_Wire | null, tag: string): OccSolid => {
    const what = 'the profile cannot be swept along this path';
    const mk = t.add(new oc.BRepOffsetAPI_MakePipeShell(spine.wire));
    if (o.orientation === 'parallel') mk.SetMode(ax2(oc, t, f.o, f.n, f.u));
    else if (o.orientation === 'axis') mk.SetMode(dir(oc, t, o.axis ?? f.n));
    else mk.SetMode(false);
    if (aux) mk.SetMode(aux, false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
    mk.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner);
    if (Math.abs(o.scale - 1) > 1e-12) {
      const law = t.add(new oc.Law_Linear());
      law.Set(0, 1, 1, o.scale);
      mk.SetLaw(profile.wire, law, false, false);
    } else mk.Add(profile.wire, false, false);
    guard(oc, what, () => mk.Build(progress(t)));
    if (!mk.IsDone() || !mk.MakeSolid()) throw new Error(what);
    let shape = t.add(mk.Shape());
    // a profile running the other way round the path makes the solid inside out
    if (kit.volume(shape) < 0) shape = t.add(shape.Reversed());
    shape = kit.keep(t, shape);
    const feature = kit.featureOf(tag);
    const tags = kit.generated(mk, profile.edges, (e) => `${tag}/side:${e}`, feature);
    if (!spine.closed) tags.push(...kit.capTags(t, t.add(mk.FirstShape()), `${tag}/start`, feature), ...kit.capTags(t, t.add(mk.LastShape()), `${tag}/end`, feature));
    return { shape, tags: kit.within(tags, shape) };
  };

  return {
    sweep(region: ProfileRegion, f: Frame, path: PathGeom<OccSolid>, o: SweepOptions, tag: string): OccSolid {
      return scratch((t) => {
        const made = spineOf(t, path);
        if (o.orientation === 'parallel' && o.twist) throw new Error('a parallel sweep cannot twist: use Perpendicular');
        if (!(o.scale > 0)) throw new Error('the end scale must be positive');
        const outer = loopWire(oc, t, region.outer, f, 0);
        const holes = region.holes.map((h) => loopWire(oc, t, reversedLoop(h), f, 0));
        // the profile's outline, for the checks and the sample spacing
        const outline: Vec3[] = [];
        for (const { edge } of outer.edges) {
          const c = curveOf(t, edge);
          for (let i = 0; i < 24; i++) outline.push(c.d2(c.u0 + ((c.u1 - c.u0) * i) / 24).p);
        }
        const cen = scale3(outline.reduce((a, q) => add3(a, q), [0, 0, 0] as Vec3), 1 / outline.length);
        const reach = Math.max(...outline.map((q) => len3(sub3(q, cen))), 1e-9);
        const samples = samplesOf(t, made.edges, reach / 2);
        const L = samples[samples.length - 1].s;
        const spine = { ...made, closed: len3(sub3(samples[0].p, samples[samples.length - 1].p)) <= 1e-9 * (1 + L) };
        if (spine.closed && o.twist) throw new Error('a sweep along a closed path cannot twist');
        if (spine.closed && Math.abs(o.scale - 1) > 1e-12) throw new Error('a sweep along a closed path cannot taper');
        if (o.orientation !== 'axis') {
          const clash = sweepClash(samples, spine.closed, outline, f.n, o.orientation === 'parallel', o.unit);
          if (clash) throw new Error(clash);
        }
        let aux: TopoDS_Wire | null = null;
        if (o.twist) {
          // the guide stays well inside the tightest bend, so every normal plane meets it once
          const kmax = Math.max(...samples.map((q) => q.k));
          const rho = 0.25 * Math.min(kmax > 0 ? 1 / kmax : Infinity, L);
          const step = Math.max(1, Math.ceil(samples.length / 400));
          const thin = samples.filter((_, i) => i % step === 0 || i === samples.length - 1);
          aux = throughPoints(t, twistGuide(thin, o.twist, rho));
        }
        let solid = sweepWire(t, spine, outer, f, o, aux, tag);
        if (holes.length) {
          const cores = holes.map((h) => sweepWire(t, spine, h, f, o, aux, tag));
          solid = kit.boolean('cut', solid, cores, 'the holes of the profile cannot be swept');
        }
        kit.sound(t, solid.shape, 'the sweep does not make a sound solid (the profile may cut through itself along the path)');
        return solid;
      });
    },

    thread(g: ThreadGeom, tag: string): OccSolid {
      return scratch((t) => {
        const turns = (g.z1 - g.z0) / g.pitch;
        const start = add3(g.o, scale3(g.axis, g.z0));
        const spine = helixWire(t, { o: start, axis: g.axis, x: g.x, r: g.r, pitch: g.pitch, turns, left: g.left });
        // the groove's section in the half-plane of x and the axis, at the helix's start
        const corners = g.section.map(([r, z]) => add3(add3(start, scale3(g.x, r)), scale3(g.axis, z)));
        const mw = t.add(new oc.BRepBuilderAPI_MakeWire());
        const vs = corners.map((q) => vertex(t, q));
        const edges: TaggedEdge[] = vs.map((v, i) => ({ edge: t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length])).Edge()), entity: 'groove' }));
        for (const { edge } of edges) mw.Add(edge);
        const wire = t.add(mw.Wire());
        const what = 'the thread cannot be made';
        const mk = t.add(new oc.BRepOffsetAPI_MakePipeShell(spine.wire));
        mk.SetMode(dir(oc, t, g.axis));
        mk.Add(wire, false, false);
        guard(oc, what, () => mk.Build(progress(t)));
        if (!mk.IsDone() || !mk.MakeSolid()) throw new Error(what);
        let shape = t.add(mk.Shape());
        if (kit.volume(shape) < 0) shape = t.add(shape.Reversed());
        shape = kit.keep(t, shape);
        const feature = kit.featureOf(tag);
        const tags = [
          ...kit.generated(mk, edges, () => `${tag}:groove`, feature),
          ...kit.capTags(t, t.add(mk.FirstShape()), `${tag}:start`, feature),
          ...kit.capTags(t, t.add(mk.LastShape()), `${tag}:end`, feature),
        ];
        return { shape, tags: kit.within(tags, shape) };
      });
    },

    edgeAt(s: OccSolid, index: number, at: number): { p: Vec3; d: Vec3 } {
      return scratch((t) => {
        const e = shapeIndex(oc, t, s.shape, EDGE).shapes[index];
        if (!e) throw new Error('the edge is not on the body');
        const c = curveOf(t, t.add(oc.TopoDS.Edge(e)));
        const f = Math.min(1, Math.max(0, at));
        // arc length from the start: 64 Gauss panels, then the parameter found by bisection
        const panels = 64, du = (c.u1 - c.u0) / panels;
        const cum = [0];
        for (let i = 0; i < panels; i++) {
          let l = 0;
          for (const [x, w] of GL) l += w * len3(c.d2(c.u0 + du * (i + x)).d1) * du;
          cum.push(cum[i] + l);
        }
        const want = f * cum[panels];
        let k = 0;
        while (k < panels - 1 && cum[k + 1] < want) k++;
        let lo = c.u0 + du * k, hi = lo + du;
        const lenTo = (u: number) => {
          let l = cum[k];
          for (const [x, w] of GL) l += w * len3(c.d2(c.u0 + du * k + (u - c.u0 - du * k) * x).d1) * (u - c.u0 - du * k);
          return l;
        };
        for (let i = 0; i < 60; i++) {
          const m = (lo + hi) / 2;
          if (lenTo(m) < want) lo = m;
          else hi = m;
        }
        const q = c.d2((lo + hi) / 2);
        return { p: q.p, d: norm3(q.d1) };
      });
    },
  };
}
