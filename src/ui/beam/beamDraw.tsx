// Drawing of a beam region: members, supports, loads, reactions and the N / V / M /
// deflection diagrams, in screen coordinates.
import type { JSX } from 'react';
import type { BeamRegion } from '../../model/types';
import type { BeamResult } from '../../beam/evaluate';
import { loadPoint, type BeamData, type BeamDiagram, type BeamLoad, type BeamView } from '../../beam/model';

export const LENGTH_M: Record<string, number> = { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048, in: 0.0254 };
export const FORCE_N: Record<string, number> = { kN: 1e3, N: 1, MN: 1e6, kip: 4448.2216152605, lbf: 4.4482216152605 };

export interface Vp {
  view: BeamView;
  width: number;
  height: number;
}

export interface P2 {
  x: number;
  y: number;
}

export const toS = (vp: Vp, p: P2): P2 => ({ x: (p.x - vp.view.cx) * vp.view.zoom + vp.width / 2, y: vp.height / 2 - (p.y - vp.view.cy) * vp.view.zoom });
export const toW = (vp: Vp, s: P2): P2 => ({ x: (s.x - vp.width / 2) / vp.view.zoom + vp.view.cx, y: (vp.height / 2 - s.y) / vp.view.zoom + vp.view.cy });

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return '?';
  const a = Math.abs(v);
  if (a < 5e-10) return '0';
  const s = a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 10 ? v.toFixed(2) : a >= 0.01 ? v.toFixed(3) : v.toPrecision(3);
  return s.includes('.') && !s.includes('e') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Display conversions from SI. */
export function units(r: BeamRegion) {
  const F = FORCE_N[r.forceUnit] ?? 1e3, L = LENGTH_M[r.lengthUnit] ?? 1;
  const metric = r.lengthUnit === 'm' || r.lengthUnit === 'cm' || r.lengthUnit === 'mm';
  return {
    force: (v: number) => `${fmt(v / F)} ${r.forceUnit}`,
    moment: (v: number) => `${fmt(v / (F * L))} ${r.forceUnit}·${r.lengthUnit}`,
    line: (v: number) => `${fmt(v / (F / L))} ${r.forceUnit}/${r.lengthUnit}`,
    defl: (v: number) => (metric ? `${fmt(v * 1000)} mm` : `${fmt(v / 0.0254)} in`),
    stress: (v: number) => `${fmt(v / 1e6)} MPa`,
    length: (v: number) => `${fmt(v)} ${r.lengthUnit}`,
  };
}

/** Bounds of the structure in the length unit. */
export function bounds(d: BeamData): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!d.nodes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of d.nodes) {
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
    y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * A view that frames the structure: room above for loads and the summary, around it
 * for reaction arrows and diagram values, below for the supports and the diagram strip.
 */
export function fitView(d: BeamData, width: number, height: number): BeamView | null {
  const b = bounds(d);
  if (!b) return null;
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const left = 100, right = 100, top = 70, bottom = 100;
  const zx = w > 0 ? (width - left - right) / w : Infinity;
  const zy = h > 0 ? (height - top - bottom) / h : Infinity;
  let zoom = Math.min(zx, zy);
  if (!Number.isFinite(zoom)) zoom = 60;
  zoom = Math.max(1e-6, zoom);
  // centre the structure in the box left after the margins
  const cxPx = left + (width - left - right) / 2, cyPx = top + (height - top - bottom) / 2;
  return { cx: (b.x0 + b.x1) / 2 - (cxPx - width / 2) / zoom, cy: (b.y0 + b.y1) / 2 + (cyPx - height / 2) / zoom, zoom };
}

// ------------------------------------------------------------ symbols

/** Support symbol at a screen point; rotated by `angle` degrees (counter-clockwise). */
export function SupportGlyph({ at, type, angle, cls = '' }: { at: P2; type: 'pin' | 'roller' | 'fixed'; angle: number; cls?: string }) {
  const rot = `translate(${at.x} ${at.y}) rotate(${-angle})`;
  const hatch = (y: number, x0: number, x1: number) => {
    const out: JSX.Element[] = [];
    for (let x = x0; x < x1; x += 5) out.push(<line key={x} x1={x} y1={y} x2={x - 5} y2={y + 6} />);
    return out;
  };
  if (type === 'fixed') {
    return (
      <g className={`bm-support ${cls}`} transform={rot}>
        <line x1={-14} y1={0} x2={14} y2={0} className="bm-ground" />
        <g className="bm-hatch">{hatch(0, -12, 16)}</g>
      </g>
    );
  }
  return (
    <g className={`bm-support ${cls}`} transform={rot}>
      <path d="M0 0 L-9 14 L9 14 Z" className="bm-tri" />
      {type === 'roller' ? (
        <>
          <circle cx={-5} cy={17.5} r={2.6} className="bm-tri" />
          <circle cx={5} cy={17.5} r={2.6} className="bm-tri" />
          <line x1={-14} y1={21} x2={14} y2={21} className="bm-ground" />
          <g className="bm-hatch">{hatch(21, -12, 16)}</g>
        </>
      ) : (
        <>
          <line x1={-14} y1={14} x2={14} y2={14} className="bm-ground" />
          <g className="bm-hatch">{hatch(14, -12, 16)}</g>
        </>
      )}
    </g>
  );
}

/** Arrow from `from` to `to` (screen), head at `to`. */
export function Arrow({ from, to, cls = '', head = 7 }: { from: P2; to: P2; cls?: string; head?: number }) {
  const dx = to.x - from.x, dy = to.y - from.y, l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const b = { x: to.x - ux * head, y: to.y - uy * head };
  return (
    <g className={`bm-arrow ${cls}`}>
      <line x1={from.x} y1={from.y} x2={b.x} y2={b.y} />
      <path d={`M${to.x} ${to.y} L${b.x - uy * head * 0.45} ${b.y + ux * head * 0.45} L${b.x + uy * head * 0.45} ${b.y - ux * head * 0.45} Z`} />
    </g>
  );
}

/** Curved moment arrow around a point: counter-clockwise when positive. */
export function MomentArrow({ at, positive, cls = '', r = 15 }: { at: P2; positive: boolean; cls?: string; r?: number }) {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const pt = (deg: number) => ({ x: at.x + r * Math.cos(rad(deg)), y: at.y - r * Math.sin(rad(deg)) });
  // 270° of arc; the head points along the direction of turning
  const [start, end] = positive ? [-60, 210] : [240, -30];
  const p0 = pt(start), p1 = pt(end);
  const t = positive ? { x: -Math.sin(rad(end)), y: -Math.cos(rad(end)) } : { x: Math.sin(rad(end)), y: Math.cos(rad(end)) };
  const h = 7, b = { x: p1.x - t.x * h, y: p1.y - t.y * h };
  return (
    <g className={`bm-arrow ${cls}`}>
      <path d={`M${p0.x} ${p0.y} A${r} ${r} 0 1 ${positive ? 0 : 1} ${b.x} ${b.y}`} fill="none" />
      <path d={`M${p1.x} ${p1.y} L${b.x - t.y * h * 0.45} ${b.y + t.x * h * 0.45} L${b.x + t.y * h * 0.45} ${b.y - t.x * h * 0.45} Z`} />
    </g>
  );
}

// ------------------------------------------------------------ loads

export function LoadGlyph({ r, d, l, vp, res, sel, label }: { r: BeamRegion; d: BeamData; l: BeamLoad; vp: Vp; res?: BeamResult; sel: boolean; label: boolean }) {
  const u = units(r);
  const err = !!res?.errors[l.id];
  const cls = `bm-load${sel ? ' sel' : ''}${err ? ' err' : ''}`;
  const vals = res?.values[l.id];
  if (l.type === 'line') {
    const m = d.members.find((q) => q.id === l.member);
    if (!m) return null;
    const N = new Map(d.nodes.map((q) => [q.id, q]));
    const a = toS(vp, N.get(m.a)!), b = toS(vp, N.get(m.b)!);
    const t1 = l.t1 ?? 0, t2 = l.t2 ?? 1;
    const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
    const p2 = { x: a.x + (b.x - a.x) * t2, y: a.y + (b.y - a.y) * t2 };
    const q1 = vals?.[0] ?? 1, q2 = vals?.[1] ?? q1;
    const qmax = Math.max(Math.abs(q1), Math.abs(q2), 1e-12);
    const H = 30;
    // arrows come from above (global) or from the member's left side (local)
    let nx = 0, ny = -1;
    if (l.dir === 'local') {
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      nx = (b.y - a.y) / L; ny = -(b.x - a.x) / L; // screen-left of travel = member's +y side
    }
    const h1 = (H * q1) / qmax, h2 = (H * q2) / qmax;
    const top1 = { x: p1.x + nx * h1, y: p1.y + ny * h1 }, top2 = { x: p2.x + nx * h2, y: p2.y + ny * h2 };
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.max(2, Math.min(14, Math.round(len / 22) + 1));
    const arrows: JSX.Element[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const base = { x: p1.x + (p2.x - p1.x) * t, y: p1.y + (p2.y - p1.y) * t };
      const h = h1 + (h2 - h1) * t;
      if (Math.abs(h) < 4) continue;
      arrows.push(<Arrow key={i} from={{ x: base.x + nx * h, y: base.y + ny * h }} to={base} head={5} />);
    }
    const text = vals ? (Math.abs(q1 - q2) < 1e-9 * qmax ? u.line(q1) : `${u.line(q1)} → ${u.line(q2)}`) : l.q1;
    // the label sits at the start of the load, clear of point loads in the middle
    const mid = { x: top1.x + nx * 8, y: top1.y + ny * 8 };
    return (
      <g className={cls} data-item={l.id}>
        <path d={`M${p1.x} ${p1.y} L${top1.x} ${top1.y} L${top2.x} ${top2.y} L${p2.x} ${p2.y} Z`} className="bm-load-area" />
        {arrows}
        <line x1={top1.x} y1={top1.y} x2={top2.x} y2={top2.y} />
        {label && <text x={mid.x} y={mid.y} className="bm-label" textAnchor="start">{text}</text>}
      </g>
    );
  }
  const p = loadPoint(d, l.at);
  if (!p) return null;
  const s = toS(vp, p);
  if (l.type === 'moment') {
    const M = vals?.[0] ?? 1;
    return (
      <g className={cls} data-item={l.id}>
        <MomentArrow at={s} positive={M >= 0} r={16} />
        {label && <text x={s.x + 19} y={s.y - 16} className="bm-label">{vals ? u.moment(Math.abs(M)) : l.value}</text>}
      </g>
    );
  }
  const P = vals?.[0] ?? 1;
  const ang = ((l.angle + (P < 0 ? 180 : 0)) * Math.PI) / 180;
  const dir = { x: Math.cos(ang), y: -Math.sin(ang) }; // screen
  const L = 44;
  const from = { x: s.x - dir.x * L, y: s.y - dir.y * L };
  return (
    <g className={cls} data-item={l.id}>
      <Arrow from={from} to={{ x: s.x - dir.x * 2, y: s.y - dir.y * 2 }} />
      {label && <text x={from.x - dir.x * 6 + (Math.abs(dir.y) > 0.7 ? 6 : 0)} y={from.y - dir.y * 6 + (dir.y > 0.7 ? -2 : dir.y < -0.7 ? 10 : 4)}
        className="bm-label" textAnchor={Math.abs(dir.y) > 0.7 ? 'start' : dir.x > 0 ? 'end' : 'start'}>{vals ? u.force(Math.abs(P)) : l.value}</text>}
    </g>
  );
}

// ------------------------------------------------------------ diagrams

const DIAGRAM_PX = 52;

/** N, V, M or deflection drawn on every member, with the extreme values labelled. */
export function Diagram({ r, d, vp, res, kind }: { r: BeamRegion; d: BeamData; vp: Vp; res: BeamResult; kind: Exclude<BeamDiagram, 'model' | 'reactions'> }) {
  const sol = res.solution;
  if (!sol) return null;
  const u = units(r);
  const Lm = LENGTH_M[r.lengthUnit] ?? 1;
  const N = new Map(d.nodes.map((q) => [q.id, q]));
  if (kind === 'deflection') {
    const wmax = sol.max.w?.value ?? 0;
    const k = wmax > 0 ? DIAGRAM_PX / vp.view.zoom / (wmax / Lm) : 0; // exaggeration: the largest deflection shows as DIAGRAM_PX
    const paths: JSX.Element[] = [];
    for (const mr of sol.members) {
      const m = d.members.find((q) => q.id === mr.id);
      if (!m) continue;
      const a = N.get(m.a)!, b = N.get(m.b)!;
      const L = mr.L;
      const pts = mr.s.map((s, i) => {
        const t = s / L;
        const w = { x: a.x + (b.x - a.x) * t + (mr.dx[i] / Lm) * k, y: a.y + (b.y - a.y) * t + (mr.dy[i] / Lm) * k };
        return toS(vp, w);
      });
      paths.push(<polyline key={mr.id} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} className="bm-deformed" />);
    }
    const mx = sol.max.w;
    let label: JSX.Element | null = null;
    if (mx && wmax > 0) {
      const mr = sol.members.find((q) => q.id === mx.member)!;
      const i = mr.s.findIndex((s) => Math.abs(s - mx.s) < 1e-12);
      const m = d.members.find((q) => q.id === mr.id)!;
      const a = N.get(m.a)!, b = N.get(m.b)!, t = mx.s / mr.L;
      const p = toS(vp, { x: a.x + (b.x - a.x) * t + (mr.dx[i] / Lm) * k, y: a.y + (b.y - a.y) * t + (mr.dy[i] / Lm) * k });
      label = (
        <g>
          <circle cx={p.x} cy={p.y} r={3} className="bm-max-dot" />
          <text x={p.x + 6} y={p.y + 14} className="bm-value">δ = {u.defl(wmax)}</text>
        </g>
      );
    }
    return <g className="bm-diagram defl">{paths}{label}</g>;
  }
  const vals = (mr: typeof sol.members[number]) => (kind === 'M' ? mr.M : kind === 'V' ? mr.V : mr.N);
  let vmax = 0;
  for (const mr of sol.members) for (const v of vals(mr)) vmax = Math.max(vmax, Math.abs(v));
  const scale = vmax > 0 ? DIAGRAM_PX / vmax : 0;
  const text = (v: number) => (kind === 'M' ? u.moment(v) : u.force(v));
  const out: JSX.Element[] = [];
  const labels: { p: P2; text: string; key: string }[] = [];
  for (const mr of sol.members) {
    const m = d.members.find((q) => q.id === mr.id);
    if (!m) continue;
    const a = toS(vp, N.get(m.a)!), b = toS(vp, N.get(m.b)!);
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // member +y in screen coordinates (screen y points down): up for a left-to-right member
    const ey = { x: (b.y - a.y) / L, y: -(b.x - a.x) / L };
    // moments are drawn on the tension side (−y for sagging), N and V on +y when positive
    const sign = kind === 'M' ? -1 : 1;
    const v = vals(mr);
    const pts = mr.s.map((s, i) => {
      const t = s / mr.L;
      const base = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const off = sign * v[i] * scale;
      return { base, p: { x: base.x + ey.x * off, y: base.y + ey.y * off } };
    });
    if (!pts.length) continue;
    const poly = [a, ...pts.map((q) => q.p), b];
    out.push(
      <g key={mr.id}>
        <polygon points={poly.map((p) => `${p.x},${p.y}`).join(' ')} className={`bm-fill ${kind}`} />
        <polyline points={pts.map((q) => `${q.p.x},${q.p.y}`).join(' ')} className={`bm-curve ${kind}`} />
      </g>,
    );
    // label the largest and smallest value on the member, and nonzero end values
    let iMax = 0, iMin = 0;
    v.forEach((x, i) => {
      if (x > v[iMax]) iMax = i;
      if (x < v[iMin]) iMin = i;
    });
    const want = new Set<number>();
    if (Math.abs(v[iMax]) > 0.02 * vmax) want.add(iMax);
    if (Math.abs(v[iMin]) > 0.02 * vmax) want.add(iMin);
    for (const i of [0, v.length - 1]) if (Math.abs(v[i]) > 0.05 * vmax) want.add(i);
    for (const i of want) {
      const q = pts[i];
      const off = sign * v[i] * scale;
      const dirSign = off >= 0 ? 1 : -1;
      labels.push({ key: `${mr.id}-${i}`, p: { x: q.p.x + ey.x * dirSign * 10, y: q.p.y + ey.y * dirSign * 10 + 4 }, text: text(v[i]) });
    }
  }
  // drop labels that would sit on top of each other
  const kept: typeof labels = [];
  for (const l of labels) {
    const clash = kept.some((k) => (Math.abs(k.p.x - l.p.x) < 52 && Math.abs(k.p.y - l.p.y) < 14) || (k.text === l.text && Math.hypot(k.p.x - l.p.x, k.p.y - l.p.y) < 60));
    if (!clash) kept.push(l);
  }
  return (
    <g className="bm-diagram">
      {out}
      {kept.map((l) => <text key={l.key} x={l.p.x} y={l.p.y} className="bm-value" textAnchor="middle">{l.text}</text>)}
    </g>
  );
}

/** Reaction arrows and values at the supports. */
export function Reactions({ r, d, vp, res }: { r: BeamRegion; d: BeamData; vp: Vp; res: BeamResult }) {
  const sol = res.solution;
  if (!sol) return null;
  const u = units(r);
  const out: JSX.Element[] = [];
  let fmax = 0;
  for (const q of sol.reactions) fmax = Math.max(fmax, Math.abs(q.Rx), Math.abs(q.Ry));
  // moment labels go towards the middle of the structure, where there is room
  const midX = d.nodes.reduce((acc, n) => acc + toS(vp, n).x, 0) / Math.max(1, d.nodes.length);
  for (const q of sol.reactions) {
    const node = d.nodes.find((n) => n.id === q.node);
    if (!node) continue;
    const s = toS(vp, node);
    const side = s.x <= midX ? 1 : -1;
    const tiny = 1e-9 * Math.max(fmax, 1);
    const L = 40;
    if (Math.abs(q.Ry) > tiny) {
      const up = q.Ry > 0;
      const k = up ? 1 : -1;
      out.push(
        <g key={`${q.id}y`} className="bm-reaction">
          <Arrow from={{ x: s.x, y: s.y + k * (L + 26) }} to={{ x: s.x, y: s.y + k * 26 }} />
          <text x={s.x + 6} y={s.y + k * (26 + L / 2) + 4} className="bm-value">{q.label}y = {u.force(Math.abs(q.Ry))}</text>
        </g>,
      );
    }
    if (Math.abs(q.Rx) > tiny) {
      const right = q.Rx > 0;
      const k = right ? -1 : 1;
      out.push(
        <g key={`${q.id}x`} className="bm-reaction">
          <Arrow from={{ x: s.x + k * (L + 28), y: s.y }} to={{ x: s.x + k * 28, y: s.y }} />
          <text x={s.x + k * 26} y={s.y - 6} className="bm-value" textAnchor={k > 0 ? 'start' : 'end'}>{q.label}x = {u.force(Math.abs(q.Rx))}</text>
        </g>,
      );
    }
    if (Math.abs(q.M) > tiny * 1e-3) {
      out.push(
        <g key={`${q.id}m`} className="bm-reaction">
          <MomentArrow at={s} positive={q.M > 0} r={22} />
          <text x={s.x + side * 26} y={s.y - 24} className="bm-value" textAnchor={side > 0 ? 'start' : 'end'}>M{q.label} = {u.moment(Math.abs(q.M))}</text>
        </g>,
      );
    }
  }
  return <g>{out}</g>;
}
