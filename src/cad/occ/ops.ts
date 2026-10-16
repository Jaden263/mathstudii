// The B-rep kernel behind the design timeline: every feature as exact OCCT geometry.
//
// Solids carry the history of their faces (which feature and which sketch entity made
// each one): primitives tag their faces when they are made (an extruded line's side
// face, the start and end caps, a fillet's round, a thin wall's offset sides), and every
// later operation passes the tags on through OCCT's history (Modified, IsDeleted): a
// face a boolean splits keeps its tag on every piece, a face that merges several keeps
// them all. The persistent names of faces, edges and vertices are made from the tags
// (occ/topology.ts).
import type { NCollection_List_TopoDS_Shape, TopoDS_Edge, TopoDS_Shape, TopoDS_Wire } from 'replicad-opencascadejs';
import type { HoleOptions, ModifyPick, SolidOps } from '../design';
import type { ProfileRegion } from '../profile';
import type { EdgeOptions } from '../shaping';
import { Arena, add3, cross3, dot3, frameDir, frameFromNormal, framePoint, m4Point, m4Rotate, revolveSide, sub3, type Frame, type Vec3 } from '../solid';
import { faceName, nameToken } from '../topology';
import { alignLoop, loopWire, regionFace, reversedLoop, wireFaces, type ProfileFace, type TaggedEdge } from './geometry';
import { ShapeIndex, ax1, compound, dir, guard, hasSolid, listShapes, occBox, occError, pnt, scratch, shapeIndex, subShapes, trsf, vec, xyz, type OC } from './kernel';
import { faceInfo, topologyOcc } from './topology';

export interface FaceTag {
  face: TopoDS_Shape;
  /** History key `${feature}/${role}`: f1/side:l3, f1/end, f2/hole0:wall, f4.2.f2/hole0:wall (a copy). */
  key: string;
  /** Feature that made the face (the pattern or mirror for copies). */
  feature: string;
}

export interface OccSolid {
  shape: TopoDS_Shape;
  tags: FaceTag[];
}

/** What fillets and chamfers have in common: chains of edges built from a picked one. */
type RoundingBuilder = {
  Contour(E: TopoDS_Edge): number;
  NbEdges(I: number): number;
  Edge(I: number, J: number): TopoDS_Edge;
  FirstVertex(IC: number): TopoDS_Shape;
  LastVertex(IC: number): TopoDS_Shape;
  Remove(E: TopoDS_Edge): void;
  Build(r: unknown): void;
  IsDone(): boolean;
  Shape(): TopoDS_Shape;
  Generated(S: TopoDS_Shape): NCollection_List_TopoDS_Shape;
  Modified(S: TopoDS_Shape): NCollection_List_TopoDS_Shape;
  IsDeleted(S: TopoDS_Shape): boolean;
  delete(): void;
};

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
  const checkExtent = (z0: number, z1: number) => {
    if (!(z1 - z0 > 0)) throw new Error('the extent must be positive');
  };

  /** The edges of a face, named by `name` (by the edge's index in `index`), else `fallback`. */
  const faceEdges = (t: Arena, face: TopoDS_Shape, index: ShapeIndex, name: string[], fallback: string): TaggedEdge[] =>
    subShapes(oc, t, face, EDGE).map((e) => ({ edge: t.add(oc.TopoDS.Edge(e)), entity: name[index.indexOf(e)] ?? fallback }));

  /**
   * Faces of one loop offset by d (> 0 grows it), every edge named after the sketch entity
   * whose offset it is, with `side` ('out' or 'in'); none when the loop vanishes.
   */
  const offsetLoopFaces = (t: Arena, loop: { wire: TopoDS_Wire; edges: TaggedEdge[] }, d: number, f: Frame, z: number, side: string): ProfileFace[] => {
    const mk = t.add(new oc.BRepOffsetAPI_MakeOffset(loop.wire, oc.GeomAbs_JoinType.GeomAbs_Intersection, false));
    try {
      mk.Perform(d, 0);
      if (!mk.IsDone()) return [];
      const index = new ShapeIndex(oc), name: string[] = [];
      for (const e of loop.edges) for (const g of listShapes(t, mk.Generated(e.edge))) name[index.add(g)] = `${e.entity}:${side}`;
      const wires = subShapes(oc, t, t.add(mk.Shape()), oc.TopAbs_ShapeEnum.TopAbs_WIRE).map((w) => t.add(oc.TopoDS.Wire(w)));
      return wireFaces(oc, t, wires, f, z).map((face) => ({ face, edges: faceEdges(t, face, index, name, `wall:${side}`) }));
    } catch (e) {
      occError(oc, e, 'the offset vanished');
      return [];
    }
  };

  /**
   * A region offset by d with sharp corners, as a sketch offset: the outline grows by d,
   * holes shrink by d. Its edges are named after the entities they offset.
   */
  const offsetRegion = (t: Arena, r: ProfileRegion, d: number, f: Frame, z: number, side: string): { face: TopoDS_Shape; edges: TaggedEdge[] } | null => {
    const outer = offsetLoopFaces(t, loopWire(oc, t, r.outer, f, z), d, f, z, side);
    if (!outer.length) return null;
    const holes = r.holes.flatMap((h) => offsetLoopFaces(t, loopWire(oc, t, reversedLoop(h), f, z), -d, f, z, side));
    const o = compound(oc, t, outer.map((q) => q.face));
    if (!holes.length) return { face: o, edges: outer.flatMap((q) => q.edges) };
    const cut = t.add(new oc.BRepAlgoAPI_Cut(o, compound(oc, t, holes.map((q) => q.face)), progress(t)));
    try {
      const shape = t.add(guard(oc, 'the wall cannot be offset', () => cut.Shape()));
      // the cut trims the outlines: their names follow its history
      const index = new ShapeIndex(oc), name: string[] = [];
      for (const { edge, entity } of [...outer, ...holes].flatMap((q) => q.edges)) {
        if (cut.IsDeleted(edge)) continue;
        const mods = listShapes(t, cut.Modified(edge));
        for (const g of mods.length ? mods : [edge]) name[index.add(g)] = entity;
      }
      return { face: shape, edges: faceEdges(t, shape, index, name, `wall:${side}`) };
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

  // ---------------------------------------------------------- modify features

  /** The tags of one face of a solid. */
  const faceTags = (s: OccSolid, face: TopoDS_Shape) => s.tags.filter((g) => g.face.IsSame(face));
  /** A short name for a face from its history keys (shell walls are named after the face they offset). */
  const faceToken = (s: OccSolid, face: TopoDS_Shape) => nameToken(faceName(faceTags(s, face).map((g) => g.key)));

  /** A solid that passes OCCT's checks (a rounding too large for its faces can "succeed" with a broken one). */
  const sound = (t: Arena, shape: TopoDS_Shape, what: string) => {
    if (!hasSolid(oc, shape) || !(shapeVolume(oc, shape) > 0)) throw new Error(what);
    if (!t.add(new oc.BRepCheck_Analyzer(shape, true, false, false)).IsValid()) throw new Error(what);
  };

  /** Lexicographic order of two points (x, then y, then z), equal within tol. */
  const before = (a: Vec3, b: Vec3, tol: number) => {
    for (let k = 0; k < 3; k++) if (Math.abs(a[k] - b[k]) > tol) return a[k] < b[k];
    return false;
  };

  /**
   * Fillets and chamfers on picked edges. OCCT always takes the chain of edges tangent to a
   * picked one (a rounded rectangle's whole outline); without `chain` that is refused rather
   * than rounding more than was picked. The faces made from an edge are named after the pick
   * whose chain it is.
   */
  const roundEdges = (s: OccSolid, kind: 'round' | 'chamfer', picks: { pick: ModifyPick; add: (mk: RoundingBuilder, edge: TopoDS_Edge) => void }[], chain: boolean, tag: string): OccSolid => scratch((t) => {
    const E = shapeIndex(oc, t, s.shape, EDGE);
    const mk = t.add(kind === 'round' ? new oc.BRepFilletAPI_MakeFillet(s.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational) : new oc.BRepFilletAPI_MakeChamfer(s.shape)) as RoundingBuilder;
    const picked = new Set(picks.map((q) => q.pick.index));
    const named: { edge: TopoDS_Edge; name: string }[] = [];
    for (const { pick, add } of picks) {
      const edge = E.shapes[pick.index] && t.add(oc.TopoDS.Edge(E.shapes[pick.index]));
      if (!edge) throw new Error('a picked edge is not on the body');
      // an edge an earlier pick's chain took is rounded already
      if (mk.Contour(edge) > 0) continue;
      add(mk, edge);
      const ic = mk.Contour(edge);
      if (!ic) throw new Error(`the ${kind === 'round' ? 'fillet' : 'chamfer'} does not fit this edge`);
      const more = [];
      for (let j = 1; j <= mk.NbEdges(ic); j++) {
        const e = t.add(mk.Edge(ic, j));
        named.push({ edge: e, name: pick.name });
        if (!picked.has(E.indexOf(e))) more.push(e);
      }
      if (!chain && more.length) {
        throw new Error(`OpenCascade rounds along tangent edges, and a picked edge goes on into ${more.length} more: turn Tangent chain on, or pick ${more.length > 1 ? 'them' : 'it'} too`);
      }
    }
    const what = `the ${kind === 'round' ? 'fillet' : 'chamfer'} does not fit`;
    const shape = arena.add(guard(oc, what, () => {
      mk.Build(progress(t));
      if (!mk.IsDone()) throw new Error(what);
      return mk.Shape();
    }));
    sound(t, shape, what);
    const feature = featureOf(tag);
    const tags = carry(mk, s.tags, shape);
    for (const { edge, name } of named) for (const face of listShapes(arena, mk.Generated(edge))) tags.push({ face, key: `${tag}/${kind}:${name}`, feature });
    return { shape, tags: within(tags, shape) };
  });

  /**
   * A tool that moves a face of `s` by d along its normal, to fuse (d > 0) or cut (d < 0):
   * the prism of a flat face, the ring between the old and the new radius of a cylinder. The
   * face where the moved one now is keeps its name; the tool's sides are named after the
   * faces they extend (a flush side merges back into one face of the same name).
   */
  const faceMover = (t: Arena, s: OccSolid, face: TopoDS_Shape, d: number): OccSolid => {
    const f = t.add(oc.TopoDS.Face(face));
    const info = faceInfo(oc, t, f, 0);
    const own = faceTags(s, face);
    // the faces next to it, across each of its edges
    const allFaces = subShapes(oc, t, s.shape, FACE);
    const across = (edge: TopoDS_Shape) => allFaces.filter((g) => !g.IsSame(face) && shapeIndex(oc, t, g, EDGE).has(edge));
    const retag = (target: TopoDS_Shape, from: FaceTag[]) => from.map((g) => ({ face: target, key: g.key, feature: g.feature }));
    if (info.type === 'plane' && info.frame) {
      const mk = t.add(new oc.BRepPrimAPI_MakePrism(f, vec(oc, t, scale(info.frame.n, d)), false, true));
      const shape = arena.add(guard(oc, 'the face cannot be moved', () => mk.Shape()));
      const tags: FaceTag[] = [];
      for (const far of subShapes(oc, t, t.add(mk.LastShape()), FACE)) tags.push(...retag(keep(t, far), own));
      for (const e of subShapes(oc, t, f, EDGE)) {
        const next = across(e).flatMap((g) => faceTags(s, g));
        for (const side of listShapes(arena, mk.Generated(e))) tags.push(...retag(side, next));
      }
      return { shape, tags: within(tags, shape) };
    }
    if (info.type === 'cylinder' && info.axis && info.radius) {
      const a = t.add(new oc.BRepAdaptor_Surface(f, true));
      const pos = t.add(t.add(a.Cylinder()).Position());
      const L = xyz(t.add(pos.Location())), X = xyz(t.add(pos.XDirection())), Z = xyz(t.add(pos.Direction()));
      const Y = xyz(t.add(pos.YDirection()));
      const { UMin, UMax, VMin, VMax } = oc.BRepTools.UVBounds(f);
      const r = info.radius;
      const at = (u: number, v: number, rad = r): Vec3 => [0, 1, 2].map((k) => L[k] + rad * (Math.cos(u) * X[k] + Math.sin(u) * Y[k]) + v * Z[k]) as Vec3;
      // the face's normal out of the material, against the way out from the axis: a boss or a hole
      const um = (UMin + UMax) / 2, vm = (VMin + VMax) / 2, h = 1e-3;
      const du = sub3(at(um + h, vm), at(um - h, vm)), dv = sub3(at(um, vm + h), at(um, vm - h));
      let n = cross3(du, dv);
      if (f.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = scale(n, -1);
      const out = dot3(n, sub3(at(um, vm), at(um, vm, 0))) > 0 ? 1 : -1;
      const r2 = r + out * d;
      if (!(r2 > 0)) throw new Error('the cylinder shrinks to nothing');
      const [r0, r1] = r2 > r ? [r, r2] : [r2, r];
      // the ring's half section at the face's start angle, swept over its angle (u turns about
      // Z in a right-handed frame, about −Z in a left-handed one)
      const pts = [at(UMin, VMin, r0), at(UMin, VMin, r1), at(UMin, VMax, r1), at(UMin, VMax, r0)];
      const mw = t.add(new oc.BRepBuilderAPI_MakeWire());
      const vs = pts.map((q) => t.add(t.add(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, t, q))).Vertex()));
      const sides: TopoDS_Edge[] = [];
      for (let i = 0; i < 4; i++) {
        const e = t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(vs[i], vs[(i + 1) % 4])).Edge());
        mw.Add(e);
        sides.push(e);
      }
      const sec = t.add(t.add(new oc.BRepBuilderAPI_MakeFace(t.add(mw.Wire()), true)).Face());
      const span = UMax - UMin;
      const axis = ax1(oc, t, L, pos.Direct() ? Z : scale(Z, -1));
      const mk = t.add(span >= 2 * Math.PI - 1e-9 ? new oc.BRepPrimAPI_MakeRevol(sec, axis, false) : new oc.BRepPrimAPI_MakeRevol(sec, axis, span, false));
      const shape = arena.add(guard(oc, 'the cylinder cannot be grown', () => mk.Shape()));
      // the moved wall is the edge at the new radius; ends and cut sides extend the flat faces they lie in
      const tags: FaceTag[] = [];
      const neighbours = subShapes(oc, t, f, EDGE).flatMap(across);
      const flat = neighbours.map((g) => ({ g, info: faceInfo(oc, t, t.add(oc.TopoDS.Face(g)), 0) })).filter((q) => q.info.frame);
      const tol = 1e-7 * (1 + r1 + Math.abs(VMax - VMin));
      sides.forEach((e, i) => {
        for (const g of listShapes(arena, mk.Generated(e))) {
          if (i === (r2 > r ? 1 : 3)) tags.push(...retag(g, own));
          else if (i === 0 || i === 2) {
            const c = faceInfo(oc, t, t.add(oc.TopoDS.Face(g)), 0).c;
            const on = flat.find((q) => Math.abs(dot3(sub3(c, q.info.frame!.o), q.info.frame!.n)) < tol);
            if (on) tags.push(...retag(g, faceTags(s, on.g)));
          }
        }
      });
      return { shape, tags: within(tags, shape) };
    }
    throw new Error('press-pull moves flat and cylindrical faces only');
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
        // the wall's faces are named after the entities they offset: the profile's own
        // sides as in any extrusion, the offset ones with :out or :in
        const outer = a ? offsetRegion(t, r, a, f, z0, 'out') : regionFace(oc, t, r, f, z0);
        if (!outer) throw new Error('the wall is thicker than the profile');
        if (caps * o.t >= h) throw new Error('the caps are thicker than the extrusion');
        const shell = prism(t, outer.face, outer.edges, scale(f.n, h), tag);
        // the hollow, between the caps (and past the open ends)
        const lo = o.cap === 'start' || o.cap === 'both' ? z0 + o.t : z0 - h;
        const hi = o.cap === 'end' || o.cap === 'both' ? z1 - o.t : z1 + h;
        const inner = b ? offsetRegion(t, r, b, f, lo, 'in') : regionFace(oc, t, r, f, lo);
        if (!inner) return shell;
        const core = prism(t, inner.face, inner.edges, scale(f.n, hi - lo), tag, ['inner-start', 'inner-end']);
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

    topology: (s, id) => topologyOcc(oc, s, id),

    fillet(s, sets, chain, tag) {
      const tol = 1e-9 * (1 + Math.max(...(occBox(oc, [s.shape])?.max.map(Math.abs) ?? [1])));
      return roundEdges(s, 'round', sets.flatMap((set) => set.picks.map((pick) => ({
        pick,
        add: (mk: RoundingBuilder, edge: TopoDS_Edge) => {
          const fm = mk as unknown as { Add(r1: number, r2: number | TopoDS_Edge, e?: TopoDS_Edge): void };
          if (set.r2 === undefined || set.r2 === set.r) return fm.Add(set.r, edge);
          // a linear radius from the start of the chain (its end first in x, then y, then z) to its end
          fm.Add(set.r, set.r2, edge);
          const ic = mk.Contour(edge);
          const p = (v: TopoDS_Shape) => scratch((q) => xyz(q.add(oc.BRep_Tool.Pnt(q.add(oc.TopoDS.Vertex(q.add(v)))))));
          const first = p(mk.FirstVertex(ic)), last = p(mk.LastVertex(ic));
          if (before(last, first, tol)) {
            mk.Remove(edge);
            fm.Add(set.r2, set.r, edge);
          }
        },
      }))), chain, tag);
    },

    chamfer(s, picks, o, chain, tag) {
      return scratch((t) => {
        const F = shapeIndex(oc, t, s.shape, FACE);
        return roundEdges(s, 'chamfer', picks.map((pick) => ({
          pick,
          add: (mk: RoundingBuilder, edge: TopoDS_Edge) => {
            const ch = mk as unknown as InstanceType<OC['BRepFilletAPI_MakeChamfer']>;
            if (o.type === 'equal') return ch.Add(o.d, edge);
            const face = pick.face !== undefined && F.shapes[pick.face];
            if (!face) throw new Error('this edge has no two faces to measure the chamfer on');
            const f = t.add(oc.TopoDS.Face(face));
            if (o.type === 'two') ch.Add(o.d, o.d2 ?? o.d, edge, f);
            else ch.AddDA(o.d, o.angle ?? Math.PI / 4, edge, f);
          },
        })), chain, tag);
      });
    },

    shell(s, faces, th, outside, tag) {
      return scratch((t) => {
        // a boolean's result is a compound of its solids, whose offset is only a shell: offset the solid
        const solids = subShapes(oc, t, s.shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
        if (solids.length !== 1) throw new Error('only a body of one solid can be shelled');
        const body = solids[0];
        const F = shapeIndex(oc, t, s.shape, FACE);
        const what = 'the wall does not fit';
        const side = outside ? 'out' : 'in';
        const feature = featureOf(tag);
        const off = outside ? th : -th;
        // a wall too thick for the body comes back as the body itself, unchanged
        const v0 = shapeVolume(oc, s.shape);
        const changed = (shape: TopoDS_Shape) => {
          sound(t, shape, what);
          const v = shapeVolume(oc, shape);
          if (!(Math.abs(v - v0) > 1e-9 * v0) || (!outside && v > v0)) throw new Error(what);
        };
        // the offset walls are named after the faces they offset
        const walls = (mk: { Generated(s: TopoDS_Shape): NCollection_List_TopoDS_Shape }) => F.shapes.flatMap((g) =>
          listShapes(arena, mk.Generated(g)).map((face) => ({ face, key: `${tag}/${side}:${faceToken(s, g)}`, feature })));
        if (faces.length) {
          const mk = t.add(new oc.BRepOffsetAPI_MakeThickSolid());
          const open = t.add(new oc.NCollection_List_TopoDS_Shape());
          for (const i of faces) t.add(open.Append(F.shapes[i]));
          // sharp corners (offset faces made to meet), not rounded ones
          guard(oc, what, () => mk.MakeThickSolidByJoin(body, open, off, 1e-7, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, progress(t)));
          if (!mk.IsDone()) throw new Error(what);
          const shape = arena.add(mk.Shape());
          changed(shape);
          return { shape, tags: within([...carry(mk, s.tags, shape), ...walls(mk)], shape) };
        }
        // no opening: the body less its offset inside (or the offset outside less the body)
        const mk = t.add(new oc.BRepOffsetAPI_MakeOffsetShape());
        guard(oc, what, () => mk.PerformByJoin(body, off, 1e-7, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, progress(t)));
        if (!mk.IsDone()) throw new Error(what);
        const skin = { shape: arena.add(mk.Shape()), tags: walls(mk) };
        sound(t, skin.shape, what);
        const r = outside ? boolean('cut', skin, [s], what) : boolean('cut', s, [skin], what);
        changed(r.shape);
        return r;
      });
    },

    draft(s, faces, pull, angle, plane) {
      return scratch((t) => {
        const F = shapeIndex(oc, t, s.shape, FACE);
        const mk = t.add(new oc.BRepOffsetAPI_DraftAngle(s.shape));
        const neutral = t.add(new oc.gp_Pln(pnt(oc, t, plane.o), dir(oc, t, plane.n)));
        const D = dir(oc, t, pull);
        for (const i of faces) {
          guard(oc, 'a picked face cannot be drafted', () => mk.Add(t.add(oc.TopoDS.Face(F.shapes[i])), D, angle, neutral, true));
          if (!mk.AddDone()) throw new Error('a picked face cannot be drafted: only flat, cylindrical and conical faces that are not parallel to the neutral plane can');
        }
        const what = 'the draft does not fit: the tilted faces cannot be joined to their neighbours';
        guard(oc, what, () => mk.Build(progress(t)));
        if (!mk.IsDone()) throw new Error(what);
        const shape = arena.add(mk.Shape());
        sound(t, shape, what);
        // faces keep their names: a drafted face is the same face, tilted
        const tags = s.tags.filter((g) => !mk.IsDeleted(g.face)).map((g) => ({ ...g, face: arena.add(mk.ModifiedShape(g.face)) }));
        return { shape, tags: within(tags, shape) };
      });
    },

    pressPull(s, faces, d) {
      if (!d) return s;
      return scratch((t) => {
        const F = shapeIndex(oc, t, s.shape, FACE);
        const tools = faces.map((i) => faceMover(t, s, F.shapes[i], d));
        const r = boolean(d > 0 ? 'fuse' : 'cut', s, tools, d > 0 ? 'the faces cannot be pulled' : 'the faces cannot be pushed');
        if (!hasSolid(oc, r.shape) || !(shapeVolume(oc, r.shape) > 0)) throw new Error('the faces are pushed through the whole body');
        return r;
      });
    },

    split(s, pl, tag) {
      return scratch((t) => {
        const bb = occBox(oc, [s.shape]);
        if (!bb) throw new Error('the body is empty');
        // the plane as a face well past the body, centred on it
        const mid = scale(add3(bb.min, bb.max), 0.5);
        const at = sub3(mid, scale(pl.n, dot3(sub3(mid, pl.o), pl.n)));
        const R = 2 * Math.hypot(...sub3(bb.max, bb.min)) + 1;
        const cutter = t.add(t.add(new oc.BRepBuilderAPI_MakeFace(t.add(new oc.gp_Pln(pnt(oc, t, at), dir(oc, t, pl.n))), -R, R, -R, R)).Face());
        const sp = t.add(new oc.BRepAlgoAPI_Splitter());
        const args = t.add(new oc.NCollection_List_TopoDS_Shape());
        t.add(args.Append(s.shape));
        const tl = t.add(new oc.NCollection_List_TopoDS_Shape());
        t.add(tl.Append(cutter));
        sp.SetArguments(args);
        sp.SetTools(tl);
        try {
          guard(oc, 'the body cannot be split', () => sp.Build(progress(t)));
          if (sp.HasErrors()) throw new Error('the body cannot be split');
          const result = t.add(sp.Shape());
          const cut: FaceTag = { face: cutter, key: `${tag}/split`, feature: featureOf(tag) };
          const pieces = subShapes(oc, t, result, oc.TopAbs_ShapeEnum.TopAbs_SOLID).map((q) => {
            const shape = keep(t, q);
            const c = scratch((u) => {
              const g = u.add(new oc.GProp_GProps());
              oc.BRepGProp.VolumeProperties(shape, g, false, false, false);
              return xyz(u.add(g.CentreOfMass()));
            });
            return { solid: { shape, tags: carry(sp, [...s.tags, cut], shape) }, side: dot3(sub3(c, pl.o), pl.n), c };
          });
          // behind the plane first, then along x, y, z
          const tol = 1e-9 * R;
          pieces.sort((a, b) => (Math.abs(a.side - b.side) > tol && Math.sign(a.side) !== Math.sign(b.side) ? a.side - b.side : before(a.c, b.c, tol) ? -1 : before(b.c, a.c, tol) ? 1 : 0));
          return pieces.map((q) => q.solid);
        } finally {
          release(sp);
        }
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
        // a body moved in place keeps its faces' names and features; a copy is the copy's
        const tags = s.tags.map((g) => ({ face: arena.add(xf.ModifiedShape(g.face)), key: prefix + g.key, feature: prefix ? featureOf(prefix) : g.feature }));
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
