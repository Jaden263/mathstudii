// SVG drawing of a CAD sketch: geometry coloured by how constrained it is, the
// closed profile, dimensions with extension lines, and constraint glyphs.
import type { CadConstraint, CadEntity, CadView } from '../../cad/model';
import { isAngleDim, isDimension } from '../../cad/model';
import type { Geo } from '../../cad/edit';
import { GLYPH, entityRadius, isPlainNumber, segsOf } from '../../cad/edit';
import { loopPolygon, segPoint, segPolyline, type ProfileRegion, type Vec2 } from '../../cad/profile';

export interface Vp {
  view: CadView;
  width: number;
  height: number;
}

export const toS = (vp: Vp, p: Vec2): Vec2 => ({ x: (p.x - vp.view.cx) * vp.view.zoom + vp.width / 2, y: vp.height / 2 - (p.y - vp.view.cy) * vp.view.zoom });
export const toW = (vp: Vp, sx: number, sy: number): Vec2 => ({ x: (sx - vp.width / 2) / vp.view.zoom + vp.view.cx, y: (vp.height / 2 - sy) / vp.view.zoom + vp.view.cy });

export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '?';
  const a = Math.abs(v);
  const s = a >= 1000 ? v.toFixed(1) : a >= 100 ? v.toFixed(2) : a >= 1 ? v.toFixed(3) : v.toPrecision(3);
  return String(+s);
}

const f = (n: number) => n.toFixed(2);

export interface EntityState {
  selected: boolean;
  determined: boolean;
  bad: boolean;
  hover: boolean;
}

export function entityPath(g: Geo, e: CadEntity, vp: Vp): string {
  const S = (id: string) => toS(vp, g.P.get(id)!);
  switch (e.type) {
    case 'line': {
      const a = S(e.p1), b = S(e.p2);
      return `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`;
    }
    case 'circle': {
      const c = S(e.c), r = entityRadius(g, e) * vp.view.zoom;
      return `M${f(c.x - r)} ${f(c.y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0`;
    }
    case 'arc': {
      const c = g.P.get(e.c)!, a = g.P.get(e.p1)!, b = g.P.get(e.p2)!;
      const r = entityRadius(g, e);
      const a0 = Math.atan2(a.y - c.y, a.x - c.x);
      let a1 = Math.atan2(b.y - c.y, b.x - c.x);
      while (a1 <= a0) a1 += 2 * Math.PI;
      const sa = toS(vp, a);
      const end = toS(vp, { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) });
      const R = r * vp.view.zoom;
      // world CCW is screen clockwise (y flips): sweep flag 0
      return `M${f(sa.x)} ${f(sa.y)}A${f(R)} ${f(R)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 0 ${f(end.x)} ${f(end.y)}`;
    }
    case 'point':
      return '';
    default: {
      // splines, ellipses and text: through their curve (text loop by loop)
      const z = vp.view.zoom;
      return segsOf(g, e).map((sg) => {
        const pts = segPolyline(sg, Math.min(Math.PI / 60, Math.max(Math.PI / 720, 2 / (z * 20)))).map((p) => toS(vp, p));
        return `M${pts.map((p) => `${f(p.x)} ${f(p.y)}`).join('L')}`;
      }).join('');
    }
  }
}

export function ProfileFill({ regions, vp }: { regions: ProfileRegion[]; vp: Vp }) {
  if (!regions.length) return null;
  const d = regions.flatMap((r) => [r.outer, ...r.holes]).map((loop) => {
    const pts = loopPolygon(loop, Math.PI / 60).map((p) => toS(vp, p));
    return `M${pts.map((p) => `${f(p.x)} ${f(p.y)}`).join('L')}Z`;
  }).join('');
  return <path d={d} className="cad-fill" fillRule="evenodd" pointerEvents="none" />;
}

// ------------------------------------------------------------ dimensions

export interface DimDrawing {
  /** Extension and dimension lines (screen). */
  path: string;
  arrows: string;
  text: string;
  /** Label position (screen). */
  at: Vec2;
}

const ARROW = 7;

function arrowAt(tip: Vec2, dir: Vec2): string {
  // dir points from the tip into the dimension line
  const n = { x: -dir.y, y: dir.x };
  const b = { x: tip.x + dir.x * ARROW, y: tip.y + dir.y * ARROW };
  return `M${f(tip.x)} ${f(tip.y)}L${f(b.x + n.x * 2.6)} ${f(b.y + n.y * 2.6)}L${f(b.x - n.x * 2.6)} ${f(b.y - n.y * 2.6)}Z`;
}

const unitVec = (a: Vec2, b: Vec2) => {
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
};

/** Text shown on a dimension: the value, plus the expression when it is not a plain number. */
export function dimText(c: CadConstraint, value: number, error?: string): string {
  if (error) return `${c.value ?? '?'} ⚠`;
  const ang = isAngleDim(c);
  const v = ang ? (value * 180) / Math.PI : value;
  const prefix = c.type === 'radius' ? 'R' : c.type === 'diameter' ? 'Ø' : c.type === 'majorRadius' ? 'a ' : c.type === 'minorRadius' ? 'b ' : '';
  let s = `${prefix}${fmtNum(Math.abs(v))}${ang ? '°' : ''}`;
  // a pattern shows its count too
  if (c.type === 'pattern' && c.pattern) s = `${c.pattern.count} × ${s}`;
  if (c.driving === false) return `(${s})`;
  // a constant (with or without a unit) is just the value; show the expression only when it has variables
  if (!isPlainNumber(c.value) && !/^\s*-?\d*\.?\d+(e[+-]?\d+)?\s*(mm|cm|m|in|ft|deg|°|rad)?\s*$/i.test(c.value ?? '')) {
    const e = (c.value ?? '').trim();
    s = `${e.length > 14 ? e.slice(0, 13) + '…' : e} = ${s}`;
  }
  return s;
}

/** Geometry of a dimension in screen space; null when its references are degenerate. */
export function dimDrawing(c: CadConstraint, g: Geo, vp: Vp, value: number, error?: string): DimDrawing | null {
  const z = vp.view.zoom;
  const off = c.offset ?? { x: 0, y: 0 };
  const ents = (id: string) => g.sk.entities.find((e) => e.id === id);
  const P = (id: string) => g.P.get(id)!;
  const text = dimText(c, value, error);

  const linear = (a: Vec2, b: Vec2, axis: 'aligned' | 'x' | 'y'): DimDrawing => {
    const A = toS(vp, a), B = toS(vp, b);
    let label: Vec2;
    let a2: Vec2, b2: Vec2;
    if (axis === 'aligned') {
      const u = unitVec(A, B);
      let n = { x: -u.y, y: u.x };
      if (n.y > 0 || (n.y === 0 && n.x < 0)) n = { x: -n.x, y: -n.y }; // default side: above
      const mid = { x: (A.x + B.x) / 2 + n.x * 18, y: (A.y + B.y) / 2 + n.y * 18 };
      label = { x: mid.x + off.x * z, y: mid.y - off.y * z };
      const s = (label.x - A.x) * n.x + (label.y - A.y) * n.y;
      a2 = { x: A.x + n.x * s, y: A.y + n.y * s };
      b2 = { x: B.x + n.x * s, y: B.y + n.y * s };
    } else if (axis === 'x') {
      const top = Math.min(A.y, B.y) - 18;
      label = { x: (A.x + B.x) / 2 + off.x * z, y: top - off.y * z };
      a2 = { x: A.x, y: label.y };
      b2 = { x: B.x, y: label.y };
    } else {
      const right = Math.max(A.x, B.x) + 18;
      label = { x: right + off.x * z, y: (A.y + B.y) / 2 - off.y * z };
      a2 = { x: label.x, y: A.y };
      b2 = { x: label.x, y: B.y };
    }
    const ext = (p: Vec2, q: Vec2) => {
      const u = unitVec(p, q), L = Math.hypot(q.x - p.x, q.y - p.y);
      if (L < 1) return '';
      return `M${f(p.x + u.x * 3)} ${f(p.y + u.y * 3)}L${f(q.x + u.x * 4)} ${f(q.y + u.y * 4)}`;
    };
    const u = unitVec(a2, b2);
    return {
      path: `${ext(A, a2)}${ext(B, b2)}M${f(a2.x)} ${f(a2.y)}L${f(b2.x)} ${f(b2.y)}`,
      arrows: arrowAt(a2, u) + arrowAt(b2, { x: -u.x, y: -u.y }),
      text, at: label,
    };
  };

  switch (c.type) {
    case 'length': {
      const e = ents(c.refs[0]);
      if (e?.type !== 'line') return null;
      return linear(P(e.p1), P(e.p2), 'aligned');
    }
    case 'distance': {
      const e = ents(c.refs[1]);
      if (e?.type === 'line') {
        const p = P(c.refs[0]), a = P(e.p1), b = P(e.p2);
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
        return linear(p, { x: a.x + t * dx, y: a.y + t * dy }, 'aligned');
      }
      return linear(P(c.refs[0]), P(c.refs[1]), 'aligned');
    }
    case 'distanceX': return linear(P(c.refs[0]), P(c.refs[1]), 'x');
    case 'distanceY': return linear(P(c.refs[0]), P(c.refs[1]), 'y');
    case 'radius':
    case 'diameter': {
      const e = ents(c.refs[0]);
      if (!e || (e.type !== 'circle' && e.type !== 'arc')) return null;
      const cw = P(e.c), r = entityRadius(g, e);
      let dir = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
      if (e.type === 'arc') {
        // point at the middle of the arc
        const a = P(e.p1), b = P(e.p2);
        const a0 = Math.atan2(a.y - cw.y, a.x - cw.x);
        let a1 = Math.atan2(b.y - cw.y, b.x - cw.x);
        while (a1 <= a0) a1 += 2 * Math.PI;
        dir = { x: Math.cos((a0 + a1) / 2), y: Math.sin((a0 + a1) / 2) };
      }
      const base = { x: cw.x + dir.x * (r + 14 / z), y: cw.y + dir.y * (r + 14 / z) };
      const label = toS(vp, { x: base.x + off.x, y: base.y + off.y });
      const C = toS(vp, cw);
      const u = unitVec(C, label);
      const edge = { x: C.x + u.x * r * z, y: C.y + u.y * r * z };
      const start = c.type === 'diameter' ? { x: C.x - u.x * r * z, y: C.y - u.y * r * z } : C;
      return {
        path: `M${f(start.x)} ${f(start.y)}L${f(label.x)} ${f(label.y)}`,
        arrows: arrowAt(edge, { x: -u.x, y: -u.y }) + (c.type === 'diameter' ? arrowAt(start, u) : ''),
        text, at: label,
      };
    }
    case 'majorRadius':
    case 'minorRadius': {
      // along the semi-axis, from the centre
      const e = ents(c.refs[0]);
      if (e?.type !== 'ellipse') return null;
      const cc = P(e.c), a = P(e.a), r = c.type === 'majorRadius' ? Math.hypot(a.x - cc.x, a.y - cc.y) : entityRadius(g, e);
      const u = unitVec(cc, a), d = c.type === 'majorRadius' ? u : { x: -u.y, y: u.x };
      return linear(cc, { x: cc.x + d.x * r, y: cc.y + d.y * r }, 'aligned');
    }
    case 'offset': {
      // across the first pair: from the source's middle square to its copy
      const src = ents(c.refs[0]), dst = ents(c.refs[1]);
      if (src?.type === 'line' && dst?.type === 'line') {
        const a = P(src.p1), b = P(src.p2), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const p = P(dst.p1), q = P(dst.p2), dx = q.x - p.x, dy = q.y - p.y, L2 = dx * dx + dy * dy || 1;
        const t = ((m.x - p.x) * dx + (m.y - p.y) * dy) / L2;
        return linear(m, { x: p.x + t * dx, y: p.y + t * dy }, 'aligned');
      }
      if ((src?.type === 'circle' || src?.type === 'arc') && (dst?.type === 'circle' || dst?.type === 'arc')) {
        const cc = P(src.c), r0 = entityRadius(g, src), r1 = entityRadius(g, dst);
        let dir = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
        if (src.type === 'arc') {
          const a = P(src.p1), b = P(src.p2), a0 = Math.atan2(a.y - cc.y, a.x - cc.x);
          let a1 = Math.atan2(b.y - cc.y, b.x - cc.x);
          while (a1 <= a0) a1 += 2 * Math.PI;
          dir = { x: Math.cos((a0 + a1) / 2), y: Math.sin((a0 + a1) / 2) };
        }
        return linear({ x: cc.x + dir.x * r0, y: cc.y + dir.y * r0 }, { x: cc.x + dir.x * r1, y: cc.y + dir.y * r1 }, 'aligned');
      }
      return null;
    }
    case 'pattern': {
      const pt = c.pattern;
      if (!pt || c.refs.length < 2 * pt.n) return null;
      if (pt.kind === 'rect') return linear(P(c.refs[0]), P(c.refs[pt.n]), 'aligned');
      // the label by the centre
      const o = toS(vp, P(pt.about!));
      return { path: '', arrows: '', text, at: { x: o.x + 22 + off.x * z, y: o.y - 18 - off.y * z } };
    }
    case 'angle': {
      const l2 = ents(c.refs.length === 1 ? c.refs[0] : c.refs[1]);
      const l1 = c.refs.length === 1 ? null : ents(c.refs[0]);
      if (l2?.type !== 'line' || (l1 && l1.type !== 'line')) return null;
      const a2 = P(l2.p1), b2 = P(l2.p2);
      const a1 = l1 && l1.type === 'line' ? P(l1.p1) : a2;
      const b1 = l1 && l1.type === 'line' ? P(l1.p2) : { x: a2.x + 1, y: a2.y };
      const d1 = { x: b1.x - a1.x, y: b1.y - a1.y }, d2 = { x: b2.x - a2.x, y: b2.y - a2.y };
      const den = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(den) < 1e-12) return null;
      const t = ((a2.x - a1.x) * d2.y - (a2.y - a1.y) * d2.x) / den;
      const O = { x: a1.x + t * d1.x, y: a1.y + t * d1.y };
      // arms point from the vertex towards each line's far half
      const arm = (a: Vec2, b: Vec2) => {
        const m = { x: (a.x + b.x) / 2 - O.x, y: (a.y + b.y) / 2 - O.y };
        const L = Math.hypot(m.x, m.y);
        if (L > 1e-12) return { x: m.x / L, y: m.y / L };
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
      };
      const u1 = l1 ? arm(a1, b1) : { x: 1, y: 0 }, u2 = arm(a2, b2);
      const R = Math.max(10 / z, 34 / z + off.x); // offset.x: extra radius, dragged by the label
      let t1 = Math.atan2(u1.y, u1.x), t2 = Math.atan2(u2.y, u2.x);
      if (((t2 - t1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) > Math.PI) [t1, t2] = [t2, t1];
      while (t2 < t1) t2 += 2 * Math.PI;
      const p1 = toS(vp, { x: O.x + R * Math.cos(t1), y: O.y + R * Math.sin(t1) });
      const p2 = toS(vp, { x: O.x + R * Math.cos(t2), y: O.y + R * Math.sin(t2) });
      const mid = (t1 + t2) / 2;
      const label = toS(vp, { x: O.x + (R + 12 / z) * Math.cos(mid), y: O.y + (R + 12 / z) * Math.sin(mid) });
      const Rs = R * z;
      return {
        path: `M${f(p1.x)} ${f(p1.y)}A${f(Rs)} ${f(Rs)} 0 0 0 ${f(p2.x)} ${f(p2.y)}`,
        arrows: '',
        text, at: label,
      };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------ constraint glyphs

export interface Glyph {
  c: CadConstraint;
  at: Vec2;
  text: string;
}

/** Glyph positions: stacked beside each referenced line, or beside the point. */
export function glyphs(g: Geo, vp: Vp): Glyph[] {
  const out: Glyph[] = [];
  const stack = new Map<string, number>();
  const ents = new Map(g.sk.entities.map((e) => [e.id, e]));
  const place = (id: string): Vec2 | null => {
    const k = stack.get(id) ?? 0;
    stack.set(id, k + 1);
    const e = ents.get(id);
    if (e?.type === 'line') {
      const a = toS(vp, g.P.get(e.p1)!), b = toS(vp, g.P.get(e.p2)!);
      const u = unitVec(a, b);
      // the side opposite a dimension's default label, a third along the line, so glyphs never cover labels
      let n = { x: -u.y, y: u.x };
      if (!(n.y > 0 || (n.y === 0 && n.x < 0))) n = { x: -n.x, y: -n.y };
      const t = 0.3;
      return { x: a.x + (b.x - a.x) * t + n.x * 11 + u.x * 15 * k, y: a.y + (b.y - a.y) * t + n.y * 11 + u.y * 15 * k };
    }
    if (e && (e.type === 'circle' || e.type === 'arc')) {
      const c = toS(vp, g.P.get(e.c)!), r = entityRadius(g, e) * vp.view.zoom;
      return { x: c.x + r * 0.71 + 10 + 15 * k, y: c.y + r * 0.71 + 8 };
    }
    if (e && (e.type === 'ellipse' || e.type === 'spline')) {
      // beside the middle of the curve
      const sg = segsOf(g, e)[0];
      if (sg) {
        const m = toS(vp, segPoint(sg, 0.5));
        return { x: m.x + 10 + 15 * k, y: m.y + 12 };
      }
    }
    const p = g.P.get(id);
    if (p) {
      const s = toS(vp, p);
      return { x: s.x + 10 + 15 * k, y: s.y + 12 };
    }
    return null;
  };
  const equalShown = new Set<string>();
  // points kept only as references (a fillet's virtual sharp) carry no visible relations
  const helperPoints = new Set(g.sk.entities.filter((e) => e.type === 'point' && e.construction).map((e) => (e as { p: string }).p));
  const endsOf = (id: string) => {
    const e = ents.get(id);
    return e?.type === 'line' || e?.type === 'arc' ? [e.p1, e.p2] : [];
  };
  for (const c of g.sk.constraints) {
    if (isDimension(c.type) || c.type === 'coincident') continue;
    const text = GLYPH[c.type];
    if (!text) continue;
    if ((c.type === 'pointOnLine' || c.type === 'pointOnCircle' || c.type === 'pointOnCurve') && (helperPoints.has(c.refs[0]) || ents.get(c.refs[1])?.construction)) continue;
    // symmetry: one marker between the two points (on the axis), so pairs don't pile up
    if (c.type === 'symmetric') {
      const a = g.P.get(c.refs[0]), b = g.P.get(c.refs[1]);
      if (a && b) {
        const m = toS(vp, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        out.push({ c, at: { x: m.x + 9, y: m.y - 9 }, text });
        continue;
      }
    }
    // tangency and curvature at a spline's end: by that end
    if ((c.type === 'tangent' || c.type === 'curvature') && c.ends?.some((x) => x === 0 || x === 1)) {
      const i = c.ends.findIndex((x) => x === 0 || x === 1), sp = ents.get(c.refs[i]);
      if (sp?.type === 'spline') {
        const at = place(c.ends[i] ? sp.pts[sp.pts.length - 1] : sp.pts[0]);
        if (at) out.push({ c, at, text });
        continue;
      }
    }
    // tangency at a joint: one marker at the shared point
    if (c.type === 'tangent') {
      const joint = endsOf(c.refs[0]).find((p) => endsOf(c.refs[1]).includes(p));
      if (joint) {
        const at = place(joint);
        if (at) out.push({ c, at, text });
        continue;
      }
    }
    let targets = c.type === 'symmetric' ? [c.refs[2]] : c.type === 'midpoint' || c.type === 'pointOnLine' || c.type === 'pointOnCircle' || c.type === 'pointOnCurve' ? [c.refs[0]] : c.refs;
    // a chain of equal sides (polygons): one "=" per side, not one per constraint
    if (c.type === 'equal') {
      targets = targets.filter((id) => !equalShown.has(id));
      targets.forEach((id) => equalShown.add(id));
    }
    for (const id of targets) {
      const at = place(id);
      if (at) out.push({ c, at, text });
    }
  }
  return out;
}
