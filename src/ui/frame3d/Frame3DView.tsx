// A 3-D frame on the page: an orbit view of the structure, its supports and loads, and
// the results (deformed shape, N, V_y, V_z, T, M_y, M_z in the members' own planes, the
// buckling mode), with values on hover. Double-click to edit: drag to orbit (Shift or
// the right button pans, the wheel zooms) and the tables of nodes, members, sections,
// supports and loads open under the view.
import { useEffect, useMemo, useRef, useState, type Dispatch, type JSX } from 'react';
import { Check, Maximize, Tag, Axis3d } from 'lucide-react';
import type { Frame3DRegion } from '../../model/types';
import type { RegionResult } from '../../engine/evaluator';
import type { Frame3DResult } from '../../frame3d/evaluate';
import { memberAt3, type ForceKey, type Vec3 } from '../../frame3d/solve';
import { DEFAULT_CAMERA, FORCE_SHOWS, removeFrameItems, type Frame3DCamera, type Frame3DShow } from '../../frame3d/model';
import type { Action } from '../store';
import { useSketchUI } from '../sketch/context';
import { LENGTH_M, fmt, fmtAlpha, units } from '../beam/beamDraw';
import { diagramDir, displacementScale, forceScale, makeView, niceFactor, nodePositions, project, screenDir, sphere, VIEWS } from './frame3dDraw';
import { Frame3DTables } from './Frame3DTables';

interface Props {
  region: Frame3DRegion;
  result?: RegionResult;
  editing: boolean;
  selected: boolean;
  dispatch: Dispatch<Action>;
  onDone: (moveBelow?: boolean) => void;
}

/** Height of the strip under the view. */
const STRIP = 34;
const TABLES_H = 300;

const SHOWS: { id: Frame3DShow; label: string; title: string }[] = [
  { id: 'model', label: 'Model', title: 'The structure, its supports and loads' },
  { id: 'deformed', label: 'δ', title: 'Deformed shape (exaggerated)' },
  { id: 'N', label: 'N', title: 'Axial force, tension positive' },
  { id: 'Vy', label: 'Vy', title: 'Shear force along the member’s y axis' },
  { id: 'Vz', label: 'Vz', title: 'Shear force along the member’s z axis' },
  { id: 'T', label: 'T', title: 'Torsion' },
  { id: 'My', label: 'My', title: 'Bending moment about y (strong axis), drawn on the tension side' },
  { id: 'Mz', label: 'Mz', title: 'Bending moment about z (weak axis), drawn on the tension side' },
  { id: 'mode', label: 'Buckling', title: 'Buckling mode (normalised) and its load factor α_cr' },
];

type Hover = { x: number; y: number; title: string; lines: string[] };

const pts = (list: { x: number; y: number }[]) => list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

export function Frame3DView({ region, result, editing, selected: regionSelected, dispatch, onDone }: Props) {
  const { ui, setUi, separate } = useSketchUI();
  const res = result?.kind === 'frame3d' ? (result as Frame3DResult) : undefined;
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [liveCam, setLiveCam] = useState<Frame3DCamera | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; cam: Frame3DCamera; pan: boolean; moved: boolean } | null>(null);
  const mine = ui.regionId === region.id;
  const sel = useMemo(() => new Set(mine ? ui.selected : []), [mine, ui.selected]);
  const u = units(region), Lm = LENGTH_M[region.lengthUnit] ?? 1;
  const set = (patch: Partial<Frame3DRegion>, history = true) => dispatch({ type: 'update', id: region.id, patch, ...(history ? {} : { history: false as const }) });

  const W = region.width, H = Math.max(80, region.height - STRIP);
  const cam = liveCam ?? region.camera ?? DEFAULT_CAMERA;
  const pos = useMemo(() => nodePositions(region, res), [region.nodes, region.lengthUnit, res]); // eslint-disable-line react-hooks/exhaustive-deps
  const sph = useMemo(() => sphere([...pos.values()]), [pos]);
  const v = makeView(cam, sph, W, H);
  const P = (p: Vec3) => project(v, p);

  useEffect(() => {
    if (!editing) setHover(null);
    else wrapRef.current?.focus({ preventScroll: true });
  }, [editing]);

  const sol = res?.solution, low = res?.lower;
  const show: Frame3DShow = region.show ?? 'model';
  const forceKey = (FORCE_SHOWS as string[]).includes(show) ? (show as ForceKey) : null;
  const modes = res?.buckling?.modes ?? [];
  const modeIndex = Math.min(Math.max(0, region.analysis?.mode ?? 0), Math.max(0, modes.length - 1));
  const mode = show === 'mode' ? modes[modeIndex] : undefined;
  const scaleK = region.scale ?? 1;

  // ------------------------------------------------------------ geometry on the screen

  const memberEnds = useMemo(() => region.members.flatMap((m) => {
    const a = pos.get(m.a), b = pos.get(m.b);
    return a && b ? [{ m, a, b }] : [];
  }), [region.members, pos]);
  const geometryOf = (id: string) => res?.geometry[id];

  // force diagrams: the stations offset across the member, a fixed share of the frame's size for the largest value
  const diagram = (() => {
    if (!forceKey || !sol) return null;
    const big = forceScale(forceKey, [sol, low]);
    if (!(big > 0)) return { paths: [] as JSX.Element[], big };
    const k = (0.14 * sph.R * scaleK) / big;
    const isMoment = forceKey === 'T' || forceKey === 'My' || forceKey === 'Mz';
    const label = (val: number) => (isMoment ? u.moment(val) : u.force(val));
    const paths: JSX.Element[] = [];
    const labels: { x: number; y: number; text: string; mag: number }[] = [];
    for (const [side, s] of [['max', sol], ['min', low]] as const) {
      if (!s) continue;
      for (const mr of s.members) {
        const geo = geometryOf(mr.id), m = region.members.find((q) => q.id === mr.id);
        const a = m && pos.get(m.a);
        if (!geo || !a) continue;
        const dir = diagramDir(forceKey, geo.axes), ex = geo.axes[0];
        const base = mr.s.map((x) => [a[0] + ex[0] * x, a[1] + ex[1] * x, a[2] + ex[2] * x] as Vec3);
        const tip = base.map((p, i) => [p[0] + dir[0] * mr[forceKey][i] * k, p[1] + dir[1] * mr[forceKey][i] * k, p[2] + dir[2] * mr[forceKey][i] * k] as Vec3);
        const sb = base.map(P), st = tip.map(P);
        paths.push(<polygon key={`${side}${mr.id}`} points={pts([...st, ...sb.slice().reverse()])} className={`f3-fill ${forceKey[0]}`} />);
        paths.push(<polyline key={`${side}${mr.id}c`} points={pts(st)} className={`f3-curve ${forceKey[0]}${side === 'min' ? ' low' : ''}`} />);
        // the member's extreme, labelled
        let best = -1;
        mr[forceKey].forEach((val, i) => { if (best < 0 || Math.abs(val) > Math.abs(mr[forceKey][best])) best = i; });
        const val = best >= 0 ? mr[forceKey][best] : 0;
        // (the lower bound's labels sit a line lower, clear of the upper's)
        if (Math.abs(val) > 1e-3 * big) labels.push({ x: st[best].x, y: st[best].y + (side === 'min' ? 13 : 0), text: label(val), mag: Math.abs(val) });
      }
    }
    // the largest few when there are many members
    labels.sort((p, q) => q.mag - p.mag);
    const shown = labels.slice(0, region.members.length > 40 ? 12 : 60);
    return {
      big, paths,
      labels: shown.map((l, i) => <text key={`l${i}`} x={l.x + 4} y={l.y - 4} className="f3-value">{l.text}</text>),
    };
  })();

  // the deformed shape or the buckling mode, a share of the frame's size for the largest displacement
  const deformed = (() => {
    if (show === 'deformed' && sol) {
      const big = displacementScale(sol);
      if (!(big > 0)) return null;
      const factor = niceFactor((0.1 * sph.R * scaleK) / big);
      return {
        factor,
        lines: sol.members.map((mr) => {
          const m = region.members.find((q) => q.id === mr.id), a = m && pos.get(m.a), geo = geometryOf(mr.id);
          if (!a || !geo) return null;
          const ex = geo.axes[0];
          return <polyline key={mr.id} className="f3-deformed" points={pts(mr.s.map((x, i) => P([a[0] + ex[0] * x + mr.ux[i] * factor, a[1] + ex[1] * x + mr.uy[i] * factor, a[2] + ex[2] * x + mr.uz[i] * factor])))} />;
        }),
      };
    }
    if (mode) {
      const k = 0.12 * sph.R * scaleK;
      return {
        factor: 0,
        lines: mode.members.map((ms) => {
          const m = region.members.find((q) => q.id === ms.id), a = m && pos.get(m.a), geo = geometryOf(ms.id);
          if (!a || !geo) return null;
          const ex = geo.axes[0];
          return <polyline key={ms.id} className="f3-deformed mode" points={pts(ms.s.map((x, i) => P([a[0] + ex[0] * x + ms.d[i][0] * k, a[1] + ex[1] * x + ms.d[i][1] * k, a[2] + ex[2] * x + ms.d[i][2] * k])))} />;
        }),
      };
    }
    return null;
  })();

  // ------------------------------------------------------------ pointer: orbit, pan, zoom, hover, pick

  const toSvg = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H };
  };
  const hit = (p: { x: number; y: number }): { kind: 'node' | 'member'; id: string; t: number } | null => {
    let best: { kind: 'node' | 'member'; id: string; t: number; d: number } | null = null;
    for (const n of region.nodes) {
      const q = pos.get(n.id);
      if (!q) continue;
      const s = P(q), d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < 8 && (!best || d < best.d)) best = { kind: 'node', id: n.id, t: 0, d: d - 3 };
    }
    for (const { m, a, b } of memberEnds) {
      const A = P(a), B = P(b), L2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - A.x) * (B.x - A.x) + (p.y - A.y) * (B.y - A.y)) / L2)) : 0;
      const d = Math.hypot(p.x - (A.x + (B.x - A.x) * t), p.y - (A.y + (B.y - A.y) * t));
      if (d < 7 && (!best || d < best.d)) best = { kind: 'member', id: m.id, t, d };
    }
    return best;
  };
  const describe = (h: { kind: 'node' | 'member'; id: string; t: number }, at: { x: number; y: number }): Hover | null => {
    if (h.kind === 'node') {
      const n = region.nodes.find((q) => q.id === h.id)!, p = pos.get(n.id)!;
      const lines = [`(${p.map((c) => fmt(c / Lm)).join(', ')}) ${region.lengthUnit}`];
      const d = sol?.nodes[n.id];
      if (d && show !== 'mode') lines.push(`u = (${d.slice(0, 3).map((c) => u.defl(c)).join(', ')})`);
      const r = sol?.reactions.find((q) => q.node === n.id);
      if (r && show !== 'mode') {
        lines.push(`R = (${r.F.map((c) => fmt(c / u.forceN)).join(', ')}) ${region.forceUnit}`);
        if (r.M.some((c) => c !== 0)) lines.push(`M = (${r.M.map((c) => fmt(c / (u.forceN * Lm))).join(', ')}) ${region.forceUnit}·${region.lengthUnit}`);
      }
      const sp = region.supports.find((q) => q.node === n.id);
      if (sp) lines.push(`support: ${sp.dofs.map((dd, c) => `${['ux', 'uy', 'uz', 'φx', 'φy', 'φz'][c]} ${dd === 'fixed' ? '■' : dd === 'free' || !dd ? '—' : dd}`).join('  ')}`);
      return { x: at.x, y: at.y, title: `Node ${n.name}`, lines };
    }
    const m = region.members.find((q) => q.id === h.id)!, geo = geometryOf(m.id);
    const secName = region.sections.find((q) => q.id === m.section);
    const title = `Member ${m.name} · ${secName?.profile ?? secName?.name ?? '?'}${geo ? ` · L = ${u.length(geo.L / Lm)}` : ''}`;
    const lines: string[] = [];
    const mr = sol?.members.find((q) => q.id === m.id);
    if (mr && geo && show !== 'mode') {
      const s = h.t * geo.L, val = memberAt3(mr, s);
      lines.push(`x = ${u.length(s / Lm)}`);
      lines.push(`N = ${u.force(val.N)}   Vy = ${u.force(val.Vy)}   Vz = ${u.force(val.Vz)}`);
      lines.push(`T = ${u.moment(val.T)}   My = ${u.moment(val.My)}   Mz = ${u.moment(val.Mz)}`);
      lines.push(`u = (${u.defl(val.ux)}, ${u.defl(val.uy)}, ${u.defl(val.uz)})`);
      if (low) {
        const lo = memberAt3(low.members.find((q) => q.id === m.id)!, s);
        lines.push(`min: N ${u.force(lo.N)}  My ${u.moment(lo.My)}  Mz ${u.moment(lo.Mz)}`);
      }
    } else if (mode) {
      lines.push(`α_cr = ${fmtAlpha(mode.alpha)} (mode ${modeIndex + 1})`);
      const L = res?.buckling?.Lcr[m.id];
      if (L) lines.push(`L_cr,y = ${u.length(L.y / Lm)}   L_cr,z = ${u.length(L.z / Lm)}`);
    }
    if (m.relA?.length || m.relB?.length) lines.push(`released: start ${m.relA?.join(' ') || '—'} · end ${m.relB?.join(' ') || '—'}`);
    return { x: at.x, y: at.y, title, lines };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!editing) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cam, pan: e.shiftKey || e.button === 1 || e.button === 2, moved: false };
    setHover(null);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      const rect = svgRef.current!.getBoundingClientRect();
      if (d.pan) setLiveCam({ ...d.cam, panX: d.cam.panX + dx / rect.width, panY: d.cam.panY + dy / rect.height });
      else setLiveCam({ ...d.cam, yaw: d.cam.yaw - dx * 0.5, pitch: Math.max(-90, Math.min(90, d.cam.pitch + dy * 0.5)) });
      return;
    }
    const p = toSvg(e), h = hit(p);
    setHot(h?.id ?? null);
    setHover(h ? describe(h, p) : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved && liveCam) {
      set({ camera: liveCam }, false);
      setLiveCam(null);
      return;
    }
    // a click picks a node or member (and its table)
    const h = hit(toSvg(e));
    setUi({ regionId: region.id, selected: h ? [h.id] : [] });
    if (h) set({ tab: h.kind === 'node' ? 'nodes' : 'members' }, false);
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el || !editing) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = liveCamRef.current ?? camRef.current;
      const f = Math.exp(-e.deltaY * 0.0015), zoom = Math.max(0.05, Math.min(50, c.zoom * f));
      const rect = el.getBoundingClientRect();
      const q = { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H };
      // the point under the cursor stays put
      const sx = W / 2 + c.panX * W, sy = H / 2 + c.panY * H, r = zoom / c.zoom;
      const next = { ...c, zoom, panX: (q.x - (q.x - sx) * r - W / 2) / W, panY: (q.y - (q.y - sy) * r - H / 2) / H };
      liveCamRef.current = next;
      setLiveCam(next);
      window.clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => {
        set({ camera: liveCamRef.current! }, false);
        liveCamRef.current = null;
        setLiveCam(null);
      }, 250);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const camRef = useRef(cam);
  camRef.current = region.camera ?? DEFAULT_CAMERA;
  const liveCamRef = useRef<Frame3DCamera | null>(null);
  const wheelTimer = useRef(0);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onDone(false);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && mine && ui.selected.length) {
      e.preventDefault();
      dispatch({ type: 'update', id: region.id, patch: removeFrameItems(region, new Set(ui.selected)) });
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

  // ------------------------------------------------------------ render

  const faintModel = show !== 'model';
  const sorted = memberEnds.map((q) => ({ ...q, A: P(q.a), B: P(q.b) })).sort((p, q) => p.A.depth + p.B.depth - q.A.depth - q.B.depth);
  const errId = new Set(Object.keys(res?.errors ?? {}));
  const lc = region.loadCases;
  const fadedLoad = (c?: string) => {
    if (!lc || !res?.view || res.view === 'envelope') return false;
    if (lc.cases.some((q) => q.id === res.view)) return c !== res.view;
    const f = lc.combos.find((q) => q.id === res.view)?.factors[c ?? lc.cases[0]?.id ?? '']?.trim();
    return !f || f === '0';
  };
  const empty = !region.nodes.length;
  const supportGlyphs = region.supports.map((sp) => {
    const p = pos.get(sp.node);
    if (!p) return null;
    const s = P(p);
    const held = sp.dofs.map((d) => d === 'fixed');
    const spring = sp.dofs.some((d) => d && d !== 'fixed' && d !== 'free');
    const trans = held.slice(0, 3).filter(Boolean).length, rot = held.slice(3).filter(Boolean).length;
    const g = sel.has(sp.id) ? ' sel' : '';
    return (
      <g key={sp.id} className={`f3-support${g}${errId.has(sp.id) ? ' err' : ''}`} transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)})`}>
        {trans > 0 && <path d="M0 0 L-7 11 L7 11 Z" className="f3-tri" />}
        {trans > 0 && trans < 3 && <><circle cx={-3.5} cy={14} r={2.2} /><circle cx={3.5} cy={14} r={2.2} /></>}
        {rot === 3 ? <rect x={-10} y={trans < 3 ? 17 : 11} width={20} height={5} className="f3-ground fixed" /> : <line x1={-10} y1={trans < 3 ? 17.5 : 12.5} x2={10} y2={trans < 3 ? 17.5 : 12.5} className="f3-ground" />}
        {rot > 0 && rot < 3 && <rect x={-3} y={-3} width={6} height={6} className="f3-rotheld" />}
        {spring && <path d="M10 -2 l3 3 l-6 3 l6 3 l-6 3 l3 3" className="f3-spring" />}
      </g>
    );
  });

  // a load arrow pointing at the screen point s along screen direction d (unit), length len
  const arrow = (key: string, s: { x: number; y: number }, d: { x: number; y: number }, len: number, cls: string, double = false) => {
    const tail = { x: s.x - d.x * len, y: s.y - d.y * len }, n = { x: -d.y, y: d.x }, h = 6;
    const head = (q: { x: number; y: number }) => `M${(q.x - d.x * h + n.x * 3.5).toFixed(1)} ${(q.y - d.y * h + n.y * 3.5).toFixed(1)} L${q.x.toFixed(1)} ${q.y.toFixed(1)} L${(q.x - d.x * h - n.x * 3.5).toFixed(1)} ${(q.y - d.y * h - n.y * 3.5).toFixed(1)}`;
    const mid = { x: s.x - d.x * (h + 1), y: s.y - d.y * (h + 1) };
    return (
      <g key={key} className={cls}>
        <line x1={tail.x} y1={tail.y} x2={s.x} y2={s.y} />
        <path d={head(s)} fill="none" />
        {double && <path d={head(mid)} fill="none" />}
      </g>
    );
  };
  const unitDir = (w: Vec3) => {
    const d = screenDir(v, w), l = Math.hypot(d.x, d.y);
    return l > 1e-6 ? { x: d.x / l, y: d.y / l, l } : null;
  };
  const loadGlyphs = show === 'model' && res ? (() => {
    const out: JSX.Element[] = [];
    let qmax = 0;
    for (const l of res.loads) if (l.kind === 'line') qmax = Math.max(qmax, Math.hypot(...l.q1), Math.hypot(...l.q2));
    // line loads on one member stack outwards (G and Q on a beam), self-weight stays at the member
    const stack = new Map<string, number>();
    // self-weight drawn once per member like any line load, but faint
    res.loads.forEach((l, i) => {
      const cls = `f3-load${fadedLoad(l.case) ? ' faded' : ''}${sel.has(l.id) ? ' sel' : ''}${errId.has(l.id) ? ' err' : ''}`;
      if (l.kind === 'node') {
        const p = pos.get(l.node);
        if (!p) return;
        const s = P(p);
        for (const [vec, isM] of [[l.F, false], [l.M, true]] as const) {
          const mag = Math.hypot(...vec);
          if (!(mag > 0)) continue;
          const d = unitDir(vec);
          if (!d) {
            out.push(<circle key={`${i}${isM}`} cx={s.x} cy={s.y} r={5} className={`${cls} f3-dot`} />);
            continue;
          }
          out.push(arrow(`${i}${isM}`, s, d, 34, cls, isM));
          out.push(<text key={`${i}${isM}t`} x={s.x - d.x * 38} y={s.y - d.y * 38 - 3} className="f3-load-label" textAnchor="middle">{isM ? u.moment(mag) : u.force(mag)}</text>);
        }
        return;
      }
      const m = region.members.find((q) => q.id === l.member), a = m && pos.get(m.a), b = m && pos.get(m.b);
      if (!a || !b) return;
      const at = (t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (l.kind === 'point') {
        const d = unitDir(l.F), s = P(at(l.t));
        if (!d) return;
        out.push(arrow(`${i}`, s, d, 34, cls, l.moment));
        out.push(<text key={`${i}t`} x={s.x - d.x * 38} y={s.y - d.y * 38 - 3} className="f3-load-label" textAnchor="middle">{l.moment ? u.moment(Math.hypot(...l.F)) : u.force(Math.hypot(...l.F))}</text>);
        return;
      }
      const self = !region.loads.some((q) => q.id === l.id && q.type !== 'self');
      const level = self ? 0 : stack.get(l.member) ?? 0;
      if (!self) stack.set(l.member, level + 1);
      const A = P(at(l.t1)), B = P(at(l.t2)), n = Math.max(2, Math.min(12, Math.round(Math.hypot(B.x - A.x, B.y - A.y) / 36)));
      const tails: { x: number; y: number }[] = [];
      for (let k = 0; k <= n; k++) {
        const f = k / n, q: Vec3 = [0, 1, 2].map((c) => l.q1[c] + (l.q2[c] - l.q1[c]) * f) as Vec3;
        const mag = Math.hypot(...q), d = unitDir(q);
        if (!d || !(qmax > 0)) continue;
        const p0 = P(at(l.t1 + (l.t2 - l.t1) * f)), s = { x: p0.x - d.x * 34 * level, y: p0.y - d.y * 34 * level }, len = 8 + 22 * (mag / qmax);
        out.push(arrow(`${i}a${k}`, s, d, len, `${cls}${self ? ' self' : ''}`));
        tails.push({ x: s.x - d.x * len, y: s.y - d.y * len });
      }
      if (tails.length > 1) out.push(<polyline key={`${i}tl`} points={pts(tails)} className={`${cls}${self ? ' self' : ''} f3-load-line`} />);
      if (!self && tails.length) {
        const mid = tails[Math.floor(tails.length / 2)], q1 = Math.hypot(...l.q1), q2 = Math.hypot(...l.q2);
        out.push(<text key={`${i}lt`} x={mid.x} y={mid.y - 4} className="f3-load-label" textAnchor="middle">{Math.abs(q1 - q2) > 1e-9 * q1 ? `${u.line(q1)} → ${u.line(q2)}` : u.line(q1)}</text>);
      }
    });
    return out;
  })() : null;
  const reactionGlyphs = region.reactions && sol && show !== 'mode' ? sol.reactions.flatMap((r) => {
    const p = pos.get(r.node);
    if (!p) return [];
    const s = P(p), out: JSX.Element[] = [];
    const F = Math.hypot(...r.F), M = Math.hypot(...r.M);
    // the reaction pushes on the node: an arrow from below towards it
    const d = unitDir(r.F);
    if (d && F > 0) {
      out.push(arrow(`${r.id}F`, s, d, 30, 'f3-reaction'));
      out.push(<text key={`${r.id}Ft`} x={s.x - d.x * 34} y={s.y - d.y * 34 + 12} className="f3-reaction-label" textAnchor="middle">{u.force(F)}</text>);
    }
    const dm = unitDir(r.M);
    if (dm && M > 0) {
      out.push(arrow(`${r.id}M`, s, dm, 24, 'f3-reaction', true));
      out.push(<text key={`${r.id}Mt`} x={s.x - dm.x * 28} y={s.y - dm.y * 28 - 4} className="f3-reaction-label" textAnchor="middle">{u.moment(M)}</text>);
    }
    return out;
  }) : null;

  // hinges (released moments): a ring next to the node on the member, or one ring on the
  // node where every member end there is released (a pin-jointed truss node)
  const hinged = (m: (typeof region.members)[number], end: 'a' | 'b') => !!(end === 'a' ? m.relA : m.relB)?.some((r) => r === 'My' || r === 'Mz');
  const pinNodes = new Set(region.nodes.map((n) => n.id).filter((id) => {
    const ends = region.members.flatMap((m) => [...(m.a === id ? [hinged(m, 'a')] : []), ...(m.b === id ? [hinged(m, 'b')] : [])]);
    return ends.length > 1 && ends.every(Boolean);
  }));
  const releaseGlyphs = [
    ...sorted.flatMap(({ m, A, B }) => {
      const out: JSX.Element[] = [];
      const L = Math.hypot(B.x - A.x, B.y - A.y);
      if (L < 1) return out;
      const d = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
      if (hinged(m, 'a') && !pinNodes.has(m.a)) out.push(<circle key={`${m.id}a`} cx={A.x + d.x * 8} cy={A.y + d.y * 8} r={3.2} className="f3-hinge" />);
      if (hinged(m, 'b') && !pinNodes.has(m.b)) out.push(<circle key={`${m.id}b`} cx={B.x - d.x * 8} cy={B.y - d.y * 8} r={3.2} className="f3-hinge" />);
      return out;
    }),
    ...[...pinNodes].map((id) => {
      const p = pos.get(id);
      if (!p) return null;
      const s = P(p);
      return <circle key={`pin${id}`} cx={s.x} cy={s.y} r={4} className="f3-hinge" />;
    }),
  ];

  // local axes of each member at its middle: x red, y green, z blue
  const axesGlyphs = region.axes && region.members.length <= 200 ? sorted.flatMap(({ m, a, b }) => {
    const geo = geometryOf(m.id);
    if (!geo) return [];
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], s = P(mid);
    return geo.axes.map((ax, k) => {
      const d = screenDir(v, ax);
      return <line key={`${m.id}${k}`} x1={s.x} y1={s.y} x2={s.x + d.x * 18} y2={s.y + d.y * 18} className={`f3-axis a${k}`} />;
    });
  }) : null;

  // the ground: a grid at the lowest node, 1–2–5 spacing
  const ground = (() => {
    if (empty) return null;
    let zmin = Infinity, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pos.values()) {
      zmin = Math.min(zmin, p[2]);
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    const span = Math.max(x1 - x0, y1 - y0, 1), step = niceFactor(span / 8), pad = step;
    const gx0 = Math.floor((x0 - pad) / step) * step, gx1 = Math.ceil((x1 + pad) / step) * step;
    const gy0 = Math.floor((y0 - pad) / step) * step, gy1 = Math.ceil((y1 + pad) / step) * step;
    const d: string[] = [];
    for (let x = gx0; x <= gx1 + 1e-9; x += step) {
      const p = P([x, gy0, zmin]), q = P([x, gy1, zmin]);
      d.push(`M${p.x.toFixed(1)} ${p.y.toFixed(1)}L${q.x.toFixed(1)} ${q.y.toFixed(1)}`);
    }
    for (let y = gy0; y <= gy1 + 1e-9; y += step) {
      const p = P([gx0, y, zmin]), q = P([gx1, y, zmin]);
      d.push(`M${p.x.toFixed(1)} ${p.y.toFixed(1)}L${q.x.toFixed(1)} ${q.y.toFixed(1)}`);
    }
    return <path d={d.join('')} className="f3-grid" />;
  })();

  // the global axes in the corner
  const triad = (
    <g transform={`translate(30 ${H - 30})`} className="f3-triad">
      {(['X', 'Y', 'Z'] as const).map((name, k) => {
        const w: Vec3 = [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0], d = screenDir(v, w);
        return (
          <g key={name} className={`a${k}`}>
            <line x1={0} y1={0} x2={d.x * 18} y2={d.y * 18} />
            <text x={d.x * 24} y={d.y * 24 + 4} textAnchor="middle">{name}</text>
          </g>
        );
      })}
    </g>
  );

  const shownAlpha = res?.buckling?.modes[0]?.alpha;
  const viewSelect = lc && (
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
  );

  return (
    <div ref={wrapRef} className={`f3-region${editing ? ' editing' : ''}`} style={{ width: W }} tabIndex={editing ? 0 : -1} onKeyDown={onKeyDown}>
      {editing && (
        <div className="sk-toolbar f3-toolbar" role="toolbar" aria-label="3-D frame view" onPointerDown={(e) => e.stopPropagation()}>
          {VIEWS.map((q) => (
            <button key={q.id} className="bm-tool" title={q.title} onClick={() => set({ camera: { ...cam, yaw: q.yaw, pitch: q.pitch } }, false)}>{q.label}</button>
          ))}
          <button className="icon-btn" title="Fit the frame into the view" aria-label="Fit" onClick={() => set({ camera: { ...cam, zoom: 1, panX: 0, panY: 0 } }, false)}><Maximize size={16} /></button>
          <span className="sk-sep" />
          <button className={`icon-btn${region.labels ? ' on' : ''}`} title="Names of nodes and members" aria-label="Names" aria-pressed={!!region.labels} onClick={() => set({ labels: !region.labels }, false)}><Tag size={16} /></button>
          <button className={`icon-btn${region.axes ? ' on' : ''}`} title="Member axes: x red, y green, z blue" aria-label="Member axes" aria-pressed={!!region.axes}
            onClick={() => set({ axes: !region.axes }, false)}><Axis3d size={16} /></button>
          <span className="sk-sep" />
          <button className="icon-btn" title="Done (Esc)" aria-label="Done" onClick={() => onDone(false)}><Check size={16} /></button>
        </div>
      )}
      <div className="f3-viewport" style={{ height: H }}>
        <svg
          ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="f3-svg" role="img" aria-label={region.name ? `3-D frame ${region.name}` : '3-D frame'}
          style={{ cursor: editing ? (drag.current?.moved ? 'grabbing' : 'grab') : undefined }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; setLiveCam(null); }}
          onPointerLeave={() => { setHover(null); setHot(null); }} onContextMenu={(e) => editing && e.preventDefault()}
        >
          {ground}
          {diagram?.paths}
          {sorted.map(({ m, A, B }) => (
            <line key={m.id} x1={A.x} y1={A.y} x2={B.x} y2={B.y}
              className={`f3-member${faintModel ? ' faint' : ''}${sel.has(m.id) || hot === m.id ? ' sel' : ''}${errId.has(m.id) ? ' err' : ''}`} />
          ))}
          {releaseGlyphs}
          {deformed?.lines}
          {region.nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p || (pinNodes.has(n.id) && !sel.has(n.id) && hot !== n.id)) return null;
            const s = P(p);
            return <circle key={n.id} cx={s.x} cy={s.y} r={sel.has(n.id) || hot === n.id ? 3.6 : 2.4} className={`f3-node${sel.has(n.id) || hot === n.id ? ' sel' : ''}${errId.has(n.id) ? ' err' : ''}`} />;
          })}
          {supportGlyphs}
          {loadGlyphs}
          {reactionGlyphs}
          {axesGlyphs}
          {diagram?.labels}
          {region.labels && region.nodes.length <= 400 && region.nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const s = P(p);
            return <text key={`t${n.id}`} x={s.x + 5} y={s.y - 5} className="f3-name node">{n.name}</text>;
          })}
          {region.labels && region.members.length <= 400 && sorted.map(({ m, A, B }) => <text key={`t${m.id}`} x={(A.x + B.x) / 2 + 4} y={(A.y + B.y) / 2 + 12} className="f3-name">{m.name}</text>)}
          {!empty && triad}
          {empty && (
            <text x={W / 2} y={H / 2} textAnchor="middle" className="f3-empty">
              {editing ? 'Start from a preset in the side panel, or add nodes and members in the tables below' : 'Double-click to build a 3-D frame'}
            </text>
          )}
        </svg>
        {(sol || shownAlpha !== undefined) && (
          <div className="f3-summary">
            {deformed && deformed.factor > 0 && <span>δ × {fmt(deformed.factor)}</span>}
            {sol && <span>u<sub>max</sub> {u.defl(displacementScale(sol))}</span>}
            {diagram && diagram.big > 0 && forceKey && <span>|{forceKey}|<sub>max</sub> {forceKey === 'T' || forceKey[0] === 'M' ? u.moment(diagram.big) : u.force(diagram.big)}</span>}
            {shownAlpha !== undefined && <span>α<sub>cr</sub> {fmtAlpha(mode ? mode.alpha : shownAlpha)}</span>}
          </div>
        )}
        {hover && (
          <div className="f3-tip" style={{ left: Math.min(hover.x + 14, W - 250), top: Math.min(hover.y + 12, H - 24 - hover.lines.length * 15) }}>
            <b>{hover.title}</b>
            {hover.lines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        {(res?.error || (res && Object.keys(res.errors).length > 0)) && (
          <div className="region-error f3-error" role="alert">{res.error ?? Object.values(res.errors)[0]}</div>
        )}
      </div>
      <div className="f3-strip" role="toolbar" aria-label="Results shown" onPointerDown={(e) => e.stopPropagation()}>
        {viewSelect}
        <span className="bm-seg f3-shows">
          {SHOWS.filter((q) => q.id !== 'mode' || modes.length).map((q) => (
            <button key={q.id} className={show === q.id ? 'on' : ''} aria-pressed={show === q.id} title={q.title} disabled={q.id !== 'model' && q.id !== 'mode' && !sol}
              onClick={() => set({ show: q.id }, false)}>{q.label}</button>
          ))}
        </span>
        {show === 'mode' && modes.length > 1 && (
          <select className="f3-view" aria-label="Buckling mode shown" value={modeIndex} onChange={(e) => set({ analysis: { ...region.analysis, mode: Number(e.target.value) } }, false)}>
            {modes.map((q, i) => <option key={i} value={i}>Mode {i + 1} · α {fmtAlpha(q.alpha)}</option>)}
          </select>
        )}
        {show !== 'model' && (
          <span className="bm-seg">
            <button title="Smaller" aria-label="Smaller diagrams" onClick={() => set({ scale: scaleK / 1.5 }, false)}>−</button>
            <button title="Larger" aria-label="Larger diagrams" onClick={() => set({ scale: scaleK * 1.5 }, false)}>+</button>
          </span>
        )}
        {sol && show !== 'mode' && (
          <button className={region.reactions ? 'on' : ''} aria-pressed={!!region.reactions} title="Support reactions" onClick={() => set({ reactions: !region.reactions }, false)}>R</button>
        )}
      </div>
      {editing && <Frame3DTables region={region} result={res} dispatch={dispatch} height={TABLES_H} />}
      {(editing || regionSelected) && <div className="resize-handle sk-resize f3-resize" style={{ top: region.height - 12 }} onPointerDown={startResize} title="Drag to resize" aria-label="Resize 3-D frame" />}
    </div>
  );
}

