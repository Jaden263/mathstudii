// Sketch profiles as exact OCCT geometry: lines, true circular arcs and circles, ellipses
// (gp_Elips) and B-splines with the sketch's own poles and knots (never polylines), with
// the sketch entity behind every edge, which later names the faces an edge sweeps.
import type { Geom_BSplineCurve, TopoDS_Edge, TopoDS_Face, TopoDS_Vertex, TopoDS_Wire, gp_Elips } from 'replicad-opencascadejs';
import { loopPolygon, reverseSeg, segPoint, type Loop, type ProfileRegion, type Vec2 } from '../profile';
import { loftTurned } from '../shaping';
import { add3, cross3, frameDir, framePoint, scale3, sub3, type Arena, type Frame, type Vec3 } from '../solid';
import { ax2, frameAx3, guard, pnt, type OC } from './kernel';

export interface TaggedEdge {
  edge: TopoDS_Edge;
  /** Sketch entity the edge comes from. */
  entity: string;
}

export interface ProfileFace {
  face: TopoDS_Face;
  edges: TaggedEdge[];
}

/** A clamped B-spline through 3-D poles as an OCCT curve (knot values with their multiplicities). */
export function bsplineCurve(oc: OC, t: Arena, deg: number, poles: Vec3[], knots: number[]): Geom_BSplineCurve {
  const P = t.add(new oc.NCollection_Array1_gp_Pnt(1, poles.length));
  poles.forEach((q, i) => P.SetValue(i + 1, pnt(oc, t, q)));
  const vals: number[] = [], mults: number[] = [];
  for (const k of knots) {
    if (vals.length && k === vals[vals.length - 1]) mults[mults.length - 1]++;
    else {
      vals.push(k);
      mults.push(1);
    }
  }
  const K = t.add(new oc.NCollection_Array1_double(1, vals.length));
  vals.forEach((v, i) => K.SetValue(i + 1, v));
  const M = t.add(new oc.NCollection_Array1_int(1, mults.length));
  mults.forEach((v, i) => M.SetValue(i + 1, v));
  return t.add(new oc.Geom_BSplineCurve(P, K, M, deg, false));
}

/**
 * An ellipse about c in the plane with normal n (semi-axis ra along x, rb along y) as
 * gp_Elips, which wants its major radius first: with rb > ra the axes swap and the
 * parameter shifts by a quarter turn (returned as `dt`: OCCT's t = ours − dt).
 */
export function occEllipse(oc: OC, t: Arena, c: Vec3, n: Vec3, x: Vec3, ra: number, rb: number): { el: gp_Elips; dt: number } {
  if (ra >= rb) return { el: t.add(new oc.gp_Elips(ax2(oc, t, c, n, x), ra, rb)), dt: 0 };
  return { el: t.add(new oc.gp_Elips(ax2(oc, t, c, n, cross3(n, x)), rb, ra)), dt: Math.PI / 2 };
}

/** The OCCT edge of an elliptical arc from t0 to t1 (t1 < t0: clockwise) between two vertices (none: the whole ellipse). */
export function ellipseEdge(oc: OC, t: Arena, e: { el: gp_Elips; dt: number }, t0: number, t1: number, v?: [TopoDS_Vertex, TopoDS_Vertex]): TopoDS_Edge {
  if (Math.abs(Math.abs(t1 - t0) - 2 * Math.PI) < 1e-12 && !v) {
    const edge = t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(e.el)).Edge());
    return t1 < t0 ? t.add(oc.TopoDS.Edge(t.add(edge.Reversed()))) : edge;
  }
  const [lo, hi] = t1 > t0 ? [t0, t1] : [t1, t0];
  const arc = t.add(t.add(new oc.GC_MakeArcOfEllipse(e.el, lo - e.dt, hi - e.dt, true)).Value());
  const mk = v ? t.add(new oc.BRepBuilderAPI_MakeEdge(arc, ...(t1 > t0 ? v : ([v[1], v[0]] as const)))) : t.add(new oc.BRepBuilderAPI_MakeEdge(arc));
  const edge = t.add(mk.Edge());
  return t1 > t0 ? edge : t.add(oc.TopoDS.Edge(t.add(edge.Reversed())));
}

/** The loop run the other way (holes → counter-clockwise). */
export function reversedLoop(l: Loop): Loop {
  return { segs: l.segs.map(reverseSeg).reverse(), entities: [...l.entities].reverse() };
}

/**
 * A closed wire through the loop's segments in frame f at height z. Consecutive edges
 * share one vertex; where a line meets an arc the line's (sketch) point wins, so arcs
 * that the solver left a hair off their end points still close.
 */
export function loopWire(oc: OC, arena: Arena, loop: Loop, f: Frame, z: number): { wire: TopoDS_Wire; edges: TaggedEdge[] } {
  return guard(oc, 'the profile cannot be made into a face', () => {
    const P = (q: Vec2) => framePoint(f, q, z);
    const segs = loop.segs, n = segs.length;
    const edges: TaggedEdge[] = [];
    const mw = arena.add(new oc.BRepBuilderAPI_MakeWire());
    if (n === 1 && segs[0].kind === 'arc') {
      // a circle: one closed edge, counter-clockwise about the normal (holes reversed)
      const s = segs[0];
      const circ = arena.add(new oc.gp_Circ(ax2(oc, arena, P(s.c), f.n, f.u), s.r));
      let e = arena.add(arena.add(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge());
      if (s.a1 < s.a0) e = arena.add(oc.TopoDS.Edge(arena.add(e.Reversed())));
      edges.push({ edge: e, entity: loop.entities[0] });
    } else if (n === 1 && segs[0].kind === 'ellipse') {
      // a whole ellipse: one closed edge, the way the loop runs
      const s = segs[0];
      edges.push({ edge: ellipseEdge(oc, arena, occEllipse(oc, arena, P(s.c), f.n, frameDir(f, { x: Math.cos(s.rot), y: Math.sin(s.rot) }), s.ra, s.rb), s.t0, s.t1), entity: loop.entities[0] });
    } else if (n === 1 && segs[0].kind === 'bspline') {
      // a closed spline: one closed edge (its poles already run the loop's way)
      const s = segs[0];
      edges.push({ edge: arena.add(arena.add(new oc.BRepBuilderAPI_MakeEdge(bsplineCurve(oc, arena, s.deg, s.poles.map((q) => P(q)), s.knots))).Edge()), entity: loop.entities[0] });
    } else {
      const junction = (k: number): Vec2 => {
        const a = segs[(k + n - 1) % n], b = segs[k];
        return b.kind === 'line' ? b.a : a.kind === 'line' ? a.b : segPoint(b, 0);
      };
      const vs: TopoDS_Vertex[] = [];
      for (let k = 0; k < n; k++) vs.push(arena.add(arena.add(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, arena, P(junction(k))))).Vertex()));
      for (let k = 0; k < n; k++) {
        const s = segs[k], v1 = vs[k], v2 = vs[(k + 1) % n];
        let edge: TopoDS_Edge;
        if (s.kind === 'line') edge = arena.add(arena.add(new oc.BRepBuilderAPI_MakeEdge(v1, v2)).Edge());
        else if (s.kind === 'arc') {
          // the circle through both ends and the arc's middle: exact, and it meets the vertices
          const m = (s.a0 + s.a1) / 2;
          const mid = { x: s.c.x + s.r * Math.cos(m), y: s.c.y + s.r * Math.sin(m) };
          const arc = arena.add(new oc.GC_MakeArcOfCircle(pnt(oc, arena, P(junction(k))), pnt(oc, arena, P(mid)), pnt(oc, arena, P(junction((k + 1) % n)))));
          edge = arena.add(arena.add(new oc.BRepBuilderAPI_MakeEdge(arena.add(arc.Value()), v1, v2)).Edge());
        } else if (s.kind === 'ellipse') {
          edge = ellipseEdge(oc, arena, occEllipse(oc, arena, P(s.c), f.n, frameDir(f, { x: Math.cos(s.rot), y: Math.sin(s.rot) }), s.ra, s.rb), s.t0, s.t1, [v1, v2]);
        } else {
          // the spline's own poles and knots: the same curve as the sketch and the profile integrals
          edge = arena.add(arena.add(new oc.BRepBuilderAPI_MakeEdge(bsplineCurve(oc, arena, s.deg, s.poles.map((q) => P(q)), s.knots), v1, v2)).Edge());
        }
        edges.push({ edge, entity: loop.entities[k] });
      }
    }
    for (const { edge } of edges) mw.Add(edge);
    if (!mw.IsDone()) throw new Error('the profile outline does not close');
    return { wire: arena.add(mw.Wire()), edges };
  });
}

/** A planar face of the region (outer loop counter-clockwise, holes clockwise) at height z. */
export function regionFace(oc: OC, arena: Arena, r: ProfileRegion, f: Frame, z: number): ProfileFace {
  const outer = loopWire(oc, arena, r.outer, f, z);
  const holes = r.holes.map((h) => loopWire(oc, arena, h, f, z));
  return guard(oc, 'the profile cannot be made into a face', () => {
    const pln = arena.add(new oc.gp_Pln(frameAx3(oc, arena, { ...f, o: framePoint(f, { x: 0, y: 0 }, z) })));
    const mf = arena.add(new oc.BRepBuilderAPI_MakeFace(pln, outer.wire, true));
    for (const h of holes) mf.Add(h.wire);
    if (!mf.IsDone()) throw new Error('the profile cannot be made into a face');
    return { face: arena.add(mf.Face()), edges: [...outer.edges, ...holes.flatMap((h) => h.edges)] };
  });
}

/**
 * The second loop of a loft run the same way round as the first (loftTurned) and started
 * at the corner that matches the first loop's start (relative to their centres), as the
 * mesh kernel pairs them: a ruled loft between two squares at right angles then bends
 * instead of twisting inside out. Loops with different numbers of segments, and circles,
 * come back only turned round; OCCT matches those itself.
 */
export function alignLoop(a: Loop, fa: Frame, b: Loop, fb: Frame): Loop {
  const centre = (q: Loop, f: Frame) => {
    const p = loopPolygon(q).map((v) => framePoint(f, v));
    return p.reduce((s, v) => add3(s, scale3(v, 1 / p.length)), [0, 0, 0] as Vec3);
  };
  const cA = centre(a, fa), cB = centre(b, fb);
  let l = loftTurned(fa.n, cA, fb.n, cB) ? reversedLoop(b) : b;
  const n = a.segs.length;
  if (l.segs.length !== n || n < 2) return l;
  const corners = (q: Loop, f: Frame) => q.segs.map((s) => framePoint(f, segPoint(s, 0)));
  const A = corners(a, fa), B = corners(l, fb);
  let best = 0, bestD = Infinity;
  for (let s = 0; s < n; s++) {
    let d = 0;
    for (let i = 0; i < n; i++) {
      const e = sub3(sub3(A[i], cA), sub3(B[(i + s) % n], cB));
      d += e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    }
    // a tie (a square turned 45°) keeps the earliest start
    if (d < bestD * (1 - 1e-12)) [best, bestD] = [s, d];
  }
  return best ? { segs: [...l.segs.slice(best), ...l.segs.slice(0, best)], entities: [...l.entities.slice(best), ...l.entities.slice(0, best)] } : l;
}

/** Planar faces bounded by single closed wires (each oriented to bound a finite area). */
export function wireFaces(oc: OC, arena: Arena, wires: TopoDS_Wire[], f: Frame, z: number): TopoDS_Face[] {
  const pln = arena.add(new oc.gp_Pln(frameAx3(oc, arena, { ...f, o: framePoint(f, { x: 0, y: 0 }, z) })));
  return wires.map((w) => arena.add(arena.add(new oc.BRepBuilderAPI_MakeFace(pln, w, true)).Face()));
}
