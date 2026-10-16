// Sketch profiles as exact OCCT geometry: lines, true circular arcs and circles (never
// polylines), with the sketch entity behind every edge, which later names the faces an
// edge sweeps.
import type { TopoDS_Edge, TopoDS_Face, TopoDS_Vertex, TopoDS_Wire } from 'replicad-opencascadejs';
import { segPoint, type Loop, type ProfileRegion, type Seg, type Vec2 } from '../profile';
import { framePoint, type Arena, type Frame } from '../solid';
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

const reverseSeg = (s: Seg): Seg => (s.kind === 'line' ? { kind: 'line', a: s.b, b: s.a } : { ...s, a0: s.a1, a1: s.a0 });

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
    } else {
      const junction = (k: number): Vec2 => {
        const a = segs[(k + n - 1) % n], b = segs[k];
        return b.kind === 'line' ? b.a : a.kind === 'line' ? a.b : segPoint(b, 0);
      };
      const vs: TopoDS_Vertex[] = [];
      for (let k = 0; k < n; k++) vs.push(arena.add(arena.add(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, arena, P(junction(k))))).Vertex()));
      for (let k = 0; k < n; k++) {
        const s = segs[k], v1 = vs[k], v2 = vs[(k + 1) % n];
        let mk;
        if (s.kind === 'line') mk = arena.add(new oc.BRepBuilderAPI_MakeEdge(v1, v2));
        else {
          // the circle through both ends and the arc's middle: exact, and it meets the vertices
          const m = (s.a0 + s.a1) / 2;
          const mid = { x: s.c.x + s.r * Math.cos(m), y: s.c.y + s.r * Math.sin(m) };
          const arc = arena.add(new oc.GC_MakeArcOfCircle(pnt(oc, arena, P(junction(k))), pnt(oc, arena, P(mid)), pnt(oc, arena, P(junction((k + 1) % n)))));
          mk = arena.add(new oc.BRepBuilderAPI_MakeEdge(arena.add(arc.Value()), v1, v2));
        }
        edges.push({ edge: arena.add(mk.Edge()), entity: loop.entities[k] });
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

/** Planar faces bounded by single closed wires (each oriented to bound a finite area). */
export function wireFaces(oc: OC, arena: Arena, wires: TopoDS_Wire[], f: Frame, z: number): TopoDS_Face[] {
  const pln = arena.add(new oc.gp_Pln(frameAx3(oc, arena, { ...f, o: framePoint(f, { x: 0, y: 0 }, z) })));
  return wires.map((w) => arena.add(arena.add(new oc.BRepBuilderAPI_MakeFace(pln, w, true)).Face()));
}
