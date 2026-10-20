// Drawing of influence lines and moving loads: one panel per influence line under the
// diagrams (aligned with the structure along x, positive ordinates up), the section each
// line belongs to marked on the structure, and an axle train at a chosen position.
import type { JSX } from 'react';
import type { BeamRegion } from '../../model/types';
import type { BeamResult } from '../../beam/evaluate';
import type { TrafficMoving } from '../../beam/traffic';
import type { BeamData } from '../../beam/model';
import { ilValue } from '../../beam/influence';
import { Arrow, LENGTH_M, fmt, toS, units, type P2, type Vp } from './beamDraw';
import { lineTitle, ordinateUnit, ordinateValue, trainUnit } from './BeamTraffic';

/** Screen point of global x (m) on the load path, or null off it. */
function pathPoint(r: BeamRegion, d: BeamData, res: BeamResult, vp: Vp, xm: number): P2 | null {
  const tr = res.traffic;
  const Lm = LENGTH_M[r.lengthUnit] ?? 1;
  const seg = tr?.path.find((p) => xm >= p.x0 - 1e-9 && xm <= p.x1 + 1e-9);
  const m = seg && d.members.find((q) => q.id === seg.member);
  const N = new Map(d.nodes.map((q) => [q.id, q]));
  const a = m && N.get(m.a), b = m && N.get(m.b);
  if (!a || !b) return null;
  const t = (xm / Lm - a.x) / (b.x - a.x);
  return toS(vp, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
}

/** The panels of the influence lines, `h` high each, from `top`. */
export function InfluencePanels({ r, d, res, vp, top, h, width, train }: {
  r: BeamRegion; d: BeamData; res: BeamResult; vp: Vp; top: number; h: number; width: number;
  /** Axle positions (m) of the train shown, with their loads (N). */
  train?: { x: number; P: number }[];
}) {
  const tr = res.traffic;
  if (!tr || !tr.lines.length) return null;
  const Lm = LENGTH_M[r.lengthUnit] ?? 1;
  const u = units(r);
  const X = (xm: number) => toS(vp, { x: xm / Lm, y: 0 }).x;
  const supportsX = r.supports.flatMap((s) => {
    const n = d.nodes.find((q) => q.id === s.node);
    return n && tr.path.some((p) => n.x * Lm >= p.x0 - 1e-9 && n.x * Lm <= p.x1 + 1e-9) ? [{ x: n.x * Lm, label: s.label }] : [];
  });
  return (
    <g className="bm-stack bm-il">
      {tr.lines.map((line, idx) => {
        const def = r.traffic?.lines.find((q) => q.id === line.id);
        if (!def) return null;
        const y0 = top + idx * h;
        const vals = line.v.map((v) => ordinateValue(r, line.quantity, v));
        let lo = 0, hi = 0;
        for (const v of vals) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        const big = Math.max(hi, -lo);
        const flat = !(big > 0) || hi - lo < 1e-12 * big;
        // (room under the title, which is longer than a diagram's)
        const yTop = y0 + 30, yBot = y0 + h - 16;
        const Y = (v: number) => (flat ? (yTop + yBot) / 2 : yTop + ((hi - v) / (hi - lo)) * (yBot - yTop));
        const yb = Y(0);
        const pts = line.x.map((x, i) => ({ x: X(x), y: Y(vals[i]) }));
        const x0 = pts[0].x, x1 = pts[pts.length - 1].x;
        const curve = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
        // labels: the extremes, both sides of the jump, nonzero ordinates over supports
        const cands: { i: number; pri: number }[] = [];
        let iMax = 0, iMin = 0;
        vals.forEach((v, i) => {
          if (v > vals[iMax]) iMax = i;
          if (v < vals[iMin]) iMin = i;
        });
        if (Math.abs(vals[iMax]) > 1e-9 * big) cands.push({ i: iMax, pri: 0 });
        if (Math.abs(vals[iMin]) > 1e-9 * big) cands.push({ i: iMin, pri: 0 });
        line.x.forEach((x, i) => {
          if (i > 0 && line.x[i - 1] === x) cands.push({ i: i - 1, pri: 1 }, { i, pri: 1 });
          if (supportsX.some((s) => Math.abs(s.x - x) < 1e-9) && Math.abs(vals[i]) > 0.02 * big) cands.push({ i, pri: 2 });
        });
        cands.sort((a, b) => a.pri - b.pri);
        const kept: { x: number; y: number; t: string; i: number }[] = [];
        for (const c of cands) {
          const v = vals[c.i];
          // zoomed in: ordinates off the side are not labelled at the edge
          if (pts[c.i].x < -1 || pts[c.i].x > width + 1) continue;
          const t = fmt(v);
          const lx = Math.min(Math.max(pts[c.i].x, 30), width - 30);
          const ly = v >= 0 ? pts[c.i].y - 5 : pts[c.i].y + 13;
          if (kept.some((q) => q.i === c.i || (Math.abs(q.x - lx) < 40 && Math.abs(q.y - ly) < 13))) continue;
          kept.push({ x: lx, y: ly, t, i: c.i });
        }
        const at = line.xs !== undefined ? X(line.xs) : def.support ? X((d.nodes.find((q) => q.id === r.supports.find((s) => s.id === def.support)?.node)?.x ?? 0) * Lm) : null;
        // the train on this line: Σ P η, axle by axle (those off the path count nothing), read
        // exactly between positions as the worksheet does
        const axles = train?.filter((a) => a.x >= line.x[0] - 1e-9 && a.x <= line.x[line.x.length - 1] + 1e-9)
          .map((a) => ({ ...a, v: ordinateValue(r, line.quantity, ilValue(line, a.x)) }));
        const sum = axles?.reduce((acc, a) => acc + (a.P / u.forceN) * a.v, 0);
        return (
          <g key={line.id} className="bm-panel IL">
            <line x1={0} y1={y0} x2={width} y2={y0} className="bm-panel-sep" />
            <text x={10} y={y0 + 15} className="bm-panel-title">
              η {line.name}<tspan className="bm-panel-unit"> {lineTitle(r, def)} [{ordinateUnit(r, line.quantity)}]</tspan>
              {sum !== undefined && <tspan className="bm-panel-unit"> · train: Σ P η = {fmt(sum)} {trainUnit(r, line.quantity)}</tspan>}
            </text>
            <g className="bm-guides">
              {supportsX.map((s) => <line key={s.label} x1={X(s.x)} y1={y0 + 18} x2={X(s.x)} y2={y0 + h - 4} />)}
            </g>
            {!flat && <polygon points={`${x0},${yb} ${curve} ${x1},${yb}`} className="bm-fill IL" />}
            <line x1={x0} y1={yb} x2={x1} y2={yb} className="bm-panel-base" />
            {!flat && <polyline points={curve} className="bm-curve IL" />}
            {at !== null && <path d={`M${at} ${yb} l-4 7 h8 z`} className="bm-il-at" />}
            {axles?.map((a, i) => (
              <g key={i} className="bm-il-axle">
                <line x1={X(a.x)} y1={y0 + 18} x2={X(a.x)} y2={Y(a.v)} />
                <circle cx={X(a.x)} cy={Y(a.v)} r={2.6} />
              </g>
            ))}
            {flat && <text x={(x0 + x1) / 2} y={yb - 5} className="bm-value" textAnchor="middle">0</text>}
            {kept.map((q) => <text key={q.i} x={q.x} y={q.y} className="bm-value" textAnchor="middle">{q.t}</text>)}
          </g>
        );
      })}
    </g>
  );
}

/** Where each influence line's section is, marked on the structure (over a support its label says enough). */
export function SectionMarks({ r, vp }: { r: BeamRegion; vp: Vp }) {
  const marks: JSX.Element[] = [];
  const held = new Set(r.supports.map((s) => s.node));
  for (const l of r.traffic?.lines ?? []) {
    if (!l.at || l.quantity === 'Ry' || l.quantity === 'Rx' || l.quantity === 'Mr') continue;
    if (r.nodes.some((q) => held.has(q.id) && Math.hypot(q.x - l.at!.x, q.y - l.at!.y) < 1e-9)) continue;
    const p = toS(vp, l.at);
    marks.push(
      <g key={l.id} className="bm-il-mark">
        <line x1={p.x} y1={p.y - 9} x2={p.x} y2={p.y + 9} />
        <text x={p.x} y={p.y + 21} textAnchor="middle">{l.name}</text>
      </g>,
    );
  }
  return <g>{marks}</g>;
}

/** The axle loads of a train at its position, arrows onto the load path. */
export function TrainGlyph({ r, d, res, vp, moving, lead, dir }: { r: BeamRegion; d: BeamData; res: BeamResult; vp: Vp; moving: TrafficMoving; lead: number; dir: 1 | -1 }) {
  const u = units(r);
  const on = moving.P.flatMap((P, i) => {
    const p = pathPoint(r, d, res, vp, lead - dir * moving.offsets[i]);
    return p ? [{ P, p, i }] : [];
  });
  if (!on.length) return null;
  // one label beside the axles at mid-height, clear of the strip above the structure
  const byX = [...on].sort((a, b) => a.p.x - b.p.x), L0 = byX[0].p, R0 = byX[byX.length - 1].p, left = L0.x, right = R0.x;
  const same = on.every((a) => a.P === on[0].P);
  const text = same ? `${on.length > 1 ? `${on.length} × ` : ''}${u.force(on[0].P)}` : `${on.map((a) => fmt(a.P / u.forceN)).join(' + ')} ${r.forceUnit}`;
  const flip = right > vp.width - 90;
  const yl = Math.min(...on.map((a) => a.p.y)) - 24;
  return (
    <g className="bm-load bm-moving">
      {on.length > 1 && <line x1={L0.x} y1={L0.y - 44} x2={R0.x} y2={R0.y - 44} className="bm-train-bar" />}
      {on.map((a) => <Arrow key={a.i} from={{ x: a.p.x, y: a.p.y - 44 }} to={{ x: a.p.x, y: a.p.y - 2 }} />)}
      <text x={flip ? left - 6 : right + 6} y={yl} className="bm-label" textAnchor={flip ? 'end' : 'start'}>{text}</text>
    </g>
  );
}
