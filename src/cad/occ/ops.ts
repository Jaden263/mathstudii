// The B-rep kernel behind the design timeline: every feature as exact OCCT geometry.
//
// Solids carry the history of their faces (which feature and which sketch entity made
// each one): primitives tag their faces when they are made (an extruded line's side
// face, the start and end caps, a fillet's round), and every later operation passes
// the tags on through OCCT's Modified() history. The tags are the preliminary stable
// keys of the faces (see result.ts).
import type { NCollection_List_TopoDS_Shape, TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Wire } from 'replicad-opencascadejs';
import type { HoleOptions, SolidOps } from '../design';
import type { ProfileRegion } from '../profile';
import type { EdgeOptions } from '../shaping';
import { Arena, frameDir, frameFromNormal, framePoint, m4Point, m4Rotate, revolveSide, type Frame, type Vec3 } from '../solid';
import { alignLoop, loopWire, regionFace, reversedLoop, wireFaces, type TaggedEdge } from './geometry';
import { ShapeIndex, ax1, compound, guard, hasSolid, listShapes, occError, pnt, scratch, shapeIndex, subShapes, trsf, vec, xyz, type OC } from './kernel';

export interface FaceTag {
  face: TopoDS_Shape;
  /** Preliminary stable key `${feature}/${role}`: f1/side:l3, f1/end, f2/hole0:wall, f4.2.f2/hole0:wall (a copy). */
  key: string;
  /** Feature that made the face (the pattern or mirror for copies). */
  feature: string;
}

export interface OccSolid {
  shape: TopoDS_Shape;
  tags: FaceTag[];
}

/** What OCCT builders tell about the fate of their input shapes. */
interface History {
  Modified(s: TopoDS_Shape): NCollection_List_TopoDS_Shape;
  IsDeleted(s: TopoDS_Shape): boolean;
}

/** Volume of a shape by exact surface integration. */
export function shapeVolume(oc: OC, s: TopoDS_Shape): number {
  return scratch((t) => {
    const p = t.add(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(s, p, false, false, false);
    return p.Mass();
  });
}

const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];

/** The kernel operations; every shape they return lives in `arena`. */
export function occOps(oc: OC, arena: Arena): SolidOps<OccSolid> {
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE, EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const progress = (t: Arena) => t.add(new oc.Message_ProgressRange());
  /** Move an object from a scratch arena into the build's. */
  const keep = <T extends { delete(): void }>(t: Arena, x: T): T => {
    t.release(x);
    return arena.add(x);
  };
  /** Only the tags whose face is part of the shape. */
  const within = (tags: FaceTag[], shape: TopoDS_Shape) => scratch((t) => {
    const set = shapeIndex(oc, t, shape, FACE);
    return tags.filter((g) => set.has(g.face));
  });
  /** Tags carried through an operation's history onto its result. */
  const carry = (h: History, tags: FaceTag[], result: TopoDS_Shape): FaceTag[] => {
    const out: FaceTag[] = [];
    for (const g of tags) {
      if (h.IsDeleted(g.face)) continue;
      const mods = listShapes(arena, h.Modified(g.face));
      for (const f of mods.length ? mods : [g.face]) out.push({ ...g, face: f });
    }
    return within(out, result);
  };
  const featureOf = (tag: string) => tag.split('/')[0].split('.')[0];
  const generated = (mk: { Generated(s: TopoDS_Shape): NCollection_List_TopoDS_Shape }, edges: TaggedEdge[], key: (entity: string) => string, feature: string) =>
    edges.flatMap(({ edge, entity }) => listShapes(arena, mk.Generated(edge)).map((face) => ({ face, key: key(entity), feature })));
  /** Faces of a cap shape (a face, or a compound of them). */
  const capTags = (t: Arena, cap: TopoDS_Shape, key: string, feature: string): FaceTag[] =>
    subShapes(oc, t, cap, FACE).map((f) => ({ face: keep(t, f), key, feature }));

  /**
   * Tags of a revolve: Generated() knows the faces swept by most profile edges but not
   * the planar ones (edges square to the axis); those are found as the face through the
   * edge's midpoint turned half the angle round the axis.
   */
  const revolveTags = (t: Arena, mk: { Generated(s: TopoDS_Shape): NCollection_List_TopoDS_Shape }, shape: TopoDS_Shape, edges: TaggedEdge[], axis: { p: Vec3; d: Vec3 }, angle: number, key: (entity: string) => string, feature: string): FaceTag[] => {
    const tags: FaceTag[] = [];
    const missed: TaggedEdge[] = [];
    for (const e of edges) {
      const got = generated(mk, [e], key, feature);
      if (got.length) tags.push(...got);
      else missed.push(e);
    }
    if (!missed.length) return tags;
    const faces = subShapes(oc, t, shape, FACE);
    const R = m4Rotate(axis.p, axis.d, angle / 2);
    for (const e of missed) {
      const c = t.add(new oc.BRepAdaptor_Curve(e.edge));
      const mid = m4Point(R, xyz(t.add(c.EvalD0((c.FirstParameter() + c.LastParameter()) / 2))));
      const v = t.add(t.add(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, t, mid))).Vertex());
      for (const f of faces) {
        const d = t.add(new oc.BRepExtrema_DistShapeShape(v, f));
        if (d.IsDone() && d.Value() < 1e-7 * (1 + Math.hypot(...mid))) {
          tags.push({ face: keep(t, f), key: key(e.entity), feature });
          break;
        }
      }
    }
    return tags;
  };

  /** Booleans keep their data structure through delete() in this build: clear it first. */
  const release = (op: { Clear(): void }) => {
    try {
      op.Clear();
    } catch (e) {
      occError(oc, e, 'clearing a boolean failed');
    }
  };

  /**
   * A list of boolean tools, compounds taken apart: one argument must not overlap itself,
   * but separate tools may overlap each other (two holes closer than their diameter).
   */
  const toolList = (t: Arena, shapes: TopoDS_Shape[]) => {
    const list = t.add(new oc.NCollection_List_TopoDS_Shape());
    // Append hands back the stored item: a handle of its own to delete
    for (const s of shapes) {
      const parts = s.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND ? subShapes(oc, t, s, oc.TopAbs_ShapeEnum.TopAbs_SOLID) : [s];
      for (const q of parts) t.add(list.Append(q));
    }
    return list;
  };

  /** Fuse / cut / common with history; coplanar pieces are merged afterwards. */
  const boolean = (kind: 'fuse' | 'cut' | 'common', a: OccSolid, tools: OccSolid[], what: string): OccSolid => scratch((t) => {
    const op = t.add(kind === 'fuse' ? new oc.BRepAlgoAPI_Fuse() : kind === 'cut' ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Common());
    const args = t.add(new oc.NCollection_List_TopoDS_Shape());
    t.add(args.Append(a.shape));
    const tl = toolList(t, tools.map((s) => s.shape));
    op.SetArguments(args);
    op.SetTools(tl);
    try {
      guard(oc, what, () => op.Build(progress(t)));
      if (op.HasErrors()) throw new Error(what);
      try {
        op.SimplifyResult(true, true, 1e-9);
      } catch (e) {
        occError(oc, e, 'merging faces failed'); // cosmetic: keep the plain result
      }
      const shape = arena.add(op.Shape());
      return { shape, tags: carry(op, [...a.tags, ...tools.flatMap((s) => s.tags)], shape) };
    } finally {
      release(op);
    }
  });

  const union = (parts: OccSolid[]): OccSolid => (parts.length === 1 ? parts[0] : boolean('fuse', parts[0], parts.slice(1), 'the bodies cannot be joined'));

  /** Sweep a face (or compound of faces) along v: side faces named after their edges, caps start / end. */
  const prism = (t: Arena, face: TopoDS_Shape, edges: TaggedEdge[], v: Vec3, tag: string, caps = ['start', 'end']) => {
    const mk = t.add(new oc.BRepPrimAPI_MakePrism(face, vec(oc, t, v), false, true));
    const shape = arena.add(guard(oc, 'the profile cannot be extruded', () => mk.Shape()));
    const feature = featureOf(tag);
    const tags = [
      ...generated(mk, edges, (e) => `${tag}/side:${e}`, feature),
      ...capTags(t, t.add(mk.FirstShape()), `${tag}/${caps[0]}`, feature),
      ...capTags(t, t.add(mk.LastShape()), `${tag}/${caps[1]}`, feature),
    ];
    return { shape, tags };
  };
  /** Edges of a face without sketch names (offset outlines). */
  const looseEdges = (t: Arena, s: TopoDS_Shape, entity: string): TaggedEdge[] => subShapes(oc, t, s, EDGE).map((e) => ({ edge: t.add(oc.TopoDS.Edge(e)), entity }));

  const checkExtent = (z0: number, z1: number) => {
    if (!(z1 - z0 > 0)) throw new Error('the extent must be positive');
  };

  /** Faces of one loop offset by d (> 0 grows it); none when it vanishes. */
  const offsetLoopFaces = (t: Arena, wire: TopoDS_Wire, d: number, f: Frame, z: number): TopoDS_Face[] => {
    const mk = t.add(new oc.BRepOffsetAPI_MakeOffset(wire, oc.GeomAbs_JoinType.GeomAbs_Intersection, false));
    try {
      mk.Perform(d, 0);
      if (!mk.IsDone()) return [];
      const wires = subShapes(oc, t, t.add(mk.Shape()), oc.TopAbs_ShapeEnum.TopAbs_WIRE).map((w) => t.add(oc.TopoDS.Wire(w)));
      return wireFaces(oc, t, wires, f, z);
    } catch (e) {
      occError(oc, e, 'the offset vanished');
      return [];
    }
  };

  /** A region offset by d with sharp corners, as a sketch offset: the outline grows by d, holes shrink by d. */
  const offsetRegion = (t: Arena, r: ProfileRegion, d: number, f: Frame, z: number): TopoDS_Shape | null => {
    const outer = offsetLoopFaces(t, loopWire(oc, t, r.outer, f, z).wire, d, f, z);
    if (!outer.length) return null;
    const holes = r.holes.flatMap((h) => offsetLoopFaces(t, loopWire(oc, t, reversedLoop(h), f, z).wire, -d, f, z));
    const o = compound(oc, t, outer);
    if (!holes.length) return o;
    const cut = t.add(new oc.BRepAlgoAPI_Cut(o, compound(oc, t, holes), progress(t)));
    try {
      return t.add(guard(oc, 'the wall cannot be offset', () => cut.Shape()));
    } finally {
      release(cut);
    }
  };

  /** Edges of a tagged cap, each named by the sketch entity of the side face it borders. */
  const capEdges = (t: Arena, s: OccSolid, tag: string, cap: string): TaggedEdge[] => {
    const sides = s.tags.filter((g) => g.key.startsWith(`${tag}/side:`)).map((g) => ({ edges: shapeIndex(oc, t, g.face, EDGE), entity: g.key.slice(tag.length + 6) }));
    const out = new ShapeIndex(oc);
    for (const g of s.tags) if (g.key === `${tag}/${cap}`) for (const e of subShapes(oc, t, g.face, EDGE)) out.add(e);
    return out.shapes.map((e) => ({ edge: t.add(oc.TopoDS.Edge(e)), entity: sides.find((q) => q.edges.has(e))?.entity ?? 'edge' }));
  };

  /** Fillets or chamfers on cap edges; the new faces are named after their edges. */
  const treatEdges = (t: Arena, s: OccSolid, kind: 'fillet' | 'chamfer', steps: { o: EdgeOptions; edges: TaggedEdge[]; at: string }[], tag: string) => {
    const mk = t.add(kind === 'fillet' ? new oc.BRepFilletAPI_MakeFillet(s.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational) : new oc.BRepFilletAPI_MakeChamfer(s.shape));
    const live = shapeIndex(oc, t, s.shape, EDGE);
    const added: { edge: TopoDS_Edge; key: string }[] = [];
    for (const { o, edges, at } of steps) for (const { edge, entity } of edges) {
      if (!live.has(edge)) continue;
      mk.Add(o.r, edge);
      added.push({ edge, key: `${tag}/${kind === 'fillet' ? 'round' : 'chamfer'}:${at}:${entity}` });
    }
    const what = 'the rounding does not fit this profile — try a smaller radius';
    const shape = arena.add(guard(oc, what, () => {
      mk.Build(progress(t));
      if (!mk.IsDone()) throw new Error(what);
      return mk.Shape();
    }));
    // a radius too large for the profile can still "succeed" with a broken solid (a chamfer
    // wider than a disc's radius has a plausible volume): rounding cap edges only ever removes
    // material, and the result must pass OCCT's checks (which leak ~20 kB, as fillets do)
    const v = hasSolid(oc, shape) ? shapeVolume(oc, shape) : 0;
    if (!(v > 0 && v < shapeVolume(oc, s.shape))) throw new Error(what);
    if (!t.add(new oc.BRepCheck_Analyzer(shape, true, false, false)).IsValid()) throw new Error(what);
    const feature = featureOf(tag);
    const tags = carry(mk, s.tags, shape);
    for (const { edge, key } of added) for (const face of listShapes(arena, mk.Generated(edge))) tags.push({ face, key, feature });
    return { shape, tags: within(tags, shape) };
  };

  /**
   * A hole tool: its half cross-section (radius, depth along d) revolved about the hole
   * axis, so walls are true cylinders and a countersink a true cone. It starts a hair
   * above the surface so the cut never leaves a skin.
   */
  const holeTool = (t: Arena, p: Vec3, d: Vec3, o: HoleOptions, tag: string): OccSolid => {
    const fr = frameFromNormal(p, d);
    const back = Math.max(o.d, o.cbD ?? 0, o.csD ?? 0) * 1e-3;
    const r = o.d / 2;
    // corners (radius, depth, role of the edge from it to the next), round from the axis at the top;
    // a counterbore or countersink deeper than the hole sets its depth (as in the mesh kernel)
    const pts: [number, number, string][] = [[0, -back, 'top']];
    let bottom = o.depth;
    if (o.style === 'counterbore' && o.cbD && o.cbDepth && o.cbD > o.d) {
      const R = o.cbD / 2;
      pts.push([R, -back, 'cb']);
      if (o.cbDepth >= o.depth) pts.push([R, (bottom = o.cbDepth), 'bottom']);
      else pts.push([R, o.cbDepth, 'cbFloor'], [r, o.cbDepth, 'wall'], [r, o.depth, 'bottom']);
    } else if (o.style === 'countersink' && o.csD && o.csD > o.d && o.csAngle) {
      const R = o.csD / 2, k = Math.tan(o.csAngle / 2), hc = (R - r) / k;
      pts.push([R, -back, 'csTop'], [R, 0, 'cone']);
      if (hc >= o.depth) pts.push([r, (bottom = hc), 'bottom']);
      else pts.push([r, hc, 'wall'], [r, o.depth, 'bottom']);
    } else pts.push([r, -back, 'wall'], [r, o.depth, 'bottom']);
    pts.push([0, bottom, 'axis']);
    const at = ([rad, z]: [number, number, string]): Vec3 => [p[0] + fr.u[0] * rad + d[0] * z, p[1] + fr.u[1] * rad + d[1] * z, p[2] + fr.u[2] * rad + d[2] * z];
    return guard(oc, 'the hole cannot be made', () => {
      const mw = t.add(new oc.BRepBuilderAPI_MakeWire());
      const vs = pts.map((q) => t.add(t.add(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, t, at(q)))).Vertex()));
      const edges: TaggedEdge[] = [];
      for (let i = 0; i < pts.length; i++) {
        const edge = t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(vs[i], vs[(i + 1) % pts.length])).Edge());
        mw.Add(edge);
        if (pts[i][2] !== 'axis') edges.push({ edge, entity: pts[i][2] });
      }
      const face = t.add(t.add(new oc.BRepBuilderAPI_MakeFace(t.add(mw.Wire()), true)).Face());
      const mk = t.add(new oc.BRepPrimAPI_MakeRevol(face, ax1(oc, t, p, d), false));
      const shape = arena.add(mk.Shape());
      return { shape, tags: within(revolveTags(t, mk, shape, edges, { p, d }, 2 * Math.PI, (e) => `${tag}:${e}`, featureOf(tag)), shape) };
    });
  };

  const ops: SolidOps<OccSolid> = {
    extrude(regions, f, z0, z1, tag) {
      checkExtent(z0, z1);
      return scratch((t) => union(regions.map((r) => {
        const pf = regionFace(oc, t, r, f, z0);
        return prism(t, pf.face, pf.edges, scale(f.n, z1 - z0), tag);
      })));
    },

    thin(regions, f, z0, z1, o, tag) {
      const h = z1 - z0;
      if (!(o.t > 0)) throw new Error('the wall thickness must be positive');
      checkExtent(z0, z1);
      // outline and inside of the wall as offsets of the profile
      const [a, b] = o.side === 'inside' ? [0, -o.t] : o.side === 'outside' ? [o.t, 0] : [o.t / 2, -o.t / 2];
      const caps = o.cap === 'both' ? 2 : o.cap === 'none' ? 0 : 1;
      return scratch((t) => union(regions.map((r) => {
        const pf = a ? null : regionFace(oc, t, r, f, z0);
        const outer = pf ? pf.face : offsetRegion(t, r, a, f, z0);
        if (!outer) throw new Error('the wall is thicker than the profile');
        if (caps * o.t >= h) throw new Error('the caps are thicker than the extrusion');
        // the profile's own sides keep their sketch names; offset outlines are just walls
        const shell = prism(t, outer, pf ? pf.edges : looseEdges(t, outer, 'wall'), scale(f.n, h), tag);
        // the hollow, between the caps (and past the open ends)
        const lo = o.cap === 'start' || o.cap === 'both' ? z0 + o.t : z0 - h;
        const hi = o.cap === 'end' || o.cap === 'both' ? z1 - o.t : z1 + h;
        const inner = b ? offsetRegion(t, r, b, f, lo) : regionFace(oc, t, r, f, lo).face;
        if (!inner) return shell;
        const core = prism(t, inner, looseEdges(t, inner, 'inner'), scale(f.n, hi - lo), tag, ['inner-start', 'inner-end']);
        return boolean('cut', shell, [core], 'the wall cannot be made');
      })));
    },

    rounded(regions, f, z0, z1, start, end, tag) {
      const h = z1 - z0;
      const rs = start?.r ?? 0, re = end?.r ?? 0;
      if (rs < 0 || re < 0) throw new Error('the edge size must be positive');
      if (rs + re >= h - 1e-9) throw new Error('the roundings are larger than the extrusion');
      return scratch((t) => union(regions.map((r) => {
        const pf = regionFace(oc, t, r, f, z0);
        let cur = prism(t, pf.face, pf.edges, scale(f.n, h), tag);
        const steps: { o: EdgeOptions; at: string }[] = [];
        if (start && rs > 0) steps.push({ o: start, at: 'start' });
        if (end && re > 0) steps.push({ o: end, at: 'end' });
        // one OCCT operation per kind; the second finds its cap edges on what the first left
        for (const kind of ['fillet', 'chamfer'] as const) {
          const now = steps.filter((q) => q.o.type === kind);
          if (now.length) cur = treatEdges(t, cur, kind, now.map((q) => ({ ...q, edges: capEdges(t, cur, tag, q.at) })), tag);
        }
        return cur;
      })));
    },

    loft(a, b, tag) {
      return scratch((t) => {
        const lb = alignLoop(a.region.outer, a.frame, b.region.outer, b.frame);
        const wa = loopWire(oc, t, a.region.outer, a.frame, 0), wb = loopWire(oc, t, lb, b.frame, 0);
        // corner to corner when the loops match (OCCT's own matching turns a loft between
        // planes at right angles inside out); otherwise, and for circles, OCCT matches them
        const paired = lb.segs.length === a.region.outer.segs.length && lb.segs.length > 1;
        const what = 'the two profiles cannot be lofted (they may cross each other)';
        const attempt = (check: boolean) => {
          // ruled: straight lines between the two profiles
          const ts = t.add(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6));
          ts.CheckCompatibility(check);
          ts.AddWire(wa.wire);
          ts.AddWire(wb.wire);
          try {
            ts.Build(progress(t));
            const s = t.add(ts.Shape());
            return hasSolid(oc, s) && shapeVolume(oc, s) > 0 ? { ts, s } : null;
          } catch (e) {
            occError(oc, e, what);
            return null;
          }
        };
        const made = attempt(!paired) ?? attempt(paired);
        if (!made) throw new Error(what);
        const { ts } = made;
        const shape = keep(t, made.s);
        const feature = featureOf(tag);
        const tags = [
          ...capTags(t, t.add(ts.FirstShape()), `${tag}/start`, feature),
          ...capTags(t, t.add(ts.LastShape()), `${tag}/end`, feature),
          ...generated(ts, wa.edges, (e) => `${tag}/side:${e}`, feature),
        ];
        return { shape, tags: within(tags, shape) };
      });
    },

    revolve(regions, f, axis, angle, tag) {
      revolveSide(regions, axis);
      const full = angle >= 2 * Math.PI - 1e-12;
      return scratch((t) => union(regions.map((r) => {
        const pf = regionFace(oc, t, r, f, 0);
        const ax = { p: framePoint(f, axis.p), d: frameDir(f, axis.d) };
        const A = ax1(oc, t, ax.p, ax.d);
        const mk = t.add(full ? new oc.BRepPrimAPI_MakeRevol(pf.face, A, false) : new oc.BRepPrimAPI_MakeRevol(pf.face, A, angle, false));
        const shape = arena.add(guard(oc, 'the profile cannot be revolved', () => mk.Shape()));
        const feature = featureOf(tag);
        const tags = revolveTags(t, mk, shape, pf.edges, ax, full ? 2 * Math.PI : angle, (e) => `${tag}/side:${e}`, feature);
        if (!full) tags.push(...capTags(t, t.add(mk.FirstShape()), `${tag}/start`, feature), ...capTags(t, t.add(mk.LastShape()), `${tag}/end`, feature));
        return { shape, tags: within(tags, shape) };
      })));
    },

    hole(centres, d, o, tag) {
      return scratch((t) => {
        const parts = centres.map((p, i) => holeTool(t, p, d, o, `${tag}/hole${i}`));
        // holes that overlap are fused first: a cut through tools that overlap each other is
        // several times slower, and patterns repeat it for every copy
        const D = Math.max(o.d, o.cbD ?? 0, o.csD ?? 0);
        const group = centres.map((_, i) => i);
        const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
        for (let i = 0; i < centres.length; i++) for (let j = 0; j < i; j++) {
          if (Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1], centres[i][2] - centres[j][2]) < D) group[root(i)] = root(j);
        }
        const clusters = new Map<number, OccSolid[]>();
        parts.forEach((s, i) => clusters.set(root(i), [...(clusters.get(root(i)) ?? []), s]));
        const tools = [...clusters.values()].map(union);
        // the rest stay separate tools in one compound: a cut takes them all at once
        return { shape: compound(oc, arena, tools.map((s) => s.shape)), tags: tools.flatMap((s) => s.tags) };
      });
    },

    union,
    // a compound: booleans take its solids as separate tools
    group: (parts) => (parts.length === 1 ? parts[0] : { shape: compound(oc, arena, parts.map((s) => s.shape)), tags: parts.flatMap((s) => s.tags) }),
    cut: (target, tool) => boolean('cut', target, [tool], 'the cut failed'),
    intersect: (target, tool) => boolean('common', target, [tool], 'the intersection failed'),

    transform(s, M, prefix) {
      return scratch((t) => {
        const xf = t.add(new oc.BRepBuilderAPI_Transform(s.shape, trsf(oc, t, M), false, false));
        const shape = arena.add(guard(oc, 'the copy cannot be placed', () => xf.Shape()));
        const feature = featureOf(prefix);
        const tags = s.tags.map((g) => ({ face: arena.add(xf.ModifiedShape(g.face)), key: prefix + g.key, feature }));
        return { shape, tags };
      });
    },

    shared(a, b) {
      try {
        return scratch((t) => {
          const c = t.add(new oc.BRepAlgoAPI_Common());
          const args = t.add(new oc.NCollection_List_TopoDS_Shape());
          t.add(args.Append(a.shape));
          c.SetArguments(args);
          c.SetTools(toolList(t, [b.shape]));
          try {
            c.Build(progress(t));
            return c.HasErrors() ? 0 : shapeVolume(oc, t.add(c.Shape()));
          } finally {
            release(c);
          }
        });
      } catch (e) {
        occError(oc, e, 'no common volume');
        return 0;
      }
    },

    box(ss) {
      return scratch((t) => {
        const bb = t.add(new oc.Bnd_Box());
        for (const s of ss) oc.BRepBndLib.Add(s.shape, bb, false);
        if (bb.IsVoid()) return null;
        return { min: [bb.GetXMin(), bb.GetYMin(), bb.GetZMin()], max: [bb.GetXMax(), bb.GetYMax(), bb.GetZMax()] };
      });
    },
  };
  // an OCCT exception from a step without its own message still becomes a readable Error
  for (const k of Object.keys(ops) as (keyof SolidOps<OccSolid>)[]) {
    const f = ops[k] as (...a: unknown[]) => unknown;
    (ops as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => guard(oc, 'the B-rep kernel could not build this', () => f(...a));
  }
  return ops;
}
