// The sheet-metal features of the timeline: Flange, Edge flange, Hem and Bend change the
// sheet model of a body (sheetMetal.ts) and its solid, made with any solid kernel: a
// flange is a prism of its flat outline, a bend its cross-section revolved about its axis.
// Edge flanges and hems add their pieces to the body as it is (so holes made before them
// stay, with their names); a Bend folds part of the sheet, so the body is made again from
// the model and the cut-outs through it are carried to where their flanges went.
import type { BuildInputs, CadDesign, SolidOps, TimelineBody } from './design';
import { loopPolygon, type ProfileRegion, type Vec2 } from './profile';
import { framePoint, type Frame, type Vec3 } from './solid';
import { refToken, refWords, resolveRef, resolvedEntity } from './topology';
import {
  addFlange, bendAlongLine, bendSection, chainMatrix, cornerOf, findEdge, innerSetback, matrixFrame, outerSetback, plateModel, reliefOf, stripModel,
  type BendFeature, type EdgeFlangeFeature, type FlangeFeature, type HemFeature, type SheetBend, type SheetFeature, type SheetFlange, type SheetModel,
} from './sheetMetal';

export interface SheetContext<S> {
  design: CadDesign;
  inp: BuildInputs;
  /** The bodies so far (changed in place). */
  bodies: TimelineBody<S>[];
  sheets: Record<string, SheetModel>;
  created(id: string, feature: string, solid: S): void;
  frameOf(sketchId: string): Frame;
  /** Profiles of a sketch (one by its key), or an error. */
  profiles(sketchId: string, key?: string): ProfileRegion[];
  itemName(id: string): string | undefined;
  warn(w: string): void;
}

/** A flange piece as a solid: the prism of its flat outline through the sheet, where its chain of folds puts it. */
export const flangeSolid = <S>(ops: SolidOps<S>, m: SheetModel, f: SheetFlange): S => ops.extrude([f.region], matrixFrame(chainMatrix(m, f.chain)), 0, m.t, f.tag);

/** A bend as a solid: its cross-section at the tangent line revolved about its axis (exact cylinders inside and out). */
export function bendSolid<S>(ops: SolidOps<S>, m: SheetModel, b: SheetBend): S {
  const s = bendSection(m, b);
  return ops.revolve([s.region], s.frame, s.axis, b.angle, b.tag);
}

/** The whole sheet from its model. */
export const sheetSolid = <S>(ops: SolidOps<S>, m: SheetModel): S => ops.union([...m.flanges.map((f) => flangeSolid(ops, m, f)), ...m.bends.map((b) => bendSolid(ops, m, b))]);

/** Run a sheet-metal feature; returns the sheet models after it. */
export function sheetStep<S>(ops: SolidOps<S>, cx: SheetContext<S>, item: SheetFeature, p: Record<string, number>): Record<string, SheetModel> {
  switch (item.kind) {
    case 'flange': return baseFlange(ops, cx, item, p);
    case 'edgeflange':
    case 'hem': return edgeFlanges(ops, cx, item, p);
    case 'bend': return bendFeature(ops, cx, item, p);
  }
}

// ------------------------------------------------------------ Flange on a profile

function baseFlange<S>(ops: SolidOps<S>, cx: SheetContext<S>, item: FlangeFeature, p: Record<string, number>): Record<string, SheetModel> {
  const f = cx.frameOf(item.sketch);
  const closed = !item.curves?.length && cx.inp.regions(item.sketch).length > 0;
  let m: SheetModel;
  if (closed) {
    const region = cx.profiles(item.sketch, item.profile)[0];
    m = plateModel(item.id, region, f, !!item.flip, p.t, p.K);
  } else {
    const { pts, ids } = lineChain(cx, item);
    const W = p.width;
    const width: [number, number] = item.symmetric ? [-W / 2, W / 2] : item.reverse ? [-W, 0] : [0, W];
    m = stripModel(item.id, { pts, ids, sketch: f, flip: !!item.flip, width, t: p.t, R: p.R, K: p.K });
  }
  cx.created(item.id, item.id, sheetSolid(ops, m));
  return { ...cx.sheets, [item.id]: m };
}

/** The open lines of a flange's sketch, end to end from one free end. */
function lineChain<S>(cx: SheetContext<S>, item: FlangeFeature): { pts: Vec2[]; ids: string[] } {
  const sk = cx.design.components.flatMap((c) => c.items).find((i) => i.id === item.sketch && i.kind === 'sketch');
  const sol = cx.inp.numbers.sketches[item.sketch];
  if (!sk || sk.kind !== 'sketch' || !sol) throw new Error(cx.inp.numbers.errors[item.sketch] ?? 'the sketch is missing');
  const picked = item.curves?.length ? sk.sketch.entities.filter((e) => item.curves!.includes(e.id)) : sk.sketch.entities.filter((e) => !e.construction && e.type !== 'point');
  if (!picked.length) throw new Error('draw the flange’s profile: a closed outline for a plate, or lines end to end for a bent strip');
  const lines = picked.map((e) => {
    if (e.type !== 'line') throw new Error('an open profile for a flange is made of lines (the bends go at their corners)');
    return e;
  });
  const deg = new Map<string, number>();
  for (const l of lines) for (const q of [l.p1, l.p2]) deg.set(q, (deg.get(q) ?? 0) + 1);
  if ([...deg.values()].some((d) => d > 2)) throw new Error('the lines of the profile branch: draw one chain of lines');
  const ends = [...deg.entries()].filter(([, d]) => d === 1).map(([q]) => q);
  if (ends.length !== 2) throw new Error('the lines close into an outline: that makes a plate (pick the profile), or leave the chain open');
  const used = new Set<string>();
  let at = ends[0];
  const order: string[] = [at], ids: string[] = [];
  while (ids.length < lines.length) {
    const l = lines.find((q) => !used.has(q.id) && (q.p1 === at || q.p2 === at));
    if (!l) throw new Error('the lines of the profile do not join end to end');
    used.add(l.id);
    ids.push(l.id);
    at = l.p1 === at ? l.p2 : l.p1;
    order.push(at);
  }
  return { pts: order.map((id) => ({ x: sol.points[id][0], y: sol.points[id][1] })), ids };
}

// ------------------------------------------------------------ Edge flanges and hems

function edgeFlanges<S>(ops: SolidOps<S>, cx: SheetContext<S>, item: EdgeFlangeFeature | HemFeature, p: Record<string, number>): Record<string, SheetModel> {
  if (!item.edges.length) throw new Error('pick straight edges of the sheet for the flange');
  let sheets = cx.sheets;
  const { t, R } = p;
  const hem = item.kind === 'hem';
  // a hem folds back by 180°, round its gap (closed: flat on the sheet)
  const angle = hem ? Math.PI : p.angle;
  const r = hem ? (item.type === 'open' ? p.gap / 2 : 0) : R;
  const length = hem ? p.length - (r + t) : p.height - (item.datum === 'inner' ? innerSetback(angle, r) : outerSetback(angle, r, t));
  const pos = item.position ?? (hem ? 'adjacent' : 'inside');
  const setback = pos === 'adjacent' ? 0 : hem ? r + t : pos === 'inside' ? outerSetback(angle, r, t) : pos === 'outside' ? innerSetback(angle, r) : (r + t / 2) * Math.tan(angle / 2);
  for (const ref of item.edges) {
    // each edge found on the body as the flanges before it left it
    const topo = cx.bodies.map((b) => ops.topology(b.solid, b.id));
    if (topo.some((b) => b.named === false)) throw new Error('needs the B-rep kernel to find the edges it is on: OpenCascade has not loaded yet');
    const res = resolveRef(ref, topo);
    const edge = resolvedEntity(topo, 'edge', res);
    if (!res.ok || !edge) throw new Error(`reference lost: ${refWords(ref, cx.itemName)}, an edge of the flange, is gone`);
    if (!edge.line) throw new Error('a flange goes on a straight edge');
    const body = cx.bodies.find((b) => b.id === res.body)!;
    const model = sheets[body.id];
    if (!model) throw new Error('an edge flange goes on a sheet-metal body: start it with a Flange on a sketch');
    const hit = findEdge(model, edge.line.a, edge.line.b);
    if (!hit) throw new Error('that edge is not on the outline of a flange of the sheet (an edge across the thickness, or of a bend)');
    const token = refToken(ref);
    const added = addFlange(model, hit, {
      tag: `${item.id}/fl:${token}`, bendTag: `${item.id}/bend:${token}`, token: `${item.id}:${token}`,
      angle, R: r, up: (hit.face === 'B') !== !!item.flip, length, setback,
      o1: hem ? 0 : p.o1 ?? 0, o2: hem ? 0 : p.o2 ?? 0,
      relief: { kind: reliefOf(p.relief), w: p.rw, d: p.rd }, corner: { kind: cornerOf(p.corner), size: p.cs },
    });
    let s = body.solid;
    if (added.removed.length) {
      const F = matrixFrame(chainMatrix(model, added.parent.chain));
      // named after the parent: as a rebuild from the model would name those sides
      s = ops.cut(s, ops.group(added.removed.map((rg) => ops.extrude([rg], F, 0, t, added.parent.tag))));
    }
    body.solid = ops.union([s, bendSolid(ops, added.model, added.bend), flangeSolid(ops, added.model, added.flange)]);
    sheets = { ...sheets, [body.id]: added.model };
  }
  return sheets;
}

// ------------------------------------------------------------ Bend along a sketch line

function bendFeature<S>(ops: SolidOps<S>, cx: SheetContext<S>, item: BendFeature, p: Record<string, number>): Record<string, SheetModel> {
  const sk = cx.design.components.flatMap((c) => c.items).find((i) => i.id === item.sketch && i.kind === 'sketch');
  const sol = cx.inp.numbers.sketches[item.sketch];
  if (!sk || sk.kind !== 'sketch' || !sol) throw new Error(cx.inp.numbers.errors[item.sketch] ?? 'the sketch is missing');
  const ln = sk.sketch.entities.find((e) => e.type === 'line' && (item.line ? e.id === item.line : !e.construction));
  if (!ln || ln.type !== 'line') throw new Error('draw the bend line on a face of the sheet');
  const f = cx.frameOf(item.sketch);
  const at = (id: string): Vec3 => framePoint(f, { x: sol.points[id][0], y: sol.points[id][1] });
  const normal = item.down ? (f.n.map((v) => -v) as Vec3) : f.n;
  let last: unknown = null;
  for (const [id, model] of Object.entries(cx.sheets)) {
    const body = cx.bodies.find((b) => b.id === id);
    if (!body) continue;
    let done;
    try {
      done = bendAlongLine(model, at(ln.p1), at(ln.p2), { tag: `${item.id}/fl`, bendTag: `${item.id}/bend`, angle: p.angle, R: p.R, normal, placement: item.placement ?? 'centre', flip: !!item.flip });
    } catch (e) {
      last = e;
      continue;
    }
    // the cut-outs through the sheet so far, carried to where their flange went
    const cuts = ops.sheetCutouts ? ops.sheetCutouts(body.solid, model) : [];
    let s = sheetSolid(ops, done.model);
    const tools: S[] = [];
    for (const c of cuts) for (const rg of c.regions) {
      const into = c.tag === done.split ? (beyond(done.bend, rg) ? done.moving : done.split) : c.tag;
      const fl = done.model.flanges.find((q) => q.tag === into);
      if (!fl) continue;
      tools.push(ops.extrude([rg], matrixFrame(chainMatrix(done.model, fl.chain)), 0, model.t, `${item.id}/cut`));
    }
    if (tools.length) s = ops.cut(s, ops.group(tools));
    body.solid = s;
    return { ...cx.sheets, [id]: done.model };
  }
  if (last) throw last;
  throw new Error('a bend goes on a sheet-metal body: start it with a Flange on a sketch');
}

/** Whether a cut-out of a split flange lies past the bend (its middle on the side that moves). */
function beyond(b: SheetBend, rg: ProfileRegion): boolean {
  const pts = loopPolygon(rg.outer, Math.PI / 18);
  const c = pts.reduce((s, q) => ({ x: s.x + q.x / pts.length, y: s.y + q.y / pts.length }), { x: 0, y: 0 });
  return (c.x - b.o.x) * b.w.x + (c.y - b.o.y) * b.w.y > b.BA / 2;
}
