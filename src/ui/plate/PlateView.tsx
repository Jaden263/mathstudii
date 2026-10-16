// A plate on the page: its plan with supports, walls, columns and loads, and the results as
// banded contours with a legend and the largest and least values marked, the mesh, the
// reactions along the supports, a section cut plotted under the plan, and the deflected
// shape in an oblique view; hover anywhere for the values there. Double-click to edit: the
// wheel zooms, Shift or the right button pans, the cut tool draws a section, and the
// tables of the outline, openings, supports and loads open under the view.
import { useEffect, useMemo, useRef, useState, type Dispatch, type JSX } from 'react';
import { Check, Grid3x3, Maximize, Scissors, Box, Tag } from 'lucide-react';
import type { PlateRegion } from '../../model/types';
import type { RegionResult } from '../../engine/evaluator';
import type { PlateResult } from '../../plate/evaluate';
import { edgeName, removePlateItems, type PlateShow } from '../../plate/model';
import { PlateSampler } from '../../plate/sample';
import type { Pt } from '../../plate/cdt';
import type { Action } from '../store';
import { useSketchUI } from '../sketch/context';
import { FORCE_N, LENGTH_M, fmt, units } from '../beam/beamDraw';
import { basisOf } from '../frame3d/frame3dDraw';
import { bandPaths, colorOf, displayUnit, extremesOf, fieldInfo, fieldOf, FIELDS, levelText, makeScale, meshPath, niceStep, zeroLine, type FieldInfo, type Scale } from './plateDraw';
import { PlateTables } from './PlateTables';

interface Props {
  region: PlateRegion;
  result?: RegionResult;
  editing: boolean;
  selected: boolean;
  dispatch: Dispatch<Action>;
  onDone: (moveBelow?: boolean) => void;
}

/** Height of the strip under the view, of the section plot, and of the tables while editing. */
const STRIP = 34;
const CUT_H = 130;
const TABLES_H = 300;
/** Room for the legend at the right, and round the plate for the support symbols. */
const LEGEND_W = 92;
const PAD = 22;

const BASIC: PlateShow[] = ['model', 'w', 'mx', 'my', 'mxy', 'vx', 'vy'];

/** The page is dark (system setting or the app's theme). */
function useDark(): boolean {
  const read = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const on = () => setDark(read());
    mq?.addEventListener('change', on);
    return () => {
      obs.disconnect();
      mq?.removeEventListener('change', on);
    };
  }, []);
  return dark;
}

/** Plain-number corners of the outline (to draw while it has errors). */
function plainOutline(r: PlateRegion): Pt[] {
  const k = LENGTH_M[r.lengthUnit] ?? 1;
  return r.outline.map((p) => [Number(p.x) * k, Number(p.y) * k] as Pt).filter((p) => p.every(Number.isFinite));
}

const pts = (list: [number, number][]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

type Hover = { x: number; y: number; title: string; lines: string[] };

export function PlateView({ region, result, editing, selected: regionSelected, dispatch, onDone }: Props) {
  const { ui, setUi, separate } = useSketchUI();
  const res = result?.kind === 'plate' ? (result as PlateResult) : undefined;
  const dark = useDark();
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [cutTool, setCutTool] = useState(false);
  const [side, setSide] = useState<'max' | 'min' | null>(null);
  const [cam, setCam] = useState({ yaw: -30, pitch: 32 });
  const [liveView, setLiveView] = useState<{ cx: number; cy: number; zoom: number } | null>(null);
  const [liveCut, setLiveCut] = useState<PlateRegion['cut'] | null>(null);
  const drag = useRef<{ x: number; y: number; mode: 'pan' | 'cut' | 'orbit'; start: Pt; view: { cx: number; cy: number; zoom: number }; cam: { yaw: number; pitch: number }; moved: boolean } | null>(null);
  const mine = ui.regionId === region.id;
  const sel = useMemo(() => new Set(mine ? ui.selected : []), [mine, ui.selected]);
  const u = units(region), Lm = LENGTH_M[region.lengthUnit] ?? 1, FN = FORCE_N[region.forceUnit] ?? 1e3;
  const set = (patch: Partial<PlateRegion>, history = true) => dispatch({ type: 'update', id: region.id, patch, ...(history ? {} : { history: false as const }) });

  useEffect(() => {
    if (!editing) {
      setHover(null);
      setCutTool(false);
    } else wrapRef.current?.focus({ preventScroll: true });
  }, [editing]);

  // ------------------------------------------------------------ what is shown
  const show: PlateShow = region.show ?? 'model';
  const info = fieldInfo(show);
  const available = (f: FieldInfo) => (!f.needs || (f.needs === 'rebar' ? !!res?.fields?.mxb : !!res?.fields?.sigma));
  const fi = info && available(info) ? info : undefined;
  const envelope = !!res?.lower;
  const shownSide: 'max' | 'min' = envelope ? side ?? fi?.side ?? 'max' : 'max';
  const field = fi ? fieldOf(res, fi.key, shownSide) : undefined;
  const perCorner = fi?.key !== 'w';
  const du = fi ? displayUnit(region, fi.kind) : null;
  const mesh = res?.mesh;
  const sampler = useMemo(() => (mesh ? new PlateSampler(mesh) : null), [mesh]);
  const cut = liveCut ?? region.cut;
  const showCut = !!cut && !!field && !region.deformed;
  const W = region.width, H = Math.max(120, region.height - STRIP - (showCut ? CUT_H : 0));

  const scale: Scale | null = useMemo(() => {
    if (!field || !du) return null;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < field.length; i++) {
      lo = Math.min(lo, field[i]);
      hi = Math.max(hi, field[i]);
    }
    return makeScale(lo * du.k, hi * du.k, dark);
  }, [field, du?.k, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ the plan's frame
  const outline = res?.outline.length ? res.outline : plainOutline(region);
  const box = useMemo(() => {
    const all = outline.length ? outline : [[0, 0], [6 * Lm, 4 * Lm]] as Pt[];
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }, [outline, Lm]);
  const legendW = scale ? LEGEND_W : 0;
  const availW = Math.max(40, W - legendW - 2 * PAD), availH = Math.max(40, H - 2 * PAD);
  const s0 = Math.min(availW / Math.max(box.x1 - box.x0, 1e-6), availH / Math.max(box.y1 - box.y0, 1e-6));
  const view = liveView ?? { cx: region.view?.cx ?? (box.x0 + box.x1) / 2 / Lm, cy: region.view?.cy ?? (box.y0 + box.y1) / 2 / Lm, zoom: region.view?.zoom ?? 1 };
  const sc = s0 * view.zoom;
  const ox = PAD + availW / 2, oy = PAD + availH / 2;
  const P = (x: number, y: number): [number, number] => [ox + (x - view.cx * Lm) * sc, oy - (y - view.cy * Lm) * sc];
  const toWorld = (px: number, py: number): Pt => [(px - ox) / sc + view.cx * Lm, -(py - oy) / sc + view.cy * Lm];

  // the deflected shape: an oblique view of (x, y, −w f)
  const deformed = region.deformed && res?.fields && mesh ? (() => {
    const w = res.fields.w;
    let wmax = 0;
    for (let i = 0; i < w.length; i++) wmax = Math.max(wmax, Math.abs(w[i]));
    const span = Math.hypot(box.x1 - box.x0, box.y1 - box.y0);
    const f = wmax > 0 ? (0.12 * span) / wmax : 0;
    const b = basisOf({ ...cam, zoom: 1, panX: 0, panY: 0 });
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const proj = (x: number, y: number, z: number) => {
      const d = [x - cx, y - cy, z];
      return { x: d[0] * b.r[0] + d[1] * b.r[1] + d[2] * b.r[2], y: -(d[0] * b.u[0] + d[1] * b.u[1] + d[2] * b.u[2]), depth: d[0] * b.e[0] + d[1] * b.e[1] + d[2] * b.e[2] };
    };
    // fit the projected undeformed outline and the deflected surface
    const raw: { x: number; y: number; depth: number }[] = [];
    for (let i = 0; i < mesh.x.length; i++) raw.push(proj(mesh.x[i], mesh.y[i], -w[i] * f));
    const flat = outline.map((p) => proj(p[0], p[1], 0));
    const all = [...raw, ...flat];
    const xs0 = Math.min(...all.map((p) => p.x)), xs1 = Math.max(...all.map((p) => p.x)), ys0 = Math.min(...all.map((p) => p.y)), ys1 = Math.max(...all.map((p) => p.y));
    const k = Math.min(availW / Math.max(xs1 - xs0, 1e-6), availH / Math.max(ys1 - ys0, 1e-6)) * view.zoom;
    const tx = (p: { x: number; y: number }): [number, number] => [ox + (p.x - (xs0 + xs1) / 2) * k, oy + (p.y - (ys0 + ys1) / 2) * k];
    return { f, raw, flat: flat.map(tx), tx };
  })() : null;

  // ------------------------------------------------------------ results drawn
  const bands = useMemo(() => {
    if (!field || !scale || !mesh || !du || region.deformed) return null;
    return bandPaths(mesh, field, perCorner, du.k, scale, P);
  }, [field, scale, mesh, du?.k, perCorner, region.deformed, sc, view.cx, view.cy, ox, oy]); // eslint-disable-line react-hooks/exhaustive-deps
  const zero = useMemo(() => (field && mesh && scale?.diverging && !region.deformed ? zeroLine(mesh, field, perCorner, P) : ''), [bands]); // eslint-disable-line react-hooks/exhaustive-deps
  const meshD = useMemo(() => (mesh && region.showMesh && !region.deformed ? meshPath(mesh, P) : ''), [mesh, region.showMesh, region.deformed, sc, view.cx, view.cy, ox, oy]); // eslint-disable-line react-hooks/exhaustive-deps
  const ext = field && mesh ? extremesOf(mesh, field, perCorner) : null;

  // ------------------------------------------------------------ model glyphs
  const orient = outline.reduce((s, p, i) => s + p[0] * outline[(i + 1) % outline.length][1] - outline[(i + 1) % outline.length][0] * p[1], 0) >= 0 ? 1 : -1;
  const errId = new Set(Object.keys(res?.errors ?? {}));
  const lc = region.loadCases;
  const fadedLoad = (c?: string) => {
    if (!lc || !res?.view || res.view === 'envelope') return false;
    if (lc.cases.some((q) => q.id === res.view)) return c !== res.view;
    const f = lc.combos.find((q) => q.id === res.view)?.factors[c ?? lc.cases[0]?.id ?? '']?.trim();
    return !f || f === '0';
  };
  const faint = show !== 'model';
  const plateD = [outline, ...(res?.openings.map((o) => o.points) ?? [])].filter((p) => p.length >= 3).map((poly) => `M${poly.map((p) => P(p[0], p[1]).map((v) => v.toFixed(1)).join(' ')).join('L')}Z`).join('');
  const edgeGlyphs = region.deformed ? null : outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length], ed = region.edges[i];
    const [ax, ay] = P(a[0], a[1]), [bx, by] = P(b[0], b[1]);
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1) return null;
    // outward normal on the screen (y down): the polygon's right side when it runs counter-clockwise
    const tx = (bx - ax) / L, ty = (by - ay) / L, nx = -ty * orient, ny = tx * orient;
    const id = `edge:${i}`, cls = `pl-edge ${ed?.support ?? 'free'}${sel.has(id) ? ' sel' : ''}${errId.has(id) ? ' err' : ''}`;
    const out: JSX.Element[] = [];
    if (ed?.support === 'simple' || ed?.support === 'clamped') {
      const off = 3, len = ed.support === 'clamped' ? 7 : 5;
      const d: string[] = [`M${ax + nx * off} ${ay + ny * off}L${bx + nx * off} ${by + ny * off}`];
      for (let s = 4; s < L - 2; s += ed.support === 'clamped' ? 5 : 8) {
        const px = ax + tx * s + nx * off, py = ay + ty * s + ny * off;
        d.push(`M${px.toFixed(1)} ${py.toFixed(1)}L${(px + nx * len - tx * len * 0.7).toFixed(1)} ${(py + ny * len - ty * len * 0.7).toFixed(1)}`);
      }
      out.push(<path key="h" d={d.join('')} />);
    } else if (ed?.support === 'spring') {
      const d: string[] = [];
      const n = Math.max(4, Math.floor(L / 7));
      for (let k = 0; k <= n; k++) {
        const s = (k / n) * L, o = 4 + (k % 2 ? 4 : 0);
        d.push(`${k ? 'L' : 'M'}${(ax + tx * s + nx * o).toFixed(1)} ${(ay + ty * s + ny * o).toFixed(1)}`);
      }
      out.push(<path key="z" d={d.join('')} />);
    }
    return (
      <g key={id} className={cls}>
        {out}
        {region.labels !== false && editing && (outline.length <= 12 || sel.has(id)) && <text x={(ax + bx) / 2 + nx * 16} y={(ay + by) / 2 + ny * 16 + 4} textAnchor="middle" className="pl-name">{edgeName(i)}</text>}
      </g>
    );
  });
  const wallGlyphs = region.deformed ? null : res?.walls.map((w) => {
    const [ax, ay] = P(w.a[0], w.a[1]), [bx, by] = P(w.b[0], w.b[1]);
    const name = region.walls.find((q) => q.id === w.id)?.name;
    return (
      <g key={w.id} className={`pl-wall${sel.has(w.id) ? ' sel' : ''}${errId.has(w.id) ? ' err' : ''}`}>
        <line x1={ax} y1={ay} x2={bx} y2={by} />
        {name && editing && <text x={(ax + bx) / 2 + 6} y={(ay + by) / 2 - 6} className="pl-name">{name}</text>}
      </g>
    );
  });
  const columnGlyphs = region.deformed ? null : res?.columns.map((c) => {
    const name = region.columns.find((q) => q.id === c.id)?.name;
    const [x, y] = P(c.at[0], c.at[1]);
    const cls = `pl-column${sel.has(c.id) ? ' sel' : ''}${errId.has(c.id) ? ' err' : ''}`;
    return (
      <g key={c.id} className={cls}>
        {c.head ? <polygon points={pts(c.head.map((p) => P(p[0], p[1])))} /> : <rect x={x - 4} y={y - 4} width={8} height={8} />}
        {name && editing && <text x={x + 7} y={y - 7} className="pl-name">{name}</text>}
      </g>
    );
  });
  const loadGlyphs = show === 'model' && res && !region.deformed ? res.loads.map((l) => {
    const cls = `pl-load${fadedLoad(l.case) ? ' faded' : ''}${sel.has(l.id) ? ' sel' : ''}${errId.has(l.id) ? ' err' : ''}`;
    const tag = lc && l.case ? ` (${lc.cases.find((c) => c.id === l.case)?.name ?? ''})` : '';
    const area = (q: number) => `${fmt(q / (FN / (Lm * Lm)))} ${region.forceUnit}/${region.lengthUnit}²`;
    if (l.kind === 'patch') {
      const poly = l.poly.map((p) => P(p[0], p[1]));
      return (
        <g key={l.id} className={cls}>
          <polygon points={pts(poly)} className="pl-patch" />
          <text x={(poly[0][0] + poly[2][0]) / 2} y={(poly[0][1] + poly[2][1]) / 2 + 4} textAnchor="middle" className="pl-load-label">{area(l.q)}{tag}</text>
        </g>
      );
    }
    if (l.kind === 'line') {
      const [ax, ay] = P(l.a[0], l.a[1]), [bx, by] = P(l.b[0], l.b[1]);
      const L = Math.hypot(bx - ax, by - ay), n = Math.max(2, Math.floor(L / 14));
      const ticks = Array.from({ length: n + 1 }, (_, k) => [ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
      return (
        <g key={l.id} className={cls}>
          <line x1={ax} y1={ay} x2={bx} y2={by} className="pl-line-load" />
          {ticks.map(([x, y], k) => <circle key={k} cx={x} cy={y} r={1.6} />)}
          <text x={(ax + bx) / 2 + 5} y={(ay + by) / 2 - 6} className="pl-load-label">{u.line(l.q)}{tag}</text>
        </g>
      );
    }
    if (l.kind === 'point') {
      const [x, y] = P(l.at[0], l.at[1]);
      return (
        <g key={l.id} className={cls}>
          <circle cx={x} cy={y} r={6} className="pl-point" />
          <path d={`M${x - 4.2} ${y - 4.2}L${x + 4.2} ${y + 4.2}M${x + 4.2} ${y - 4.2}L${x - 4.2} ${y + 4.2}`} />
          <text x={x + 9} y={y - 8} className="pl-load-label">{u.force(l.F)}{tag}</text>
        </g>
      );
    }
    return null;
  }) : null;
  const areaLoads = show === 'model' && res ? res.loads.filter((l): l is Extract<PlateResult['loads'][number], { kind: 'area' | 'self' }> => l.kind === 'area' || l.kind === 'self') : [];

  // reactions along the supports, outwards, and at the columns
  const reactionGlyphs = region.reactions && res?.reactions && !region.deformed ? (() => {
    const out: JSX.Element[] = [];
    let rmax = 0;
    for (const q of res.reactions) for (const v of q.r ?? []) if (Number.isFinite(v)) rmax = Math.max(rmax, Math.abs(v));
    const k = rmax > 0 ? 26 / rmax : 0;
    for (const q of res.reactions) {
      if (q.kind === 'column') {
        const c = res.columns.find((x) => x.id === q.id);
        if (!c) continue;
        const [x, y] = P(c.at[0], c.at[1]);
        out.push(<text key={q.id} x={x + 8} y={y + 14} className="pl-reaction-label">{u.force(q.R)}</text>);
        continue;
      }
      if (!q.r || !q.s || !q.a || !q.b) continue;
      const [ax, ay] = P(q.a[0], q.a[1]), [bx, by] = P(q.b[0], q.b[1]);
      const L = Math.hypot(bx - ax, by - ay), len = q.s[q.s.length - 1] || 1;
      if (L < 1) continue;
      const tx = (bx - ax) / L, ty = (by - ay) / L;
      // walls: drawn to one side; edges: outwards
      const nx = q.kind === 'edge' ? -ty * orient : -ty, ny = q.kind === 'edge' ? tx * orient : tx;
      const line = q.s.map((s, i) => [ax + tx * (s / len) * L + nx * (6 + q.r![i] * k), ay + ty * (s / len) * L + ny * (6 + q.r![i] * k)] as [number, number]);
      const base = q.s.map((s) => [ax + tx * (s / len) * L + nx * 6, ay + ty * (s / len) * L + ny * 6] as [number, number]);
      out.push(<polygon key={q.id} points={pts([...line, ...base.reverse()])} className="pl-reaction" />);
      let im = 0;
      q.r.forEach((v, i) => { if (Math.abs(v) > Math.abs(q.r![im])) im = i; });
      out.push(<text key={`${q.id}t`} x={line[im][0] + nx * 8} y={line[im][1] + ny * 8 + 4} textAnchor="middle" className="pl-reaction-label">{u.line(q.r[im])}</text>);
    }
    return out;
  })() : null;

  // largest and least values
  const markers = ext && du && !region.deformed ? (['max', 'min'] as const).map((which) => {
    const e = ext[which];
    if (!Number.isFinite(e.v) || (which === 'min' && !scale?.diverging && Math.abs(e.v) < 1e-9 * Math.abs(ext.max.v))) return null;
    if (which === 'max' && !scale?.diverging && fi?.side === 'min') return null;
    const [x, y] = P(e.at[0], e.at[1]);
    const d = which === 'max' ? `M${x} ${y - 1}l-4.5 -8h9z` : `M${x} ${y + 1}l-4.5 8h9z`;
    return (
      <g key={which} className="pl-marker">
        <path d={d} />
        <text x={x + 7} y={which === 'max' ? y - 6 : y + 14} className="pl-value">{which} {levelText(e.v * du.k)}</text>
      </g>
    );
  }) : null;

  // the section cut on the plan
  const cutGlyph = cut && !region.deformed ? (() => {
    const [ax, ay] = P(cut.x1 * Lm, cut.y1 * Lm), [bx, by] = P(cut.x2 * Lm, cut.y2 * Lm);
    return (
      <g className="pl-cut">
        <line x1={ax} y1={ay} x2={bx} y2={by} />
        <circle cx={ax} cy={ay} r={3} />
        <circle cx={bx} cy={by} r={3} />
        <text x={ax - 6} y={ay - 6} textAnchor="end" className="pl-name">A</text>
        <text x={bx + 6} y={by - 6} className="pl-name">B</text>
      </g>
    );
  })() : null;

  // ------------------------------------------------------------ the legend
  const legend = scale && du && fi ? (() => {
    const nb = scale.colors.length, top = 38, h = Math.min(H - top - 24, Math.max(nb * 13, 120)), bh = h / nb, x = W - LEGEND_W + 10;
    return (
      <g className="pl-legend">
        <text x={x} y={14} className="pl-legend-title">{fi.label}{envelope ? ` ${shownSide}` : ''}</text>
        <text x={x} y={26} className="pl-legend-unit">[{du.unit}]</text>
        {scale.colors.map((c, i) => <rect key={i} x={x} y={top + (nb - 1 - i) * bh} width={14} height={bh + 0.5} fill={c} />)}
        <rect x={x} y={top} width={14} height={h} className="pl-legend-frame" />
        {scale.levels.map((l, i) => {
          // label every band edge, or every other one when they crowd
          const every = bh < 11 ? 2 : 1;
          if (i % every && i !== scale.levels.length - 1) return null;
          return <text key={i} x={x + 19} y={top + (nb - i) * bh + 3.5} className="pl-legend-label">{levelText(l)}</text>;
        })}
      </g>
    );
  })() : null;

  // ------------------------------------------------------------ the section cut plot
  const cutPlot = showCut && cut && sampler && field && du ? (() => {
    const L = Math.hypot(cut.x2 - cut.x1, cut.y2 - cut.y1);
    const n = 240, xs: number[] = [], vs: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = (cut.x1 + (cut.x2 - cut.x1) * t) * Lm, y = (cut.y1 + (cut.y2 - cut.y1) * t) * Lm;
      const s = sampler.locate(x, y);
      xs.push(t * L);
      vs.push(s ? du.k * (perCorner ? sampler.corner(field, s) : sampler.nodal(field, s)) : NaN);
    }
    const ok = vs.filter(Number.isFinite);
    if (!ok.length) return <div className="pl-cutplot hint">The section does not cross the plate.</div>;
    const lo = Math.min(0, ...ok), hi = Math.max(0, ...ok), pad = (hi - lo || 1) * 0.12;
    const left = 46, right = 12, top = 16, bottom = 22, pw = W - left - right, ph = CUT_H - top - bottom;
    const X = (s: number) => left + (s / (L || 1)) * pw, Y = (v: number) => top + ((hi + pad - v) / (hi - lo + 2 * pad)) * ph;
    // ticks at a tidy step, three to six of them, always through 0
    const step = niceStep((hi - lo) / 4 || 1), ticks: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * step; v += step) ticks.push(+v.toPrecision(12));
    const d: string[] = [];
    vs.forEach((v, i) => { if (Number.isFinite(v)) d.push(`${i && Number.isFinite(vs[i - 1]) ? 'L' : 'M'}${X(xs[i]).toFixed(1)} ${Y(v).toFixed(1)}`); });
    let imax = -1, imin = -1;
    vs.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      if (imax < 0 || v > vs[imax]) imax = i;
      if (imin < 0 || v < vs[imin]) imin = i;
    });
    return (
      <svg className="pl-cutplot" width={W} height={CUT_H} role="img" aria-label={`${fi!.label} along the section A–B`}>
        <text x={left} y={11} className="pl-legend-title">{fi!.label} along A–B [{du.unit}]</text>
        <line x1={left} y1={Y(0)} x2={left + pw} y2={Y(0)} className="pl-axis" />
        <line x1={left} y1={top} x2={left} y2={top + ph} className="pl-axis" />
        {ticks.map((v) => (
          <g key={v}>
            <line x1={left - 3} y1={Y(v)} x2={left} y2={Y(v)} className="pl-axis" />
            <text x={left - 5} y={Y(v) + 3.5} textAnchor="end" className="pl-tick">{levelText(v)}</text>
          </g>
        ))}
        <text x={left} y={CUT_H - 6} className="pl-tick">A</text>
        <text x={left + pw} y={CUT_H - 6} textAnchor="end" className="pl-tick">B · {fmt(L)} {region.lengthUnit}</text>
        <path d={d.join('')} className="pl-cut-curve" />
        {[imax, imin].filter((i, k) => i >= 0 && (k === 0 || imin !== imax) && Math.abs(vs[i]) > 0).map((i) => (
          <text key={i} x={X(xs[i])} y={Y(vs[i]) + (vs[i] >= 0 ? -5 : 13)} textAnchor="middle" className="pl-value">{levelText(vs[i])}</text>
        ))}
      </svg>
    );
  })() : null;

  // ------------------------------------------------------------ pointer: pick, pan, zoom, cut, hover
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H };
  };
  const pick = (p: { x: number; y: number }): string | null => {
    let best: string | null = null, bd = 8;
    const seg = (a: Pt, b: Pt, id: string) => {
      const [ax, ay] = P(a[0], a[1]), [bx, by] = P(b[0], b[1]);
      const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / L2)) : 0;
      const d = Math.hypot(p.x - ax - (bx - ax) * t, p.y - ay - (by - ay) * t);
      if (d < bd) { bd = d; best = id; }
    };
    for (const c of res?.columns ?? []) {
      const [x, y] = P(c.at[0], c.at[1]);
      const d = Math.hypot(p.x - x, p.y - y) - 4;
      if (d < bd) { bd = d; best = c.id; }
    }
    for (const l of res?.loads ?? []) {
      if (l.kind === 'point') {
        const [x, y] = P(l.at[0], l.at[1]);
        const d = Math.hypot(p.x - x, p.y - y) - 4;
        if (d < bd) { bd = d; best = l.id; }
      } else if (l.kind === 'line') seg(l.a, l.b, l.id);
      else if (l.kind === 'patch') l.poly.forEach((q, i) => seg(q, l.poly[(i + 1) % 4], l.id));
    }
    for (const w of res?.walls ?? []) seg(w.a, w.b, w.id);
    outline.forEach((a, i) => seg(a, outline[(i + 1) % outline.length], `edge:${i}`));
    for (const o of res?.openings ?? []) o.points.forEach((a, i) => seg(a, o.points[(i + 1) % o.points.length], o.id));
    return best;
  };
  const describe = (p: { x: number; y: number }): Hover | null => {
    if (region.deformed || !sampler || !res?.fields) return null;
    const [x, y] = toWorld(p.x, p.y);
    const s = sampler.locate(x, y);
    if (!s) return null;
    const f = shownSide === 'min' && res.lower ? res.lower : res.fields;
    const mu = displayUnit(region, 'moment'), vu = displayUnit(region, 'shear'), wu = displayUnit(region, 'defl');
    const c = (a?: ArrayLike<number>) => (a ? sampler.corner(a, s) : NaN);
    const lines = [
      `w = ${fmt(sampler.nodal(f.w, s) * wu.k)} ${wu.unit}`,
      `mx = ${fmt(c(f.mx) * mu.k)}   my = ${fmt(c(f.my) * mu.k)}   mxy = ${fmt(c(f.mxy) * mu.k)} ${mu.unit}`,
      `vx = ${fmt(c(f.vx) * vu.k)}   vy = ${fmt(c(f.vy) * vu.k)} ${vu.unit}`,
    ];
    if (f.asxb) lines.push(`as bottom x ${fmt(c(f.asxb) * 1e4)} · y ${fmt(c(f.asyb) * 1e4)}, top x ${fmt(c(f.asxt) * 1e4)} · y ${fmt(c(f.asyt) * 1e4)} cm²/m`);
    if (f.sigma) lines.push(`σv = ${fmt(c(f.sigma) * 1e-6)} MPa`);
    return { x: p.x, y: p.y, title: `(${fmt(x / Lm)}, ${fmt(y / Lm)}) ${region.lengthUnit}${envelope ? ` · envelope ${shownSide}` : ''}`, lines };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!editing) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toSvg(e);
    const mode = region.deformed ? 'orbit' : cutTool && e.button === 0 && !e.shiftKey ? 'cut' : e.shiftKey || e.button === 1 || e.button === 2 ? 'pan' : 'pan';
    drag.current = { x: e.clientX, y: e.clientY, mode, start: toWorld(p.x, p.y), view, cam, moved: false };
    setHover(null);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = toSvg(e);
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      const rect = svgRef.current!.getBoundingClientRect(), k = W / rect.width;
      if (d.mode === 'orbit') setCam({ yaw: d.cam.yaw - dx * 0.5, pitch: Math.max(5, Math.min(90, d.cam.pitch + dy * 0.5)) });
      else if (d.mode === 'cut') {
        const q = toWorld(p.x, p.y);
        setLiveCut({ x1: d.start[0] / Lm, y1: d.start[1] / Lm, x2: q[0] / Lm, y2: q[1] / Lm });
      } else setLiveView({ ...d.view, cx: d.view.cx - (dx * k) / sc / Lm, cy: d.view.cy + (dy * k) / sc / Lm });
      return;
    }
    setHover(describe(p));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      if (d.mode === 'cut' && liveCut) {
        set({ cut: { x1: +liveCut.x1.toPrecision(6), y1: +liveCut.y1.toPrecision(6), x2: +liveCut.x2.toPrecision(6), y2: +liveCut.y2.toPrecision(6) } }, false);
        setLiveCut(null);
        setCutTool(false);
      } else if (d.mode === 'pan' && liveView) {
        set({ view: liveView }, false);
        setLiveView(null);
      }
      return;
    }
    // a click picks an item (and its table)
    const id = pick(toSvg(e));
    setUi({ regionId: region.id, selected: id ? [id] : [] });
    if (id) {
      const tab = id.startsWith('edge:') ? 'outline' : region.openings.some((o) => o.id === id) ? 'openings' : region.loads.some((l) => l.id === id) ? 'loads' : 'supports';
      set({ tab }, false);
    }
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !editing) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const f = Math.exp(-e.deltaY * 0.0015), zoom = Math.max(0.2, Math.min(40, v.zoom * f));
      const rect = el.getBoundingClientRect();
      const q = { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H };
      // the point under the cursor stays put
      const s1 = s0 * v.zoom, s2 = s0 * zoom;
      const wx = (q.x - ox) / s1 + v.cx * Lm, wy = -(q.y - oy) / s1 + v.cy * Lm;
      const next = { zoom, cx: (wx - (q.x - ox) / s2) / Lm, cy: (wy + (q.y - oy) / s2) / Lm };
      viewRef.current = next;
      setLiveView(next);
      window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => {
        set({ view: viewRef.current }, false);
        setLiveView(null);
      }, 250);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const viewRef = useRef(view);
  if (!liveView) viewRef.current = view;
  const wheelTimer = useRef(0);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (cutTool) setCutTool(false);
      else onDone(false);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && mine && ui.selected.length) {
      e.preventDefault();
      dispatch({ type: 'update', id: region.id, patch: removePlateItems(region, new Set(ui.selected)) });
      setUi({ selected: [] });
    }
  };

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const sheet = (e.currentTarget as HTMLElement).closest('.sheet') as HTMLElement | null;
    const pageZoom = sheet ? sheet.getBoundingClientRect().width / sheet.offsetWidth : 1;
    const start = { x: e.clientX, y: e.clientY, w: region.width, h: region.height };
    const move = (ev: PointerEvent) => {
      const w = Math.max(320, Math.round(start.w + (ev.clientX - start.x) / pageZoom));
      const h = Math.max(220, Math.round(start.h + (ev.clientY - start.y) / pageZoom));
      dispatch({ type: 'update', id: region.id, coalesce: `resize:${region.id}`, patch: { width: w, height: h } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      separate(`resize:${region.id}`);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ------------------------------------------------------------ the deflected shape
  const deformedGlyphs = deformed && mesh && res?.fields ? (() => {
    const { raw, tx } = deformed;
    const q = mesh.quads, ne = q.length / 4;
    const colorField = field && scale && du ? field : null;
    const wScale = !colorField ? makeScale(0, Math.max(...Array.from(res.fields.w)) * 1000, dark) : null;
    const order = Array.from({ length: ne }, (_, e) => e).sort((a, b) => {
      const da = raw[q[4 * a]].depth + raw[q[4 * a + 2]].depth, db = raw[q[4 * b]].depth + raw[q[4 * b + 2]].depth;
      return da - db;
    });
    return order.map((e) => {
      const ps = [0, 1, 2, 3].map((c) => tx(raw[q[4 * e + c]]));
      let v = 0;
      for (let c = 0; c < 4; c++) v += colorField ? (perCorner ? colorField[4 * e + c] : colorField[q[4 * e + c]]) / 4 : res.fields!.w[q[4 * e + c]] / 4;
      const fill = colorField ? colorOf(scale!, v * du!.k) : colorOf(wScale!, v * 1000);
      return <polygon key={e} points={pts(ps)} fill={fill} className="pl-face" />;
    });
  })() : null;

  // ------------------------------------------------------------ render
  const strip = (
    <div className="f3-strip pl-strip" role="toolbar" aria-label="Results shown" onPointerDown={(e) => e.stopPropagation()}>
      {lc && (
        <select className="f3-view" aria-label="Load case, combination or envelope shown" value={res?.view ?? lc.view ?? ''} title="Show one load case, one combination, or the envelope of the combinations"
          onChange={(e) => set({ loadCases: { ...lc, view: e.target.value } }, false)}>
          <optgroup label="Combinations">
            {lc.combos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            {lc.combos.length > 1 && <option value="envelope">Envelope (min / max)</option>}
          </optgroup>
          <optgroup label="Load cases">
            {lc.cases.map((c) => <option key={c.id} value={c.id}>{c.name}{c.label ? ` · ${c.label}` : ''}</option>)}
          </optgroup>
        </select>
      )}
      <span className="bm-seg f3-shows">
        {BASIC.map((id) => {
          const f = fieldInfo(id);
          return (
            <button key={id} className={show === id ? 'on' : ''} aria-pressed={show === id} disabled={id !== 'model' && !res?.fields}
              title={f?.title ?? 'The plate, its supports and loads'} onClick={() => set({ show: id }, false)}>{f?.label ?? 'Model'}</button>
          );
        })}
      </span>
      <select className={`f3-view pl-more${!BASIC.includes(show) ? ' on' : ''}`} aria-label="More results" value={BASIC.includes(show) ? '' : show} disabled={!res?.fields}
        onChange={(e) => e.target.value && set({ show: e.target.value as PlateShow }, false)} title="Principal moments, Wood–Armer design moments, reinforcement, stress">
        <option value="">More…</option>
        {FIELDS.filter((f) => !BASIC.includes(f.id) && available(f)).map((f) => <option key={f.id} value={f.id}>{f.label} · {f.title}</option>)}
      </select>
      {envelope && fi && (
        <span className="bm-seg">
          {(['max', 'min'] as const).map((s2) => <button key={s2} className={shownSide === s2 ? 'on' : ''} aria-pressed={shownSide === s2} onClick={() => setSide(s2)} title={`The envelope's ${s2 === 'max' ? 'upper' : 'lower'} side`}>{s2}</button>)}
        </span>
      )}
      {res?.fields && (
        <>
          <button className={region.showMesh ? 'on' : ''} aria-pressed={!!region.showMesh} title="The element mesh" onClick={() => set({ showMesh: !region.showMesh }, false)}>Mesh</button>
          <button className={region.deformed ? 'on' : ''} aria-pressed={!!region.deformed} title="The deflected shape in an oblique view (drag to turn it while editing)" onClick={() => set({ deformed: !region.deformed }, false)}>3-D</button>
          <button className={region.reactions ? 'on' : ''} aria-pressed={!!region.reactions} title="Support reactions: per length along edges and walls, the columns' forces" onClick={() => set({ reactions: !region.reactions }, false)}>R</button>
          {region.cut && <button title="Remove the section cut" onClick={() => set({ cut: undefined }, false)}>✕ cut</button>}
        </>
      )}
    </div>
  );

  const summary = res?.fields && (
    <div className="f3-summary pl-summary">
      {deformed && deformed.f > 0 && <span>w × {fmt(deformed.f)}</span>}
      {res.mesh && <span>{res.mesh.quads.length / 4} elements{res.millis !== undefined && !res.cached ? ` · ${fmt(res.millis)} ms` : ''}</span>}
    </div>
  );

  return (
    <div ref={wrapRef} className={`f3-region pl-region${editing ? ' editing' : ''}`} style={{ width: W }} tabIndex={editing ? 0 : -1} onKeyDown={onKeyDown}>
      {editing && (
        <div className="sk-toolbar f3-toolbar" role="toolbar" aria-label="Plate view" onPointerDown={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Fit the plate into the view" aria-label="Fit" onClick={() => set({ view: undefined }, false)}><Maximize size={16} /></button>
          <button className={`icon-btn${cutTool ? ' on' : ''}`} title="Section cut: drag a line across the plate to plot the values along it" aria-label="Section cut" aria-pressed={cutTool} onClick={() => setCutTool(!cutTool)}><Scissors size={16} /></button>
          <button className={`icon-btn${region.showMesh ? ' on' : ''}`} title="The element mesh" aria-label="Mesh" aria-pressed={!!region.showMesh} onClick={() => set({ showMesh: !region.showMesh }, false)}><Grid3x3 size={16} /></button>
          <button className={`icon-btn${region.deformed ? ' on' : ''}`} title="Deflected shape (drag to turn it)" aria-label="Deflected shape" aria-pressed={!!region.deformed} onClick={() => set({ deformed: !region.deformed }, false)}><Box size={16} /></button>
          <button className={`icon-btn${region.labels !== false ? ' on' : ''}`} title="Names of edges, walls and columns" aria-label="Names" aria-pressed={region.labels !== false} onClick={() => set({ labels: region.labels === false ? undefined : false }, false)}><Tag size={16} /></button>
          <span className="sk-sep" />
          <button className="icon-btn" title="Done (Esc)" aria-label="Done" onClick={() => onDone(false)}><Check size={16} /></button>
        </div>
      )}
      <div className="f3-viewport" style={{ height: H }}>
        <svg
          ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="f3-svg pl-svg" role="img" aria-label={region.name ? `Plate ${region.name}` : 'Plate'}
          style={{ cursor: editing ? (cutTool ? 'crosshair' : region.deformed ? 'grab' : undefined) : undefined }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={() => { drag.current = null; setLiveView(null); setLiveCut(null); }}
          onPointerLeave={() => setHover(null)} onContextMenu={(e) => editing && e.preventDefault()}
        >
          {!region.deformed && <path d={plateD} className={`pl-plate${faint ? ' faint' : ''}`} fillRule="evenodd" />}
          {bands?.map((d, i) => d && <path key={i} d={d} fill={scale!.colors[i]} stroke={scale!.colors[i]} strokeWidth={0.6} />)}
          {zero && <path d={zero} className="pl-zero" />}
          {meshD && <path d={meshD} className="pl-mesh" />}
          {!region.deformed && <path d={plateD} className="pl-outline" fillRule="evenodd" />}
          {deformed && <polygon points={pts(deformed.flat)} className="pl-flat" />}
          {deformedGlyphs}
          {edgeGlyphs}
          {wallGlyphs}
          {columnGlyphs}
          {loadGlyphs}
          {reactionGlyphs}
          {cutGlyph}
          {markers}
          {legend}
          {areaLoads.length > 0 && (
            <text x={8} y={13} className="pl-load-label">
              {areaLoads.map((l) => `${l.kind === 'self' ? 'ρgt' : 'q'} ${fmt(l.q / (FN / (Lm * Lm)))}${lc && l.case ? ` ${lc.cases.find((c) => c.id === l.case)?.name ?? ''}` : ''}`).join(' · ')} {region.forceUnit}/{region.lengthUnit}²
            </text>
          )}
          {!outline.length && <text x={W / 2} y={H / 2} textAnchor="middle" className="f3-empty">Double-click to give the plate an outline</text>}
        </svg>
        {summary}
        {hover && (
          <div className="f3-tip" style={{ left: Math.min(hover.x + 14, W - 300), top: Math.min(hover.y + 12, H - 24 - hover.lines.length * 15) }}>
            <b>{hover.title}</b>
            {hover.lines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        {(res?.error || (res && Object.keys(res.errors).length > 0)) && (
          <div className="region-error f3-error" role="alert">{res.error ?? Object.values(res.errors)[0]}</div>
        )}
        {res?.design && res.design.over > 0 && !res.error && (
          <div className="region-error f3-error pl-warn" role="alert">μ &gt; μ_lim in places: the slab needs compression reinforcement or more depth there, and a_s there is not enough on its own</div>
        )}
      </div>
      {cutPlot}
      {strip}
      {editing && <PlateTables region={region} result={res} dispatch={dispatch} height={TABLES_H} />}
      {(editing || regionSelected) && <div className="resize-handle sk-resize f3-resize" style={{ top: region.height - 12 }} onPointerDown={startResize} title="Drag to resize" aria-label="Resize plate" />}
    </div>
  );
}
