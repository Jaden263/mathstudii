// Canvas plot rendering: XY, polar, 3-D surface and contour plots.
import type { PlotResult } from '../../engine/evaluator';
import type { PlotRegion } from '../../model/types';

export const SERIES_COLORS = ['#2f6fdf', '#e8590c', '#2b9348', '#c2255c', '#7048e8', '#0c8599', '#e67700', '#5c940d'];

export interface Theme {
  fg: string;
  muted: string;
  grid: string;
  bg: string;
}

export interface View {
  /** 3-D rotation (radians) */
  yaw: number;
  pitch: number;
}

/** "Nice" tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, target = 6): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) {
    const d = Math.abs(lo) || 1;
    lo -= d / 2;
    hi += d / 2;
  }
  const span = hi - lo;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function logTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    const v = Math.pow(10, e);
    if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
  }
  return out;
}

export function fmtTick(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) {
    const e = Math.floor(Math.log10(a));
    const m = v / Math.pow(10, e);
    return `${Number(m.toPrecision(3))}e${e}`;
  }
  return String(Number(v.toPrecision(6)));
}

function finite(xs: number[]): number[] {
  return xs.filter(Number.isFinite);
}

function range(vals: number[], log: boolean): [number, number] {
  const v = finite(vals).filter((x) => !log || x > 0);
  if (!v.length) return log ? [1, 10] : [-1, 1];
  let lo = Infinity, hi = -Infinity;
  for (const x of v) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (lo === hi) {
    const d = log ? lo * 0.5 : Math.abs(lo) * 0.1 || 1;
    return [lo - d, hi + d];
  }
  return [lo, hi];
}

/** Robust y range: ignore extreme spikes (e.g. tan near asymptotes) for auto-scaling. */
function robustRange(vals: number[], log: boolean): [number, number] {
  const v = finite(vals).filter((x) => !log || x > 0).sort((a, b) => a - b);
  if (v.length < 20) return range(vals, log);
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  const lo = q(0.01), hi = q(0.99);
  const span = hi - lo || Math.abs(hi) || 1;
  const full: [number, number] = [v[0], v[v.length - 1]];
  if (full[0] >= lo - span * 2 && full[1] <= hi + span * 2) return range(vals, log);
  return [lo - span * 0.1, hi + span * 0.1];
}

export interface Layout {
  left: number;
  top: number;
  width: number;
  height: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  logX: boolean;
  logY: boolean;
}

export function toPx(l: Layout, x: number, y: number): [number, number] {
  const tx = l.logX ? (Math.log10(x) - Math.log10(l.x0)) / (Math.log10(l.x1) - Math.log10(l.x0)) : (x - l.x0) / (l.x1 - l.x0);
  const ty = l.logY ? (Math.log10(y) - Math.log10(l.y0)) / (Math.log10(l.y1) - Math.log10(l.y0)) : (y - l.y0) / (l.y1 - l.y0);
  return [l.left + tx * l.width, l.top + (1 - ty) * l.height];
}

export function fromPx(l: Layout, px: number, py: number): [number, number] {
  const tx = (px - l.left) / l.width;
  const ty = 1 - (py - l.top) / l.height;
  const x = l.logX ? Math.pow(10, Math.log10(l.x0) + tx * (Math.log10(l.x1) - Math.log10(l.x0))) : l.x0 + tx * (l.x1 - l.x0);
  const y = l.logY ? Math.pow(10, Math.log10(l.y0) + ty * (Math.log10(l.y1) - Math.log10(l.y0))) : l.y0 + ty * (l.y1 - l.y0);
  return [x, y];
}

export function drawPlot(ctx: CanvasRenderingContext2D, w: number, h: number, region: PlotRegion, data: PlotResult | undefined, theme: Theme, view: View): Layout | null {
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px system-ui, sans-serif';
  if (!data) return null;
  if (data.surface) {
    if (region.plotType === 'contour') drawContour(ctx, w, h, data.surface, theme);
    else drawSurface(ctx, w, h, data.surface, theme, view);
    return null;
  }
  if (region.plotType === 'polar') {
    drawPolar(ctx, w, h, data, theme);
    return null;
  }
  return drawXY(ctx, w, h, region, data, theme);
}

function drawXY(ctx: CanvasRenderingContext2D, w: number, h: number, region: PlotRegion, data: PlotResult, theme: Theme): Layout {
  const allX = data.series.flatMap((s) => s.xs);
  const allY = data.series.flatMap((s) => s.ys);
  let [x0, x1] = range(allX, region.logX);
  let [y0, y1] = robustRange(allY, region.logY);
  const L0 = data.limits;
  x0 = L0?.xmin ?? x0; x1 = L0?.xmax ?? x1;
  y0 = L0?.ymin ?? y0; y1 = L0?.ymax ?? y1;
  if (L0?.ymin == null && L0?.ymax == null && !region.logY) {
    const pad = (y1 - y0) * 0.05;
    y0 -= pad;
    y1 += pad;
  }
  if (region.logX && x0 <= 0) x0 = Math.min(...finite(allX).filter((x) => x > 0), 1);
  if (region.logY && y0 <= 0) y0 = Math.min(...finite(allY).filter((x) => x > 0), 1);
  const titleH = region.title ? 18 : 0;
  const L: Layout = { left: 54, top: 10 + titleH, width: w - 54 - 14, height: h - 10 - titleH - 40, x0, x1, y0, y1, logX: region.logX, logY: region.logY };
  if (L.width < 20 || L.height < 20) return L;
  const xt = region.logX ? logTicks(x0, x1) : niceTicks(x0, x1, Math.max(2, Math.floor(L.width / 70)));
  const yt = region.logY ? logTicks(y0, y1) : niceTicks(y0, y1, Math.max(2, Math.floor(L.height / 40)));
  // grid
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const t of xt) {
    const [px] = toPx(L, t, y0 > 0 || !region.logY ? y0 : 1);
    ctx.moveTo(Math.round(px) + 0.5, L.top);
    ctx.lineTo(Math.round(px) + 0.5, L.top + L.height);
  }
  for (const t of yt) {
    const [, py] = toPx(L, x0 > 0 || !region.logX ? x0 : 1, t);
    ctx.moveTo(L.left, Math.round(py) + 0.5);
    ctx.lineTo(L.left + L.width, Math.round(py) + 0.5);
  }
  ctx.stroke();
  // zero axes
  ctx.strokeStyle = theme.muted;
  ctx.beginPath();
  if (!region.logY && y0 < 0 && y1 > 0) {
    const [, py] = toPx(L, x0, 0);
    ctx.moveTo(L.left, Math.round(py) + 0.5);
    ctx.lineTo(L.left + L.width, Math.round(py) + 0.5);
  }
  if (!region.logX && x0 < 0 && x1 > 0) {
    const [px] = toPx(L, 0, y0);
    ctx.moveTo(Math.round(px) + 0.5, L.top);
    ctx.lineTo(Math.round(px) + 0.5, L.top + L.height);
  }
  ctx.stroke();
  ctx.strokeRect(L.left + 0.5, L.top + 0.5, L.width, L.height);
  // tick labels
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of xt) {
    const [px] = toPx(L, t, y0);
    ctx.fillText(fmtTick(t), px, L.top + L.height + 4);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of yt) {
    const [, py] = toPx(L, x0, t);
    ctx.fillText(fmtTick(t), L.left - 5, py);
  }
  // axis labels
  ctx.fillStyle = theme.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(truncate(ctx, data.xLabel, L.width), L.left + L.width / 2, h - 3);
  if (region.title) {
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(truncate(ctx, region.title, w - 20), w / 2, 4);
    ctx.font = '11px system-ui, sans-serif';
  }
  // series
  ctx.save();
  ctx.beginPath();
  ctx.rect(L.left, L.top, L.width, L.height);
  ctx.clip();
  data.series.forEach((s, k) => {
    const color = s.color || SERIES_COLORS[k % SERIES_COLORS.length];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.75;
    const pts: ([number, number] | null)[] = s.xs.map((x, i) => {
      const y = s.ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if ((region.logX && x <= 0) || (region.logY && y <= 0)) return null;
      return toPx(L, x, y);
    });
    if (s.style === 'line' || s.style === 'both' || s.style === 'step') {
      ctx.beginPath();
      let pen = false;
      let prev: [number, number] | null = null;
      for (const p of pts) {
        if (!p || Math.abs(p[1]) > 1e6) { pen = false; prev = null; continue; }
        if (!pen) ctx.moveTo(p[0], p[1]);
        else if (s.style === 'step' && prev) { ctx.lineTo(p[0], prev[1]); ctx.lineTo(p[0], p[1]); }
        else ctx.lineTo(p[0], p[1]);
        pen = true;
        prev = p;
      }
      ctx.stroke();
    }
    if (s.style === 'points' || s.style === 'both') {
      for (const p of pts) if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.6, 0, Math.PI * 2); ctx.fill(); }
    }
    if (s.style === 'bar') {
      const valid = pts.filter(Boolean) as [number, number][];
      const bw = Math.max(2, (L.width / Math.max(1, valid.length)) * 0.7);
      const [, base] = toPx(L, x0, region.logY ? y0 : Math.max(y0, Math.min(0, y1)));
      for (const p of valid) ctx.fillRect(p[0] - bw / 2, Math.min(p[1], base), bw, Math.abs(base - p[1]));
    }
  });
  ctx.restore();
  // legend
  if (data.series.length > 1) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let ly = L.top + 10;
    for (const [k, s] of data.series.entries()) {
      const color = s.color || SERIES_COLORS[k % SERIES_COLORS.length];
      const label = truncate(ctx, s.label, 140);
      const tw = ctx.measureText(label).width;
      const lx = L.left + L.width - tw - 30;
      ctx.fillStyle = theme.bg;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(lx - 4, ly - 7, tw + 30, 14);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillRect(lx, ly - 1.5, 16, 3);
      ctx.fillStyle = theme.fg;
      ctx.fillText(label, lx + 21, ly);
      ly += 15;
    }
  }
  // y label (rotated)
  ctx.save();
  ctx.translate(12, L.top + L.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.fg;
  ctx.fillText(truncate(ctx, data.yLabel, L.height), 0, 0);
  ctx.restore();
  return L;
}

function truncate(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function drawPolar(ctx: CanvasRenderingContext2D, w: number, h: number, data: PlotResult, theme: Theme) {
  const rMax = Math.max(1e-12, ...data.series.flatMap((s) => finite(s.ys).map(Math.abs)));
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2 - 22;
  const ticks = niceTicks(0, rMax, 4).filter((t) => t > 0);
  const scale = R / (ticks[ticks.length - 1] ?? rMax);
  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (const t of ticks) {
    ctx.beginPath();
    ctx.arc(cx, cy, t * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(fmtTick(t), cx + t * scale * Math.cos(-Math.PI / 8) + 2, cy + t * scale * Math.sin(-Math.PI / 8));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let a = 0; a < 360; a += 30) {
    const r = a * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(r), cy - R * Math.sin(r));
    ctx.stroke();
    ctx.fillText(`${a}°`, cx + (R + 12) * Math.cos(r), cy - (R + 12) * Math.sin(r));
  }
  data.series.forEach((s, k) => {
    ctx.strokeStyle = s.color || SERIES_COLORS[k % SERIES_COLORS.length];
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    let pen = false;
    s.xs.forEach((th, i) => {
      const r = s.ys[i];
      if (!Number.isFinite(th) || !Number.isFinite(r)) { pen = false; return; }
      const px = cx + r * scale * Math.cos(th), py = cy - r * scale * Math.sin(th);
      if (!pen) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      pen = true;
    });
    ctx.stroke();
  });
}

/** Perceptually ordered colormap (viridis-like). */
export function colormap(t: number): [number, number, number] {
  const stops: [number, number, number][] = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((c) => Math.round(stops[i][c] + f * (stops[i + 1][c] - stops[i][c]))) as [number, number, number];
}

function zRange(z: number[][]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const row of z) for (const v of row) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  return [lo, hi];
}

function drawSurface(ctx: CanvasRenderingContext2D, w: number, h: number, s: { xs: number[]; ys: number[]; z: number[][] }, theme: Theme, view: View) {
  const [zl, zh] = zRange(s.z);
  const [xl, xh] = [s.xs[0], s.xs[s.xs.length - 1]];
  const [yl, yh] = [s.ys[0], s.ys[s.ys.length - 1]];
  const nx = (x: number) => ((x - xl) / (xh - xl || 1)) * 2 - 1;
  const ny = (y: number) => ((y - yl) / (yh - yl || 1)) * 2 - 1;
  const nz = (z: number) => ((z - zl) / (zh - zl)) * 1.4 - 0.7;
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const S = Math.min(w, h) * 0.34;
  const project = (x: number, y: number, z: number): [number, number, number] => {
    const X = x * cy - y * sy;
    const Y = x * sy + y * cy;
    const Yr = Y * cp - z * sp;
    const Zr = Y * sp + z * cp;
    return [w / 2 + X * S, h / 2 + Zr * -S + 10, Yr];
  };
  // bounding box
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  ctx.beginPath();
  corners.forEach(([a, b], i) => {
    const p = project(a, b, -0.7);
    if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
  });
  ctx.closePath();
  ctx.stroke();
  type Quad = { d: number; pts: [number, number][]; c: number };
  const quads: Quad[] = [];
  for (let i = 0; i < s.xs.length - 1; i++) {
    for (let j = 0; j < s.ys.length - 1; j++) {
      const zs = [s.z[i][j], s.z[i + 1][j], s.z[i + 1][j + 1], s.z[i][j + 1]];
      if (!zs.every(Number.isFinite)) continue;
      const P = [
        project(nx(s.xs[i]), ny(s.ys[j]), nz(zs[0])),
        project(nx(s.xs[i + 1]), ny(s.ys[j]), nz(zs[1])),
        project(nx(s.xs[i + 1]), ny(s.ys[j + 1]), nz(zs[2])),
        project(nx(s.xs[i]), ny(s.ys[j + 1]), nz(zs[3])),
      ];
      quads.push({ d: P.reduce((a, p) => a + p[2], 0) / 4, pts: P.map((p) => [p[0], p[1]] as [number, number]), c: (zs.reduce((a, b) => a + b, 0) / 4 - zl) / (zh - zl) });
    }
  }
  quads.sort((a, b) => b.d - a.d);
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  for (const q of quads) {
    const [r, g, b] = colormap(q.c);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    q.pts.forEach((p, k) => (k === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // axis labels
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lx = project(1.25, -1, -0.7), ly = project(1, 1.25, -0.7);
  ctx.fillText('x', lx[0], lx[1]);
  ctx.fillText('y', ly[0], ly[1]);
  ctx.textAlign = 'left';
  ctx.fillText(`z: ${fmtTick(zl)} … ${fmtTick(zh)}`, 8, 12);
  ctx.textAlign = 'right';
  ctx.fillText('drag to rotate', w - 8, h - 10);
}

function drawContour(ctx: CanvasRenderingContext2D, w: number, h: number, s: { xs: number[]; ys: number[]; z: number[][] }, theme: Theme) {
  const L: Layout = { left: 48, top: 10, width: w - 48 - 60, height: h - 10 - 32, x0: s.xs[0], x1: s.xs[s.xs.length - 1], y0: s.ys[0], y1: s.ys[s.ys.length - 1], logX: false, logY: false };
  if (L.width < 20 || L.height < 20) return;
  const [zl, zh] = zRange(s.z);
  const nx = s.xs.length, ny = s.ys.length;
  // heat map
  const cw = L.width / (nx - 1), ch = L.height / (ny - 1);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const v = s.z[i][j];
      if (!Number.isFinite(v)) continue;
      const [r, g, b] = colormap((v - zl) / (zh - zl));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const [px, py] = toPx(L, s.xs[i], s.ys[j]);
      ctx.fillRect(px - cw / 2, py - ch / 2, cw + 1, ch + 1);
    }
  }
  // contour lines by marching squares
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1;
  const levels = niceTicks(zl, zh, 10);
  ctx.beginPath();
  for (const lv of levels) {
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < ny - 1; j++) {
        const c = [s.z[i][j], s.z[i + 1][j], s.z[i + 1][j + 1], s.z[i][j + 1]];
        if (!c.every(Number.isFinite)) continue;
        const P: [number, number][] = [[s.xs[i], s.ys[j]], [s.xs[i + 1], s.ys[j]], [s.xs[i + 1], s.ys[j + 1]], [s.xs[i], s.ys[j + 1]]];
        const cross: [number, number][] = [];
        for (let e = 0; e < 4; e++) {
          const a = c[e], b = c[(e + 1) % 4];
          if ((a < lv) !== (b < lv)) {
            const t = (lv - a) / (b - a);
            const pa = P[e], pb = P[(e + 1) % 4];
            cross.push([pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])]);
          }
        }
        for (let k = 0; k + 1 < cross.length; k += 2) {
          const [ax, ay] = toPx(L, cross[k][0], cross[k][1]);
          const [bx, by] = toPx(L, cross[k + 1][0], cross[k + 1][1]);
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
      }
    }
  }
  ctx.stroke();
  // axes
  ctx.strokeStyle = theme.muted;
  ctx.strokeRect(L.left + 0.5, L.top + 0.5, L.width, L.height);
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of niceTicks(L.x0, L.x1, 6)) ctx.fillText(fmtTick(t), toPx(L, t, L.y0)[0], L.top + L.height + 4);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of niceTicks(L.y0, L.y1, 5)) ctx.fillText(fmtTick(t), L.left - 5, toPx(L, L.x0, t)[1]);
  // colour bar
  const bx = L.left + L.width + 14;
  for (let k = 0; k < L.height; k++) {
    const [r, g, b] = colormap(1 - k / L.height);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(bx, L.top + k, 12, 1);
  }
  ctx.fillStyle = theme.muted;
  ctx.textAlign = 'left';
  ctx.fillText(fmtTick(zh), bx + 15, L.top + 4);
  ctx.fillText(fmtTick(zl), bx + 15, L.top + L.height - 4);
}
