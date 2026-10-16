// Geometric constraint solver for CAD sketches.
//
// Unknowns are the point coordinates and circle radii. Every constraint contributes
// residual equations that are zero when it holds; the solver minimises their sum of
// squares with Levenberg–Marquardt. Identity damping makes the step the smallest
// change that satisfies the constraints, which is what a designer expects from an
// under-constrained sketch: geometry moves as little as possible.
//
// After solving, the rank of the Jacobian gives the remaining degrees of freedom,
// its null space tells which points are fully determined, and dependent rows show
// redundant constraints. Unsatisfiable constraints keep a residual and are reported
// as conflicting.
import type { CadConstraint, CadEntity, CadSketch, CadSpline } from './model';
import { entityPoints, hasRadius, isDimension } from './model';
import type { Vec2 } from './profile';
import { bsClosest, bsDomain, bsEval, ellipseDeriv, ellipseParam, ellipsePoint, ellipseRho, type BSpline, type Ellipse } from './curves';
import { splineOf } from './sketchCurves';

export interface SolveOptions {
  /** Driving dimension values, constraint id → sketch units (angles in radians). */
  values?: Map<string, number>;
  /** Points pulled to a position (dragging). */
  drag?: Map<string, Vec2>;
  /** Skip the freedom/redundancy analysis (dof, determined, redundant stay empty). */
  fast?: boolean;
  maxIterations?: number;
}

export interface SolveResult {
  points: Map<string, Vec2>;
  radii: Map<string, number>;
  /** All constraints satisfied. */
  ok: boolean;
  /** Remaining degrees of freedom of the whole sketch. */
  dof: number;
  /** Points whose position no longer has any freedom. */
  determined: Set<string>;
  /** Circles whose radius is determined. */
  determinedRadii: Set<string>;
  /** Constraints left unsatisfied. */
  conflicting: string[];
  /** Satisfied constraints that repeat what others already fix. */
  redundant: string[];
}

interface Sys {
  /** Variable index of each point's x (y is x + 1) and of each circle's radius (an ellipse's minor semi-axis). */
  px: Map<string, number>;
  rad: Map<string, number>;
  q: Float64Array;
  /** Variables of reference geometry, held where they are (projected from the model). */
  fixed: Set<number>;
  /**
   * Residual blocks: owner id, count, evaluator. Quiet blocks restate what the rows before
   * them already imply where the geometry meets smoothly (an offset arc's radius between
   * offset lines): they come last and are never the redundant ones.
   */
  blocks: { owner: string; count: number; f: (q: Float64Array, out: Float64Array, o: number) => void; vars: number[]; quiet?: boolean }[];
  scale: number;
}

const EPS = 1e-300;

function buildSystem(sk: CadSketch, opt: SolveOptions, includeDims = true): Sys {
  const px = new Map<string, number>();
  const rad = new Map<string, number>();
  const init: number[] = [];
  for (const p of sk.points) {
    px.set(p.id, init.length);
    init.push(p.x, p.y);
  }
  for (const e of sk.entities) {
    if (hasRadius(e)) {
      rad.set(e.id, init.length);
      init.push(Math.abs(e.r));
    }
  }
  // reference geometry does not move: its points and sizes are no unknowns
  const fixed = new Set<number>();
  for (const e of sk.entities) {
    if (!e.ref) continue;
    for (const id of entityPoints(e)) {
      const i = px.get(id);
      if (i !== undefined) fixed.add(i).add(i + 1);
    }
    const r = rad.get(e.id);
    if (r !== undefined) fixed.add(r);
  }
  let size = 1;
  for (const p of sk.points) size = Math.max(size, Math.abs(p.x), Math.abs(p.y));
  const L = size; // angular residuals are scaled to lengths
  const ents = new Map(sk.entities.map((e) => [e.id, e]));
  const blocks: Sys['blocks'] = [];
  const X = (id: string) => px.get(id)!;

  /** Line direction from its points (indices of p1.x and p2.x). */
  const lineOf = (id: string) => {
    const e = ents.get(id);
    if (!e || e.type !== 'line') throw new Error(`${id} is not a line`);
    return [X(e.p1), X(e.p2)] as const;
  };
  /** Centre index and radius accessor of a circle or arc. */
  const roundOf = (id: string) => {
    const e = ents.get(id);
    if (e?.type === 'circle') {
      const c = X(e.c), ri = rad.get(e.id)!;
      return { c, r: (q: Float64Array) => q[ri], vars: [c, c + 1, ri] };
    }
    if (e?.type === 'arc') {
      const c = X(e.c), a = X(e.p1);
      return { c, r: (q: Float64Array) => Math.hypot(q[a] - q[c], q[a + 1] - q[c + 1]), vars: [c, c + 1, a, a + 1] };
    }
    throw new Error(`${id} is not a circle or arc`);
  };
  const pv = (i: number) => [i, i + 1];
  const add = (owner: string, count: number, vars: number[], f: Sys['blocks'][number]['f'], quiet = false) => blocks.push({ owner, count, vars, f, ...(quiet ? { quiet } : {}) });
  /** Quiet blocks, added after every other constraint. */
  const later: (() => void)[] = [];
  const at = (q: Float64Array, i: number): Vec2 => ({ x: q[i], y: q[i + 1] });
  const pointsOf = (q: Float64Array) => (id: string) => {
    const i = px.get(id);
    return i === undefined ? undefined : at(q, i);
  };

  /** Direction of a line, or of an ellipse's first axis: indices of its two points. */
  const axisOf = (id: string) => {
    const e = ents.get(id);
    if (e?.type === 'line') return [X(e.p1), X(e.p2)] as const;
    if (e?.type === 'ellipse') return [X(e.c), X(e.a)] as const;
    throw new Error(`${id} is not a line`);
  };
  /** An ellipse's geometry from the variables. */
  const ellipseVars = (id: string) => {
    const e = ents.get(id);
    if (e?.type !== 'ellipse') throw new Error(`${id} is not an ellipse`);
    const c = X(e.c), a = X(e.a), ri = rad.get(e.id)!;
    const geo = (q: Float64Array): Ellipse => ({ c: at(q, c), ra: Math.hypot(q[a] - q[c], q[a + 1] - q[c + 1]), rb: Math.abs(q[ri]) || EPS, rot: Math.atan2(q[a + 1] - q[c + 1], q[a] - q[c]) });
    return { e, c, a, ri, geo, vars: [...pv(c), ...pv(a), ri] };
  };
  /** A spline's curve from the variables (its points and handles). */
  const splineVars = (id: string) => {
    const e = ents.get(id);
    if (e?.type !== 'spline') throw new Error(`${id} is not a spline`);
    const vars = entityPoints(e).flatMap((p) => pv(X(p)));
    return { e, vars, curve: (q: Float64Array): BSpline | null => splineOf(e, pointsOf(q)) };
  };

  function addConstraint(c: CadConstraint, v: number) {
    const [r0, r1, r2] = c.refs;
    switch (c.type) {
      case 'coincident': {
        const a = X(r0), b = X(r1);
        return add(c.id, 2, [...pv(a), ...pv(b)], (q, o, k) => { o[k] = q[a] - q[b]; o[k + 1] = q[a + 1] - q[b + 1]; });
      }
      case 'horizontal':
      case 'vertical': {
        const [a, b] = c.refs.length === 1 ? axisOf(r0) : [X(r0), X(r1)];
        const d = c.type === 'horizontal' ? 1 : 0;
        return add(c.id, 1, [...pv(a), ...pv(b)], (q, o, k) => { o[k] = q[a + d] - q[b + d]; });
      }
      case 'parallel':
      case 'perpendicular': {
        const [a1, b1] = axisOf(r0), [a2, b2] = axisOf(r1);
        const par = c.type === 'parallel';
        return add(c.id, 1, [...pv(a1), ...pv(b1), ...pv(a2), ...pv(b2)], (q, o, k) => {
          const ux = q[b1] - q[a1], uy = q[b1 + 1] - q[a1 + 1], vx = q[b2] - q[a2], vy = q[b2 + 1] - q[a2 + 1];
          const n = Math.hypot(ux, uy) * Math.hypot(vx, vy) + EPS;
          o[k] = (L * (par ? ux * vy - uy * vx : ux * vx + uy * vy)) / n;
        });
      }
      case 'equal': {
        const e0 = ents.get(r0), e1 = ents.get(r1);
        if (e0?.type === 'ellipse' && e1?.type === 'ellipse') {
          // both semi-axes; only the minor one when the first axes are one already (the pieces of
          // a broken arc) or mirror images of each other
          const twin = (p: string, q: string) => p === q || sk.constraints.some((k) => k.type === 'symmetric' && ((k.refs[0] === p && k.refs[1] === q) || (k.refs[0] === q && k.refs[1] === p)));
          const g0 = ellipseVars(r0), g1 = ellipseVars(r1), shared = twin(e0.c, e1.c) && twin(e0.a, e1.a);
          return add(c.id, shared ? 1 : 2, [...g0.vars, ...g1.vars], (q, o, k) => {
            const a = g0.geo(q), b = g1.geo(q);
            o[k] = a.rb - b.rb;
            if (!shared) o[k + 1] = a.ra - b.ra;
          });
        }
        if (e0?.type === 'line' && e1?.type === 'line') {
          const [a1, b1] = lineOf(r0), [a2, b2] = lineOf(r1);
          return add(c.id, 1, [...pv(a1), ...pv(b1), ...pv(a2), ...pv(b2)], (q, o, k) => {
            o[k] = Math.hypot(q[b1] - q[a1], q[b1 + 1] - q[a1 + 1]) - Math.hypot(q[b2] - q[a2], q[b2 + 1] - q[a2 + 1]);
          });
        }
        const g0 = roundOf(r0), g1 = roundOf(r1);
        return add(c.id, 1, [...g0.vars, ...g1.vars], (q, o, k) => { o[k] = g0.r(q) - g1.r(q); });
      }
      case 'fix': {
        const a = X(r0), at = c.at ?? { x: sk.points.find((p) => p.id === r0)!.x, y: sk.points.find((p) => p.id === r0)!.y };
        return add(c.id, 2, pv(a), (q, o, k) => { o[k] = q[a] - at.x; o[k + 1] = q[a + 1] - at.y; });
      }
      case 'pointOnLine': {
        const p = X(r0), [a, b] = lineOf(r1);
        return add(c.id, 1, [...pv(p), ...pv(a), ...pv(b)], (q, o, k) => {
          const dx = q[b] - q[a], dy = q[b + 1] - q[a + 1];
          o[k] = (dx * (q[p + 1] - q[a + 1]) - dy * (q[p] - q[a])) / (Math.hypot(dx, dy) + EPS);
        });
      }
      case 'pointOnCircle': {
        const p = X(r0), g = roundOf(r1);
        return add(c.id, 1, [...pv(p), ...g.vars], (q, o, k) => { o[k] = Math.hypot(q[p] - q[g.c], q[p + 1] - q[g.c + 1]) - g.r(q); });
      }
      case 'midpoint': {
        const p = X(r0), [a, b] = lineOf(r1);
        return add(c.id, 2, [...pv(p), ...pv(a), ...pv(b)], (q, o, k) => {
          o[k] = q[p] - (q[a] + q[b]) / 2;
          o[k + 1] = q[p + 1] - (q[a + 1] + q[b + 1]) / 2;
        });
      }
      case 'symmetric': {
        const p = X(r0), s = X(r1), [a, b] = lineOf(r2);
        return add(c.id, 2, [...pv(p), ...pv(s), ...pv(a), ...pv(b)], (q, o, k) => {
          const dx = q[b] - q[a], dy = q[b + 1] - q[a + 1], n = Math.hypot(dx, dy) + EPS;
          const mx = (q[p] + q[s]) / 2, my = (q[p + 1] + q[s + 1]) / 2;
          o[k] = (dx * (my - q[a + 1]) - dy * (mx - q[a])) / n;
          o[k + 1] = (dx * (q[s] - q[p]) + dy * (q[s + 1] - q[p + 1])) / n;
        });
      }
      case 'concentric': {
        const centre = (id: string) => {
          const e = ents.get(id);
          if (e?.type === 'ellipse') return X(e.c);
          return roundOf(id).c;
        };
        const c0 = centre(r0), c1 = centre(r1);
        return add(c.id, 2, [...pv(c0), ...pv(c1)], (q, o, k) => { o[k] = q[c0] - q[c1]; o[k + 1] = q[c0 + 1] - q[c1 + 1]; });
      }
      case 'collinear': {
        // the second line's ends on the first (an end they share is on it already: no row)
        const [a, b] = lineOf(r0), ends = lineOf(r1).filter((p) => p !== a && p !== b);
        return add(c.id, ends.length, [...pv(a), ...pv(b), ...ends.flatMap(pv)], (q, o, k) => {
          const dx = q[b] - q[a], dy = q[b + 1] - q[a + 1], n = Math.hypot(dx, dy) + EPS;
          ends.forEach((p, i) => { o[k + i] = (dx * (q[p + 1] - q[a + 1]) - dy * (q[p] - q[a])) / n; });
        });
      }
      case 'pointOnCurve': {
        const p = X(r0), e = ents.get(r1);
        if (e?.type === 'ellipse') {
          const g = ellipseVars(r1);
          return add(c.id, 1, [...pv(p), ...g.vars], (q, o, k) => {
            const el = g.geo(q);
            o[k] = (ellipseRho(el, at(q, p)) - 1) * el.rb;
          });
        }
        // a spline: the distance across it from the nearest point on it (signed, so smooth at 0)
        const g = splineVars(r1);
        return add(c.id, 1, [...pv(p), ...g.vars], (q, o, k) => {
          const cv = g.curve(q);
          if (!cv) return void (o[k] = 0);
          const pt = at(q, p), u = bsClosest(cv, pt);
          const [C, D] = bsEval(cv, u, 1);
          const n = Math.hypot(D.x, D.y) + EPS;
          o[k] = (D.x * (pt.y - C.y) - D.y * (pt.x - C.x)) / n;
        });
      }
      case 'curvature':
        return addCurvature(c);
      case 'tangent': {
        const e0 = ents.get(r0), e1 = ents.get(r1);
        if ([e0, e1].some((e) => e?.type === 'spline' || e?.type === 'ellipse')) return addSmooth(c);
        const lineFirst = e0?.type === 'line' ? [r0, r1] : e1?.type === 'line' ? [r1, r0] : null;
        // Joined at an end (fillets, slots): "distance to the line = radius" can never be exceeded
        // there, so it is stationary at the solution and its Jacobian row vanishes. State the
        // tangency at the joint instead: the radius to the shared point is perpendicular to the line
        // (two arcs: both centres in line with the joint).
        const ends = (e: CadEntity | undefined) => (e?.type === 'line' || e?.type === 'arc' ? [e.p1, e.p2] : []);
        const shared = ends(e0).find((p) => ends(e1).includes(p));
        if (shared !== undefined && lineFirst) {
          const [a, b] = lineOf(lineFirst[0]), g = roundOf(lineFirst[1]), j = X(shared);
          return add(c.id, 1, [...pv(a), ...pv(b), ...pv(j), ...g.vars], (q, o, k) => {
            const dx = q[b] - q[a], dy = q[b + 1] - q[a + 1], rx = q[j] - q[g.c], ry = q[j + 1] - q[g.c + 1];
            o[k] = (L * (dx * rx + dy * ry)) / (Math.hypot(dx, dy) * Math.hypot(rx, ry) + EPS);
          });
        }
        if (shared !== undefined) {
          const g0 = roundOf(r0), g1 = roundOf(r1), j = X(shared);
          return add(c.id, 1, [...pv(j), ...g0.vars, ...g1.vars], (q, o, k) => {
            const ax = q[j] - q[g0.c], ay = q[j + 1] - q[g0.c + 1], bx = q[j] - q[g1.c], by = q[j + 1] - q[g1.c + 1];
            o[k] = (L * (ax * by - ay * bx)) / (Math.hypot(ax, ay) * Math.hypot(bx, by) + EPS);
          });
        }
        if (lineFirst) {
          const [a, b] = lineOf(lineFirst[0]), g = roundOf(lineFirst[1]);
          return add(c.id, 1, [...pv(a), ...pv(b), ...g.vars], (q, o, k) => {
            const dx = q[b] - q[a], dy = q[b + 1] - q[a + 1];
            o[k] = Math.abs(dx * (q[g.c + 1] - q[a + 1]) - dy * (q[g.c] - q[a])) / (Math.hypot(dx, dy) + EPS) - g.r(q);
          });
        }
        const g0 = roundOf(r0), g1 = roundOf(r1);
        const inner = c.mode === 'int';
        return add(c.id, 1, [...g0.vars, ...g1.vars], (q, o, k) => {
          const d = Math.hypot(q[g0.c] - q[g1.c], q[g0.c + 1] - q[g1.c + 1]);
          o[k] = inner ? d - Math.abs(g0.r(q) - g1.r(q)) : d - (g0.r(q) + g1.r(q));
        });
      }
      case 'distance': {
        const e1 = ents.get(r1);
        if (e1?.type === 'line') {
          const p = X(r0), [a, b] = lineOf(r1);
          return add(c.id, 1, [...pv(p), ...pv(a), ...pv(b)], (q, o, k) => {
            const dx = q[b] - q[a], dy = q[b + 1] - q[a + 1];
            o[k] = Math.abs(dx * (q[p + 1] - q[a + 1]) - dy * (q[p] - q[a])) / (Math.hypot(dx, dy) + EPS) - v;
          });
        }
        const a = X(r0), b = X(r1);
        return add(c.id, 1, [...pv(a), ...pv(b)], (q, o, k) => { o[k] = Math.hypot(q[b] - q[a], q[b + 1] - q[a + 1]) - v; });
      }
      case 'distanceX':
      case 'distanceY': {
        const a = X(r0), b = X(r1), d = c.type === 'distanceX' ? 0 : 1;
        return add(c.id, 1, [...pv(a), ...pv(b)], (q, o, k) => { o[k] = q[b + d] - q[a + d] - v; });
      }
      case 'length': {
        const [a, b] = lineOf(r0);
        return add(c.id, 1, [...pv(a), ...pv(b)], (q, o, k) => { o[k] = Math.hypot(q[b] - q[a], q[b + 1] - q[a + 1]) - v; });
      }
      case 'radius':
      case 'diameter': {
        const g = roundOf(r0), m = c.type === 'diameter' ? 2 : 1;
        return add(c.id, 1, g.vars, (q, o, k) => { o[k] = m * g.r(q) - v; });
      }
      case 'majorRadius':
      case 'minorRadius': {
        const g = ellipseVars(r0), major = c.type === 'majorRadius';
        return add(c.id, 1, g.vars, (q, o, k) => {
          const el = g.geo(q);
          o[k] = (major ? el.ra : el.rb) - v;
        });
      }
      case 'offset':
        return addOffset(c, v);
      case 'pattern':
        return addPattern(c, v);
      case 'angle': {
        // sin(θ − v) = 0 with θ the CCW angle from the first line (or the x axis) to the second
        const [a2, b2] = axisOf(c.refs.length === 1 ? r0 : r1);
        const first = c.refs.length === 1 ? null : axisOf(r0);
        const cv = Math.cos(v), sv = Math.sin(v);
        const vars = first ? [...pv(first[0]), ...pv(first[1]), ...pv(a2), ...pv(b2)] : [...pv(a2), ...pv(b2)];
        return add(c.id, 1, vars, (q, o, k) => {
          const ux = first ? q[first[1]] - q[first[0]] : 1, uy = first ? q[first[1] + 1] - q[first[0] + 1] : 0;
          const wx = q[b2] - q[a2], wy = q[b2 + 1] - q[a2 + 1];
          const n = Math.hypot(ux, uy) * Math.hypot(wx, wy) + EPS;
          const cr = (ux * wy - uy * wx) / n, dt = (ux * wx + uy * wy) / n;
          o[k] = L * (cr * cv - dt * sv);
        });
      }
    }
  }

  // ------------------------------------------------ tangency and curvature with splines and ellipses

  /** Which end of a spline a constraint means: stored, or the end it shares with the other curve. */
  const splineEnd = (c: CadConstraint, i: number, sp: CadSpline): number => {
    const stored = c.ends?.[i];
    if (stored === 0 || stored === 1) return stored;
    const other = ents.get(c.refs[1 - i]);
    const pts = other ? entityPoints(other) : [];
    return pts.includes(sp.pts[sp.pts.length - 1]) && !pts.includes(sp.pts[0]) ? 1 : 0;
  };
  /** What tangency and curvature need of a curve at a point j: its direction there and its curvature vector. */
  type Local = { vars: number[]; joint?: (q: Float64Array) => Vec2; dir: (q: Float64Array, j: Vec2) => Vec2; curv: (q: Float64Array, j: Vec2) => Vec2 };
  const localOf = (c: CadConstraint, i: number): Local => {
    const id = c.refs[i], e = ents.get(id);
    if (e?.type === 'line') {
      const a = X(e.p1), b = X(e.p2);
      return { vars: [...pv(a), ...pv(b)], dir: (q) => ({ x: q[b] - q[a], y: q[b + 1] - q[a + 1] }), curv: () => ({ x: 0, y: 0 }) };
    }
    if (e?.type === 'circle' || e?.type === 'arc') {
      const g = roundOf(id);
      return {
        vars: g.vars,
        dir: (q, j) => ({ x: -(j.y - q[g.c + 1]), y: j.x - q[g.c] }),
        curv: (q, j) => {
          const r = g.r(q) || EPS;
          return { x: (q[g.c] - j.x) / (r * r), y: (q[g.c + 1] - j.y) / (r * r) };
        },
      };
    }
    if (e?.type === 'ellipse') {
      const g = ellipseVars(id);
      return {
        vars: g.vars,
        dir: (q, j) => {
          const el = g.geo(q);
          return ellipseDeriv(el, ellipseParam(el, j));
        },
        curv: (q, j) => {
          const el = g.geo(q), t = ellipseParam(el, j), p = ellipsePoint(el, t);
          // C″ = −(C − c) for C(t) = c + ra cos t·u + rb sin t·v
          return curvatureVector(ellipseDeriv(el, t), { x: el.c.x - p.x, y: el.c.y - p.y });
        },
      };
    }
    if (e?.type === 'spline') {
      const g = splineVars(id), end = splineEnd(c, i, e);
      const pid = X(end ? e.pts[e.pts.length - 1] : e.pts[0]);
      const hid = end ? e.h2 : e.h1;
      const h = hid ? X(hid) : -1;
      const deriv = (q: Float64Array, nd: number) => {
        const cv = g.curve(q);
        if (!cv) return null;
        const [u0, u1] = bsDomain(cv);
        return bsEval(cv, end ? u1 : u0, nd);
      };
      return {
        vars: g.vars,
        joint: (q) => at(q, pid),
        // a handle gives the direction directly; else the end of the interpolated curve
        dir: (q) => (h >= 0 ? (end ? { x: q[pid] - q[h], y: q[pid + 1] - q[h + 1] } : { x: q[h] - q[pid], y: q[h + 1] - q[pid + 1] }) : deriv(q, 1)?.[1] ?? { x: 1, y: 0 }),
        curv: (q) => {
          const d = deriv(q, 2);
          return d ? curvatureVector(d[1], d[2]) : { x: 0, y: 0 };
        },
      };
    }
    throw new Error(`${id} cannot be tangent`);
  };
  /** The point both curves meet at: a spline's end, else a point they share. */
  const jointOf = (c: CadConstraint, a: Local, b: Local): ((q: Float64Array) => Vec2) | null => {
    if (a.joint) return a.joint;
    if (b.joint) return b.joint;
    const e0 = ents.get(c.refs[0]), e1 = ents.get(c.refs[1]);
    const ends = (e: CadEntity | undefined) => (e?.type === 'line' || e?.type === 'arc' ? [e.p1, e.p2] : e?.type === 'ellipse' && e.p1 && e.p2 ? [e.p1, e.p2] : []);
    const shared = ends(e0).find((p) => ends(e1).includes(p));
    if (shared === undefined) return null;
    const j = X(shared);
    return (q) => at(q, j);
  };
  function addSmooth(c: CadConstraint) {
    const a = localOf(c, 0), b = localOf(c, 1);
    const joint = jointOf(c, a, b);
    if (joint) {
      return add(c.id, 1, [...a.vars, ...b.vars], (q, o, k) => {
        const j = joint(q), d1 = a.dir(q, j), d2 = b.dir(q, j);
        o[k] = (L * (d1.x * d2.y - d1.y * d2.x)) / (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y) + EPS);
      });
    }
    // a line and an ellipse anywhere: in the ellipse's frame the line n·x = d touches it when d² = ra²nx² + rb²ny²
    const [li, ei] = ents.get(c.refs[0])?.type === 'line' ? [0, 1] : [1, 0];
    if (ents.get(c.refs[li])?.type !== 'line' || ents.get(c.refs[ei])?.type !== 'ellipse') throw new Error('tangent needs a shared point');
    const [p1, p2] = lineOf(c.refs[li]), g = ellipseVars(c.refs[ei]);
    return add(c.id, 1, [...pv(p1), ...pv(p2), ...g.vars], (q, o, k) => {
      const el = g.geo(q), cr = Math.cos(el.rot), sr = Math.sin(el.rot);
      const dx = q[p2] - q[p1], dy = q[p2 + 1] - q[p1 + 1], l = Math.hypot(dx, dy) + EPS;
      const nx = -dy / l, ny = dx / l;
      const d = nx * (q[p1] - el.c.x) + ny * (q[p1 + 1] - el.c.y);
      const nu = nx * cr + ny * sr, nv = -nx * sr + ny * cr;
      o[k] = Math.abs(d) - Math.hypot(el.ra * nu, el.rb * nv);
    });
  }
  function addCurvature(c: CadConstraint) {
    const a = localOf(c, 0), b = localOf(c, 1);
    const joint = jointOf(c, a, b);
    if (!joint) throw new Error('curvature needs a spline end');
    return add(c.id, 1, [...a.vars, ...b.vars], (q, o, k) => {
      const j = joint(q), d = a.dir(q, j), l = Math.hypot(d.x, d.y) + EPS;
      const n = { x: -d.y / l, y: d.x / l };
      const ka = a.curv(q, j), kb = b.curv(q, j);
      o[k] = L * L * ((ka.x - kb.x) * n.x + (ka.y - kb.y) * n.y);
    });
  }

  // ------------------------------------------------ offsets and patterns

  /** Each copy the offset of its source by v: lines parallel at v, arcs and circles round the same centre v further out (or in). */
  function addOffset(c: CadConstraint, v: number) {
    for (let i = 0; i + 1 < c.refs.length; i += 2) {
      const src = ents.get(c.refs[i]), dst = ents.get(c.refs[i + 1]), side = c.sides?.[i / 2] ?? 1;
      if (src?.type === 'line' && dst?.type === 'line') {
        const a = X(src.p1), b = X(src.p2), p = X(dst.p1), r = X(dst.p2);
        add(c.id, 2, [...pv(a), ...pv(b), ...pv(p), ...pv(r)], (q, o, k) => {
          const ux = q[b] - q[a], uy = q[b + 1] - q[a + 1], vx = q[r] - q[p], vy = q[r + 1] - q[p + 1];
          const lu = Math.hypot(ux, uy) + EPS;
          o[k] = (L * (ux * vy - uy * vx)) / (lu * (Math.hypot(vx, vy) + EPS));
          o[k + 1] = (ux * (q[p + 1] - q[a + 1]) - uy * (q[p] - q[a])) / lu - side * v;
        });
      } else if ((src?.type === 'arc' || src?.type === 'circle') && (dst?.type === 'arc' || dst?.type === 'circle')) {
        const g0 = roundOf(src.id), g1 = roundOf(dst.id);
        const shared = g0.c === g1.c;
        const rows = () => add(c.id, shared ? 1 : 3, [...g0.vars, ...g1.vars], (q, o, k) => {
          o[k] = g1.r(q) - g0.r(q) - side * v;
          if (!shared) {
            o[k + 1] = q[g1.c] - q[g0.c];
            o[k + 2] = q[g1.c + 1] - q[g0.c + 1];
          }
        }, dst.type === 'arc');
        // an arc joined smoothly to offset lines (a slot) already has its radius from them
        if (dst.type === 'arc') later.push(rows);
        else rows();
      }
    }
  }
  /** Every copy's points where the pattern's move (k · spacing, or k turns of its step) puts the source's. */
  function addPattern(c: CadConstraint, v: number) {
    const pt = c.pattern;
    if (!pt || pt.n < 1) return;
    const src = c.refs.slice(0, pt.n).map(X);
    const along = pt.along ? lineOf(pt.along) : null;
    const about = pt.about ? X(pt.about) : -1;
    if (pt.kind === 'circ' && about < 0) throw new Error('a circular pattern needs its centre');
    // a whole turn either way spreads the copies evenly (the last does not land on the source)
    const full = Math.abs(Math.abs(v) - 2 * Math.PI) < 1e-9;
    const step = pt.kind === 'circ' ? v / (full ? pt.count : Math.max(1, pt.count - 1)) : v;
    for (let k = 1; k < pt.count; k++) {
      const dst = c.refs.slice(k * pt.n, (k + 1) * pt.n).map(X);
      if (dst.length < pt.n) break;
      const vars = [...src.flatMap(pv), ...dst.flatMap(pv), ...(along ? [...pv(along[0]), ...pv(along[1])] : []), ...(about >= 0 ? pv(about) : [])];
      const ca = Math.cos(k * step), sa = Math.sin(k * step);
      add(c.id, 2 * pt.n, vars, (q, o, o0) => {
        let ux = pt.dir === 'y' ? 0 : 1, uy = pt.dir === 'y' ? 1 : 0;
        if (along) {
          const dx = q[along[1]] - q[along[0]], dy = q[along[1] + 1] - q[along[0] + 1], l = Math.hypot(dx, dy) + EPS;
          ux = dx / l;
          uy = dy / l;
        }
        for (let i = 0; i < pt.n; i++) {
          const s0 = src[i], d0 = dst[i];
          let x: number, y: number;
          if (pt.kind === 'rect') {
            x = q[s0] + k * step * ux;
            y = q[s0 + 1] + k * step * uy;
          } else {
            const rx = q[s0] - q[about], ry = q[s0 + 1] - q[about + 1];
            x = q[about] + rx * ca - ry * sa;
            y = q[about + 1] + rx * sa + ry * ca;
          }
          o[o0 + 2 * i] = q[d0] - x;
          o[o0 + 2 * i + 1] = q[d0 + 1] - y;
        }
      });
    }
  }
  // (after the helpers above: they are consts)
  for (const c of sk.constraints) {
    if (isDimension(c.type) && (!includeDims || c.driving === false)) continue;
    const v = opt.values?.get(c.id) ?? NaN;
    if (isDimension(c.type) && !Number.isFinite(v)) continue; // unresolved value: reported by the caller
    try {
      addConstraint(c, v);
    } catch {
      /* a constraint whose references are gone is ignored */
    }
  }

  for (const f of later) f();

  // arcs keep both ends on the circle, elliptical arcs on the ellipse: after the constraints, so a
  // constraint that implies them (an offset's corner arc, a mirror image) is not the one the
  // analysis calls redundant
  for (const e of sk.entities) {
    if (e.type === 'arc') {
      const c = X(e.c), a = X(e.p1), b = X(e.p2);
      add(e.id, 1, [...pv(c), ...pv(a), ...pv(b)], (q, o, k) => {
        o[k] = Math.hypot(q[b] - q[c], q[b + 1] - q[c + 1]) - Math.hypot(q[a] - q[c], q[a + 1] - q[c + 1]);
      });
    } else if (e.type === 'ellipse' && e.p1 && e.p2) {
      const g = ellipseVars(e.id), a = X(e.p1), b = X(e.p2);
      add(e.id, 2, [...g.vars, ...pv(a), ...pv(b)], (q, o, k) => {
        const el = g.geo(q);
        o[k] = (ellipseRho(el, at(q, a)) - 1) * el.rb;
        o[k + 1] = (ellipseRho(el, at(q, b)) - 1) * el.rb;
      });
    }
  }

  return { px, rad, q: Float64Array.from(init), fixed, blocks, scale: L };
}

/** Curvature vector (towards the centre of curvature, length 1/ρ) from the first and second derivative. */
function curvatureVector(d1: Vec2, d2: Vec2): Vec2 {
  const s2 = d1.x * d1.x + d1.y * d1.y;
  if (!(s2 > 0)) return { x: 0, y: 0 };
  const t = (d2.x * d1.x + d2.y * d1.y) / s2;
  return { x: (d2.x - t * d1.x) / s2, y: (d2.y - t * d1.y) / s2 };
}

// ------------------------------------------------------------ linear algebra

/** Solve (A + λI) x = b for symmetric positive (semi)definite A by Cholesky; null if not positive. */
function cholSolve(A: Float64Array, n: number, lambda: number, b: Float64Array): Float64Array | null {
  const Lm = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j] + (i === j ? lambda : 0);
      for (let k = 0; k < j; k++) s -= Lm[i * n + k] * Lm[j * n + k];
      if (i === j) {
        if (!(s > 0)) return null;
        Lm[i * n + i] = Math.sqrt(s);
      } else Lm[i * n + j] = s / Lm[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= Lm[i * n + k] * y[k];
    y[i] = s / Lm[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= Lm[k * n + i] * x[k];
    x[i] = s / Lm[i * n + i];
  }
  return x;
}

// ------------------------------------------------------------ solving

interface Component {
  vars: number[]; // global variable indices
  blocks: Sys['blocks'];
  m: number;
}

/** Independent groups of variables and the constraints that tie them together. */
function components(sys: Sys, frozen: Set<number>): Component[] {
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(i, r);
    return r;
  };
  for (const b of sys.blocks) {
    const free = b.vars.filter((v) => !frozen.has(v));
    for (const v of free) if (!parent.has(v)) parent.set(v, v);
    for (let i = 1; i < free.length; i++) parent.set(find(free[i]), find(free[0]));
  }
  const groups = new Map<number, Component>();
  for (const b of sys.blocks) {
    const free = b.vars.filter((v) => !frozen.has(v));
    if (!free.length) {
      // a constraint on frozen geometry only: still evaluated for conflicts
      const key = -1;
      if (!groups.has(key)) groups.set(key, { vars: [], blocks: [], m: 0 });
      groups.get(key)!.blocks.push(b);
      groups.get(key)!.m += b.count;
      continue;
    }
    const key = find(free[0]);
    if (!groups.has(key)) groups.set(key, { vars: [], blocks: [], m: 0 });
    const g = groups.get(key)!;
    g.blocks.push(b);
    g.m += b.count;
  }
  for (const v of parent.keys()) groups.get(find(v))?.vars.push(v);
  for (const g of groups.values()) g.vars.sort((a, b) => a - b);
  return [...groups.values()];
}

function evalBlocks(blocks: Sys['blocks'], q: Float64Array, out: Float64Array) {
  let k = 0;
  for (const b of blocks) {
    b.f(q, out, k);
    k += b.count;
  }
}

interface SparseRow {
  idx: number[]; // local variable indices
  val: number[];
}

/**
 * Jacobian rows by central differences, block by block: a constraint only depends
 * on a handful of variables, so this costs O(constraints) instead of O(n · m).
 */
function jacobianRows(c: Component, q: Float64Array, h: number): SparseRow[] {
  const local = new Map(c.vars.map((v, i) => [v, i]));
  const rows: SparseRow[] = [];
  for (const b of c.blocks) {
    const vars = [...new Set(b.vars)].filter((v) => local.has(v));
    const fp = new Float64Array(b.count), fm = new Float64Array(b.count);
    const start = rows.length;
    for (let j = 0; j < b.count; j++) rows.push({ idx: [], val: [] });
    for (const v of vars) {
      const keep = q[v];
      q[v] = keep + h;
      b.f(q, fp, 0);
      q[v] = keep - h;
      b.f(q, fm, 0);
      q[v] = keep;
      for (let j = 0; j < b.count; j++) {
        const d = (fp[j] - fm[j]) / (2 * h);
        if (d !== 0) {
          rows[start + j].idx.push(local.get(v)!);
          rows[start + j].val.push(d);
        }
      }
    }
  }
  return rows;
}

/** Dense m × n Jacobian (for the rank analysis). */
function jacobian(c: Component, q: Float64Array, h: number): Float64Array {
  const n = c.vars.length;
  const J = new Float64Array(c.m * n);
  jacobianRows(c, q, h).forEach((r, i) => r.idx.forEach((j, k) => (J[i * n + j] = r.val[k])));
  return J;
}

function norm2(f: Float64Array) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return s;
}

/** Levenberg–Marquardt on one component. Returns the final residual vector. */
function solveComponent(c: Component, q: Float64Array, scale: number, maxIt: number, soft?: (q: Float64Array) => void): Float64Array {
  const n = c.vars.length, m = c.m;
  const f = new Float64Array(m);
  evalBlocks(c.blocks, q, f);
  if (!n || !m) return f;
  const tol = 1e-13 * scale;
  const h = 1e-7 * scale;
  let lambda = 1e-6;
  let cost = norm2(f);
  const trial = new Float64Array(q.length);
  const ft = new Float64Array(m);
  for (let it = 0; it < maxIt; it++) {
    let worst = 0;
    for (let i = 0; i < m; i++) worst = Math.max(worst, Math.abs(f[i]));
    if (worst < tol) break;
    const rows = jacobianRows(c, q, h);
    const A = new Float64Array(n * n), g = new Float64Array(n);
    rows.forEach((r, i) => {
      for (let x = 0; x < r.idx.length; x++) {
        const a = r.idx[x], ja = r.val[x];
        g[a] -= ja * f[i];
        for (let y = 0; y < r.idx.length; y++) A[a * n + r.idx[y]] += ja * r.val[y];
      }
    });
    let maxDiag = 0;
    for (let a = 0; a < n; a++) maxDiag = Math.max(maxDiag, A[a * n + a]);
    let accepted = false;
    let stalled = false;
    const tries0 = nearlyDone(f, scale) ? 11 : 0;
    for (let tries = tries0; tries < 12; tries++) {
      const step = cholSolve(A, n, lambda * Math.max(maxDiag, 1e-12) + 1e-14, g);
      if (step) {
        trial.set(q);
        for (let a = 0; a < n; a++) trial[c.vars[a]] += step[a];
        soft?.(trial);
        evalBlocks(c.blocks, trial, ft);
        const ct = norm2(ft);
        if (ct < cost) {
          q.set(trial);
          f.set(ft);
          // a least-squares compromise (dragging out of reach) stops when it stalls
          stalled = cost - ct < 1e-10 * cost;
          cost = ct;
          lambda = Math.max(lambda / 4, 1e-12);
          accepted = true;
          break;
        }
      }
      lambda *= 8;
    }
    if (!accepted || stalled) break;
  }
  return f;
}

/** Converged to rounding: a further step cannot be told apart from noise. */
function nearlyDone(f: Float64Array, scale: number) {
  let worst = 0;
  for (let i = 0; i < f.length; i++) worst = Math.max(worst, Math.abs(f[i]));
  return worst < 1e-9 * scale;
}

// ------------------------------------------------------------ analysis

interface Analysis {
  rank: number;
  /** Component variables (local index) with no remaining freedom. */
  determined: boolean[];
  /** Residual row indices that depend on earlier rows. */
  dependentRows: number[];
}

function analyse(J: Float64Array, m: number, n: number): Analysis {
  let maxAbs = 0;
  for (let i = 0; i < J.length; i++) maxAbs = Math.max(maxAbs, Math.abs(J[i]));
  const tol = 1e-7 * Math.max(maxAbs, 1e-300);

  // dependent rows, in constraint order (Gram–Schmidt on the rows)
  const basis: Float64Array[] = [];
  const dependentRows: number[] = [];
  for (let i = 0; i < m; i++) {
    const r = J.slice(i * n, i * n + n);
    for (let pass = 0; pass < 2; pass++) {
      for (const b of basis) {
        let d = 0;
        for (let k = 0; k < n; k++) d += r[k] * b[k];
        for (let k = 0; k < n; k++) r[k] -= d * b[k];
      }
    }
    let len = 0;
    for (let k = 0; k < n; k++) len += r[k] * r[k];
    len = Math.sqrt(len);
    if (len < tol) dependentRows.push(i);
    else basis.push(r.map((x) => x / len));
  }
  const rank = basis.length;

  // a variable is determined when every null-space vector has a zero there:
  // project each unit vector eᵢ onto the row space; eᵢ in the row space ⇔ determined
  const determined = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const b of basis) s += b[i] * b[i];
    determined[i] = s > 1 - 1e-6;
  }
  return { rank, determined, dependentRows };
}

// ------------------------------------------------------------ public API

export function solveSketch(sk: CadSketch, opt: SolveOptions = {}): SolveResult {
  const sys = buildSystem(sk, opt);
  const q = sys.q;
  const maxIt = opt.maxIterations ?? 100;
  const frozen = new Set<number>(sys.fixed);

  // dragging: hold the dragged points where the pointer is, if the constraints allow it
  if (opt.drag?.size) {
    const held = new Map<number, Vec2>();
    for (const [id, p] of opt.drag) {
      const i = sys.px.get(id);
      if (i === undefined || sys.fixed.has(i)) continue;
      held.set(i, p);
      q[i] = p.x;
      q[i + 1] = p.y;
      frozen.add(i).add(i + 1);
    }
    const before = Float64Array.from(q);
    let fine = true;
    for (const c of components(sys, frozen)) {
      const f = solveComponent(c, q, sys.scale, maxIt);
      if (f.some((x) => Math.abs(x) > 1e-7 * sys.scale)) fine = false;
    }
    if (!fine) {
      // the pointer is somewhere the point cannot go: pull towards it with a weak spring,
      // so the point ends as close to the pointer as the constraints allow
      q.set(before);
      frozen.clear();
      for (const i of sys.fixed) frozen.add(i);
      const hard = sys.blocks.length;
      const w = 1e-2;
      for (const [i, p] of held) {
        sys.blocks.push({ owner: '', count: 2, vars: [i, i + 1], f: (qq, o, k) => { o[k] = w * (qq[i] - p.x); o[k + 1] = w * (qq[i + 1] - p.y); } });
      }
      for (const c of components(sys, frozen)) solveComponent(c, q, sys.scale, maxIt * 2);
      sys.blocks.length = hard;
    }
  }
  frozen.clear();
  for (const i of sys.fixed) frozen.add(i);
  const comps = components(sys, frozen);
  const resid: { c: Component; f: Float64Array }[] = [];
  for (const c of comps) resid.push({ c, f: solveComponent(c, q, sys.scale, maxIt) });

  // results
  const points = new Map<string, Vec2>();
  for (const [id, i] of sys.px) points.set(id, { x: q[i], y: q[i + 1] });
  const radii = new Map<string, number>();
  for (const [id, i] of sys.rad) radii.set(id, Math.abs(q[i]));

  const tolF = 1e-7 * sys.scale;
  const conflicting = new Set<string>();
  const redundant = new Set<string>();
  const detVar = new Set<number>();
  let rankTotal = 0;
  for (const { c, f } of resid) {
    let k = 0;
    const rowOwner: string[] = [];
    for (const b of c.blocks) {
      for (let j = 0; j < b.count; j++) {
        rowOwner.push(b.quiet ? '' : b.owner);
        if (Math.abs(f[k + j]) > tolF) conflicting.add(b.owner);
      }
      k += b.count;
    }
    if (!c.vars.length || opt.fast) continue;
    const J = jacobian(c, q, 1e-7 * sys.scale);
    const an = analyse(J, c.m, c.vars.length);
    rankTotal += an.rank;
    an.determined.forEach((d, i) => d && detVar.add(c.vars[i]));
    for (const row of an.dependentRows) if (rowOwner[row] && !conflicting.has(rowOwner[row])) redundant.add(rowOwner[row]);
  }
  // reference geometry is fully determined (it does not move at all)
  for (const i of sys.fixed) detVar.add(i);
  const arcIds = new Set(sk.entities.filter((e) => e.type === 'arc' || e.type === 'ellipse').map((e) => e.id));
  const determined = new Set<string>();
  for (const [id, i] of sys.px) if (detVar.has(i) && detVar.has(i + 1)) determined.add(id);
  const determinedRadii = new Set<string>();
  for (const [id, i] of sys.rad) if (detVar.has(i)) determinedRadii.add(id);
  return {
    points, radii,
    ok: conflicting.size === 0,
    dof: q.length - sys.fixed.size - rankTotal,
    determined, determinedRadii,
    conflicting: [...conflicting].filter((id) => !arcIds.has(id)),
    redundant: [...redundant].filter((id) => !arcIds.has(id)),
  };
}

// ------------------------------------------------------------ measuring

/** Current value of a dimension in sketch units (angles in radians), from solved positions. */
export function measure(sk: CadSketch, c: CadConstraint, P: Map<string, Vec2>, R?: Map<string, number>): number {
  const ents = new Map(sk.entities.map((e) => [e.id, e]));
  const pt = (id: string) => P.get(id)!;
  const line = (id: string) => {
    const e = ents.get(id)!;
    // an ellipse's first axis measures like a line (angles to it)
    if (e.type === 'ellipse') return [pt(e.c), pt(e.a)] as const;
    const l = e as Extract<CadEntity, { type: 'line' }>;
    return [pt(l.p1), pt(l.p2)] as const;
  };
  const radius = (id: string) => {
    const e = ents.get(id)!;
    if (e.type === 'circle') return R?.get(e.id) ?? Math.abs(e.r);
    if (e.type === 'arc') return Math.hypot(pt(e.p1).x - pt(e.c).x, pt(e.p1).y - pt(e.c).y);
    return NaN;
  };
  const [r0, r1] = c.refs;
  switch (c.type) {
    case 'distance': {
      if (ents.get(r1)?.type === 'line') {
        const p = pt(r0), [a, b] = line(r1);
        return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
      }
      return Math.hypot(pt(r1).x - pt(r0).x, pt(r1).y - pt(r0).y);
    }
    case 'distanceX': return pt(r1).x - pt(r0).x;
    case 'distanceY': return pt(r1).y - pt(r0).y;
    case 'length': {
      const [a, b] = line(r0);
      return Math.hypot(b.x - a.x, b.y - a.y);
    }
    case 'radius': return radius(r0);
    case 'diameter': return 2 * radius(r0);
    case 'majorRadius':
    case 'minorRadius': {
      const e = ents.get(r0);
      if (e?.type !== 'ellipse') return NaN;
      return c.type === 'majorRadius' ? Math.hypot(pt(e.a).x - pt(e.c).x, pt(e.a).y - pt(e.c).y) : R?.get(e.id) ?? Math.abs(e.r);
    }
    case 'offset': {
      const src = ents.get(r0), dst = ents.get(r1), side = c.sides?.[0] ?? 1;
      if (src?.type === 'line' && dst?.type === 'line') {
        const [a, b] = line(r0), p = pt(dst.p1);
        return (side * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))) / Math.hypot(b.x - a.x, b.y - a.y);
      }
      return src && dst ? side * (radius(dst.id) - radius(src.id)) : NaN;
    }
    case 'pattern': {
      const pt0 = c.pattern;
      if (!pt0 || c.refs.length < 2 * pt0.n) return NaN;
      const a = pt(c.refs[0]), b = pt(c.refs[pt0.n]);
      if (pt0.kind === 'circ') {
        const o = pt(pt0.about!);
        // the turn from the source to the first copy, clockwise negative
        const step = Math.atan2((a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x), (a.x - o.x) * (b.x - o.x) + (a.y - o.y) * (b.y - o.y));
        const full = Math.abs(Math.abs(step * pt0.count) - 2 * Math.PI) < 1e-6;
        return step * (full ? pt0.count : pt0.count - 1);
      }
      let u = pt0.dir === 'y' ? { x: 0, y: 1 } : { x: 1, y: 0 };
      if (pt0.along) {
        const [p, q] = line(pt0.along), l = Math.hypot(q.x - p.x, q.y - p.y);
        u = { x: (q.x - p.x) / l, y: (q.y - p.y) / l };
      }
      return (b.x - a.x) * u.x + (b.y - a.y) * u.y;
    }
    case 'angle': {
      const [a2, b2] = line(c.refs.length === 1 ? r0 : r1);
      const u = c.refs.length === 1 ? { x: 1, y: 0 } : (() => { const [a, b] = line(r0); return { x: b.x - a.x, y: b.y - a.y }; })();
      const w = { x: b2.x - a2.x, y: b2.y - a2.y };
      let th = Math.atan2(u.x * w.y - u.y * w.x, u.x * w.x + u.y * w.y);
      // lines have no direction: report 0 ≤ θ < 180°
      if (th < 0) th += Math.PI;
      if (th >= Math.PI - 1e-12) th -= Math.PI;
      return th;
    }
    default: return NaN;
  }
}

/** Which constraints a point or entity takes part in (for highlighting). */
export function constraintsOf(sk: CadSketch, id: string): CadConstraint[] {
  return sk.constraints.filter((c) => c.refs.includes(id));
}
