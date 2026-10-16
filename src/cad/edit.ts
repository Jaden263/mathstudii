// Editing operations on CAD sketches, kept free of React so they can be tested:
// hit testing, constraints and dimensions from a selection, local dimension values.
import { math } from '../engine/math';
import { cadId, isDimension, nextDimName, type CadConstraint, type CadEntity, type CadSketch, type ConstraintType } from './model';
import { measure, solveSketch } from './solver';
import type { Vec2 } from './profile';
import { dimensionValue } from './dimension';

export interface Geo {
  sk: CadSketch;
  P: Map<string, Vec2>;
  R: Map<string, number>;
}

export type Pick = { kind: 'point' | 'entity' | 'constraint'; id: string };

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from p to the segment ab. */
export function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Angle in [a0, a0 + sweep) test for CCW arcs. */
function onArcSweep(ang: number, a0: number, a1: number): boolean {
  const tau = 2 * Math.PI;
  const sweep = (((a1 - a0) % tau) + tau) % tau || tau;
  const d = (((ang - a0) % tau) + tau) % tau;
  return d <= sweep;
}

export function entityRadius(g: Geo, e: CadEntity): number {
  if (e.type === 'circle') return g.R.get(e.id) ?? Math.abs(e.r);
  if (e.type === 'arc') return dist(g.P.get(e.c)!, g.P.get(e.p1)!);
  return 0;
}

/** Distance from p (world) to an entity's curve. */
export function entityDist(g: Geo, e: CadEntity, p: Vec2): number {
  switch (e.type) {
    case 'line': return segDist(p, g.P.get(e.p1)!, g.P.get(e.p2)!);
    case 'circle': return Math.abs(dist(p, g.P.get(e.c)!) - entityRadius(g, e));
    case 'arc': {
      const c = g.P.get(e.c)!, a = g.P.get(e.p1)!, b = g.P.get(e.p2)!;
      const ang = Math.atan2(p.y - c.y, p.x - c.x);
      if (onArcSweep(ang, Math.atan2(a.y - c.y, a.x - c.x), Math.atan2(b.y - c.y, b.x - c.x))) return Math.abs(dist(p, c) - entityRadius(g, e));
      return Math.min(dist(p, a), dist(p, b));
    }
    case 'point': return dist(p, g.P.get(e.p)!);
  }
}

/** Nearest point within tol (world units), then nearest curve. */
export function hitTest(g: Geo, p: Vec2, tol: number, skip: Set<string> = new Set()): Pick | null {
  let best: Pick | null = null;
  let bd = tol;
  for (const [id, q] of g.P) {
    if (skip.has(id)) continue;
    const d = dist(p, q);
    if (d < bd) { bd = d; best = { kind: 'point', id }; }
  }
  if (best) return best;
  bd = tol;
  for (const e of g.sk.entities) {
    if (skip.has(e.id) || e.type === 'point') continue;
    const d = entityDist(g, e, p);
    if (d < bd) { bd = d; best = { kind: 'entity', id: e.id }; }
  }
  return best;
}

// ------------------------------------------------------------ constraints from a selection

export const CONSTRAINT_TOOLS: { type: ConstraintType | 'onObject'; label: string; glyph: string; key?: string; help: string }[] = [
  { type: 'coincident', label: 'Coincident', glyph: '•', help: 'Two points coincide (or a point lies on a line, circle or arc)' },
  { type: 'horizontal', label: 'Horizontal', glyph: 'H', key: 'h', help: 'Lines, or two points, horizontal (H)' },
  { type: 'vertical', label: 'Vertical', glyph: 'V', key: 'v', help: 'Lines, or two points, vertical (V)' },
  { type: 'parallel', label: 'Parallel', glyph: '∥', help: 'Two lines parallel' },
  { type: 'perpendicular', label: 'Perpendicular', glyph: '⊥', help: 'Two lines perpendicular' },
  { type: 'tangent', label: 'Tangent', glyph: 'T', key: 't', help: 'A line and a circle/arc, or two circles/arcs, tangent (T)' },
  { type: 'equal', label: 'Equal', glyph: '=', key: 'e', help: 'Lines of equal length, or circles/arcs of equal radius (E)' },
  { type: 'midpoint', label: 'Midpoint', glyph: 'M', help: 'A point at the middle of a line' },
  { type: 'symmetric', label: 'Symmetric', glyph: '⇹', help: 'Two points symmetric about a line' },
  { type: 'concentric', label: 'Concentric', glyph: '◎', help: 'Circles/arcs with the same centre' },
  { type: 'fix', label: 'Fix', glyph: '⚓', key: 'f', help: 'Hold points (or whole entities) where they are (F)' },
];

export const GLYPH: Partial<Record<ConstraintType, string>> = {
  horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', tangent: 'T', equal: '=', midpoint: 'M',
  symmetric: '⇹', concentric: '◎', fix: '⚓', pointOnLine: '∈', pointOnCircle: '∈',
};

interface Sorted {
  points: string[];
  lines: string[];
  rounds: string[]; // circles and arcs
  entities: CadEntity[];
}

function sortPicks(g: Geo, ids: string[]): Sorted {
  const ents = new Map(g.sk.entities.map((e) => [e.id, e]));
  const out: Sorted = { points: [], lines: [], rounds: [], entities: [] };
  for (const id of ids) {
    if (g.P.has(id)) { out.points.push(id); continue; }
    const e = ents.get(id);
    if (!e) continue;
    out.entities.push(e);
    if (e.type === 'line') out.lines.push(id);
    else if (e.type === 'circle' || e.type === 'arc') out.rounds.push(id);
    else if (e.type === 'point') out.points.push(e.p);
  }
  return out;
}

const C = (type: ConstraintType, refs: string[], extra: Partial<CadConstraint> = {}): CadConstraint => ({ id: cadId('k'), type, refs, ...extra });

/** Constraints for the selected items, or a message saying what to select. */
export function constraintFromSelection(type: ConstraintType, g: Geo, ids: string[]): CadConstraint[] | string {
  const s = sortPicks(g, ids);
  const np = s.points.length, nl = s.lines.length, nr = s.rounds.length;
  const n = np + nl + nr;
  switch (type) {
    case 'coincident':
      if (np === 2 && n === 2) return [C('coincident', s.points)];
      if (np === 1 && nl === 1 && n === 2) return [C('pointOnLine', [s.points[0], s.lines[0]])];
      if (np === 1 && nr === 1 && n === 2) return [C('pointOnCircle', [s.points[0], s.rounds[0]])];
      return 'Select two points, or a point and a line, circle or arc';
    case 'horizontal':
    case 'vertical':
      if (nl >= 1 && np === 0 && nr === 0) return s.lines.map((l) => C(type, [l]));
      if (np === 2 && n === 2) return [C(type, s.points)];
      return 'Select one or more lines, or two points';
    case 'parallel':
    case 'perpendicular':
      if (nl >= 2 && n === nl) return s.lines.slice(1).map((l) => C(type, [s.lines[0], l]));
      return 'Select two lines';
    case 'equal':
      if (nl >= 2 && n === nl) return s.lines.slice(1).map((l) => C('equal', [s.lines[0], l]));
      if (nr >= 2 && n === nr) return s.rounds.slice(1).map((r) => C('equal', [s.rounds[0], r]));
      return 'Select two or more lines, or two or more circles/arcs';
    case 'tangent': {
      if (nl === 1 && nr === 1 && n === 2) return [C('tangent', [s.lines[0], s.rounds[0]])];
      if (nr === 2 && n === 2) {
        const [e0, e1] = s.rounds.map((id) => g.sk.entities.find((e) => e.id === id)!);
        const c0 = g.P.get(e0.type === 'line' || e0.type === 'point' ? '' : e0.c)!, c1 = g.P.get(e1.type === 'line' || e1.type === 'point' ? '' : e1.c)!;
        const d = dist(c0, c1), r0 = entityRadius(g, e0), r1 = entityRadius(g, e1);
        // keep the arrangement the user drew: one inside the other, or side by side
        return [C('tangent', s.rounds, { mode: d < Math.max(r0, r1) ? 'int' : 'ext' })];
      }
      return 'Select a line and a circle/arc, or two circles/arcs';
    }
    case 'midpoint':
      if (np === 1 && nl === 1 && n === 2) return [C('midpoint', [s.points[0], s.lines[0]])];
      return 'Select a point and a line';
    case 'symmetric':
      if (np === 2 && nl === 1 && n === 3) return [C('symmetric', [s.points[0], s.points[1], s.lines[0]])];
      return 'Select two points and the line of symmetry';
    case 'concentric':
      if (nr === 2 && n === 2) return [C('concentric', s.rounds)];
      return 'Select two circles or arcs';
    case 'fix': {
      const pts = new Set(s.points);
      for (const e of s.entities) {
        if (e.type === 'line') { pts.add(e.p1); pts.add(e.p2); }
        else if (e.type === 'circle') pts.add(e.c);
        else if (e.type === 'arc') { pts.add(e.c); pts.add(e.p1); pts.add(e.p2); }
      }
      const already = new Set(g.sk.constraints.filter((c) => c.type === 'fix').map((c) => c.refs[0]));
      const list = [...pts].filter((p) => !already.has(p));
      if (!list.length) return pts.size ? 'Already fixed' : 'Select points or entities to fix';
      return list.map((p) => C('fix', [p], { at: { ...g.P.get(p)! } }));
    }
    default:
      return 'Not available from the selection';
  }
}

// ------------------------------------------------------------ dimensions

export type DimKind = 'smart' | 'horizontal' | 'vertical';

const fmtValue = (v: number) => String(+v.toPrecision(6));

/** A driving dimension for the selection, valued at the current geometry. */
export function dimensionFromSelection(g: Geo, ids: string[], kind: DimKind = 'smart'): CadConstraint | string {
  const s = sortPicks(g, ids);
  const np = s.points.length, nl = s.lines.length, nr = s.rounds.length;
  const n = np + nl + nr;
  let c: CadConstraint | null = null;
  const name = nextDimName(g.sk);
  if (kind !== 'smart') {
    let pts = s.points;
    if (nl === 1 && n === 1) {
      const l = s.entities[0] as Extract<CadEntity, { type: 'line' }>;
      pts = [l.p1, l.p2];
    }
    if (pts.length !== 2 || (n !== 2 && !(nl === 1 && n === 1))) return 'Select two points, or a line';
    const t = kind === 'horizontal' ? 'distanceX' : 'distanceY';
    const ax = kind === 'horizontal' ? 'x' : 'y';
    const [a, b] = g.P.get(pts[0])![ax] <= g.P.get(pts[1])![ax] ? pts : [pts[1], pts[0]];
    c = C(t, [a, b], { name });
  } else if (nl === 1 && n === 1) c = C('length', [s.lines[0]], { name });
  else if (nr === 1 && n === 1) {
    const e = s.entities[0];
    c = C(e.type === 'circle' ? 'diameter' : 'radius', [e.id], { name });
  } else if (np === 2 && n === 2) c = C('distance', s.points, { name });
  else if (np === 1 && nl === 1 && n === 2) c = C('distance', [s.points[0], s.lines[0]], { name });
  else if (nl === 2 && n === 2) {
    const [l1, l2] = s.lines.map((id) => g.sk.entities.find((e) => e.id === id) as Extract<CadEntity, { type: 'line' }>);
    const u = sub(g.P.get(l1.p2)!, g.P.get(l1.p1)!), w = sub(g.P.get(l2.p2)!, g.P.get(l2.p1)!);
    const cross = (u.x * w.y - u.y * w.x) / (Math.hypot(u.x, u.y) * Math.hypot(w.x, w.y));
    c = Math.abs(cross) < 1e-6 ? C('distance', [l2.p1, l1.id], { name }) : C('angle', [l1.id, l2.id], { name });
  }
  if (!c) return 'Select a line, a circle/arc, two points, a point and a line, or two lines';
  const v = measure(g.sk, c, g.P, g.R);
  c.value = c.type === 'angle' ? fmtValue((v * 180) / Math.PI) : fmtValue(v);
  return c;
}

const sub = (a: Vec2, b: Vec2) => ({ x: a.x - b.x, y: a.y - b.y });

/**
 * Dimension values the editor can compute without the worksheet: numbers and
 * numbers with units. Expressions with worksheet variables fall back to the last
 * value the worksheet produced (`known`).
 */
export function localValues(sk: CadSketch, unit: string, known: Record<string, number> = {}): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of sk.constraints) {
    if (!isDimension(c.type) || c.driving === false) continue;
    try {
      const v = dimensionValue(math.evaluate(c.value?.trim() || '0'), unit, c.type === 'angle');
      if (Number.isFinite(v)) { out.set(c.id, v); continue; }
    } catch {
      /* uses worksheet variables */
    }
    if (Number.isFinite(known[c.id])) out.set(c.id, known[c.id]);
  }
  return out;
}

/** Plain numeric dimension text (as opposed to an expression with variables). */
export const isPlainNumber = (s: string | undefined) => !!s && /^\s*-?\d*\.?\d+(e[+-]?\d+)?\s*$/i.test(s);

/** The sketch with positions and radii from a solve. */
export function withSolution(sk: CadSketch, P: Map<string, Vec2> | Record<string, [number, number]>, R: Map<string, number> | Record<string, number>): CadSketch {
  const getP = (id: string): Vec2 | undefined => {
    if (P instanceof Map) return P.get(id);
    const v = P[id];
    return v ? { x: v[0], y: v[1] } : undefined;
  };
  const getR = (id: string) => (R instanceof Map ? R.get(id) : R[id]);
  return {
    ...sk,
    points: sk.points.map((p) => {
      const q = getP(p.id);
      return q ? { ...p, x: q.x, y: q.y } : p;
    }),
    entities: sk.entities.map((e) => {
      if (e.type !== 'circle') return e;
      const r = getR(e.id);
      return r !== undefined ? { ...e, r } : e;
    }),
  };
}

/** Solve with the values known locally; geometry stays as is if the solve fails. */
export function solveLocal(next: CadSketch, unit: string, known?: Record<string, number>): CadSketch {
  try {
    const sol = solveSketch(next, { values: localValues(next, unit, known), fast: true });
    return withSolution(next, sol.points, sol.radii);
  } catch {
    return next;
  }
}
