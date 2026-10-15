// SVG rendering of sketch shapes. World coordinates are y-up in the sketch unit;
// the View maps them to region pixels.
import type { ReactNode } from 'react';
import { applyResolved, areaRole, type Shape, type ShapeStyle, type SketchView, type SymbolKind, type Pt } from '../../model/sketch';
import { templatePrimitives, placePrimitives, type Primitive, type SectionProps } from '../../engine/geometry';

export interface Viewport {
  view: SketchView;
  width: number;
  height: number;
}

export function toScreen(vp: Viewport, p: Pt): Pt {
  return { x: (p.x - vp.view.cx) * vp.view.zoom + vp.width / 2, y: vp.height / 2 - (p.y - vp.view.cy) * vp.view.zoom };
}

export function toWorld(vp: Viewport, sx: number, sy: number): Pt {
  return { x: (sx - vp.width / 2) / vp.view.zoom + vp.view.cx, y: (vp.height / 2 - sy) / vp.view.zoom + vp.view.cy };
}

const DASH: Record<string, string | undefined> = { solid: undefined, dash: '8 5', dot: '2 4', center: '14 4 3 4' };

/** A stroke width that follows the worksheet / region line-thickness setting (--lw). */
export const lwCss = (w: number) => `calc(${w}px * var(--lw, 1))`;

function strokeProps(st: ShapeStyle | undefined, fallbackWidth = 1.6) {
  return {
    stroke: st?.stroke || 'currentColor',
    strokeWidth: st?.width ?? fallbackWidth,
    style: { strokeWidth: lwCss(st?.width ?? fallbackWidth) },
    strokeDasharray: DASH[st?.dash ?? 'solid'],
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    vectorEffect: 'non-scaling-stroke' as const,
  };
}

export function fmtLen(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 0.01) return Number(v.toPrecision(4)).toString();
  if (a >= 1000) return String(Math.round(v));
  return String(Math.round(v * 100) / 100);
}

function polyD(pts: Pt[], closed: boolean) {
  if (!pts.length) return '';
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + (closed ? ' Z' : '');
}

function primitivesD(vp: Viewport, prims: Primitive[]): { solid: string; holes: string } {
  let solid = '', holes = '';
  for (const p of prims) {
    let d: string;
    if (p.kind === 'circle') {
      const c = toScreen(vp, p.c);
      const r = p.r * vp.view.zoom;
      d = `M${c.x - r} ${c.y} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z `;
    } else d = polyD(p.pts.map((q) => toScreen(vp, q)), true) + ' ';
    if (p.sign > 0) solid += d;
    else holes += d;
  }
  return { solid, holes };
}

function arrowHead(tip: Pt, from: Pt, size = 9): string {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const a1 = ang + Math.PI - 0.38, a2 = ang + Math.PI + 0.38;
  return `M${tip.x} ${tip.y} L${tip.x + size * Math.cos(a1)} ${tip.y + size * Math.sin(a1)} L${tip.x + size * Math.cos(a2)} ${tip.y + size * Math.sin(a2)} Z`;
}

/** Symbol geometry in local units (size = 1), y up, origin at the attachment point. */
function symbolLocal(kind: SymbolKind): ReactNode {
  const hatch = (y: number, x0: number, x1: number, below = true) => {
    const ticks = [];
    for (let x = x0 + 0.15; x <= x1 + 1e-9; x += 0.3) ticks.push(`M${x} ${y} L${x - 0.25} ${below ? y - 0.25 : y + 0.25}`);
    return <path d={`M${x0} ${y} L${x1} ${y} ${ticks.join(' ')}`} />;
  };
  switch (kind) {
    case 'joint':
      return <circle cx={0} cy={0} r={0.28} className="sk-joint" />;
    case 'pin':
      return (
        <>
          <path d="M0 0 L0.6 -1 L-0.6 -1 Z" className="sk-fill-page" />
          {hatch(-1, -0.9, 0.9)}
          <circle cx={0} cy={0} r={0.16} className="sk-joint" />
        </>
      );
    case 'roller':
      return (
        <>
          <path d="M0 0 L0.6 -0.8 L-0.6 -0.8 Z" className="sk-fill-page" />
          <circle cx={-0.35} cy={-0.95} r={0.15} className="sk-fill-page" />
          <circle cx={0.35} cy={-0.95} r={0.15} className="sk-fill-page" />
          {hatch(-1.1, -0.9, 0.9)}
          <circle cx={0} cy={0} r={0.16} className="sk-joint" />
        </>
      );
    case 'fixed': {
      const ticks = [];
      for (let y = -0.9; y <= 0.9 + 1e-9; y += 0.3) ticks.push(`M0 ${y} L-0.25 ${y - 0.25}`);
      return <path d={`M0 -1 L0 1 ${ticks.join(' ')}`} />;
    }
    case 'ground':
      return hatch(0, -1.2, 1.2);
    case 'slider':
      return (
        <>
          <rect x={-0.7} y={-0.4} width={1.4} height={0.8} className="sk-fill-page" />
          {hatch(-0.4, -1.4, 1.4)}
          <circle cx={0} cy={0} r={0.16} className="sk-joint" />
        </>
      );
    case 'force':
      return (
        <>
          <path d="M0 0 L0 2.6" />
          <path d="M0 0 L0.22 0.55 L-0.22 0.55 Z" className="sk-fill-stroke" />
        </>
      );
    case 'load': {
      // arrows pointing down onto the origin line, spanning 4 units to the right
      let d = 'M0 0.45 L4 0.45';
      let heads = '';
      for (let x = 0; x <= 4 + 1e-9; x += 0.5) {
        d += ` M${x} 0.45 L${x} 0.1`;
        heads += `M${x} 0 L${x + 0.07} 0.14 L${x - 0.07} 0.14 Z `;
      }
      return (
        <>
          <path d={d} />
          <path d={heads} className="sk-fill-stroke" />
        </>
      );
    }
    case 'moment':
      return (
        <>
          <path d="M0.9 0 A0.9 0.9 0 1 1 0 -0.9" fill="none" />
          <path d="M0 -0.9 L0.4 -0.62 L0.4 -1.18 Z" className="sk-fill-stroke" />
          <circle cx={0} cy={0} r={0.1} className="sk-fill-stroke" />
        </>
      );
    case 'spring': {
      let d = 'M0 0 L0.4 0';
      for (let i = 0; i < 6; i++) d += ` L${0.6 + i * 0.4} ${i % 2 ? -0.3 : 0.3}`;
      d += ' L3 0 L3.4 0';
      return <path d={d} fill="none" />;
    }
    case 'damper':
      return <path d="M0 0 L1.4 0 M1.4 -0.35 L1.4 0.35 M1.1 -0.5 L2.3 -0.5 M1.1 0.5 L2.3 0.5 M2.3 -0.5 L2.3 0.5 M2.3 0 L3.4 0" fill="none" />;
  }
}

export interface RenderOptions {
  selected?: Set<string>;
  errors?: Record<string, string>;
  /** Clip id prefix (unique per region). */
  uid: string;
  interactive?: boolean;
}

/** One shape (already resolved) as SVG. */
export function ShapeSvg({ s, vp, opt }: { s: Shape; vp: Viewport; opt: RenderOptions }) {
  const sp = strokeProps(s.style);
  const sel = opt.selected?.has(s.id);
  const err = opt.errors?.[s.id];
  const common = {
    'data-shape-id': s.id,
    className: `sk-shape${sel ? ' sel' : ''}${err ? ' err' : ''}`,
  };
  const fillFor = () => {
    const role = areaRole(s);
    if (role === 'hole') return 'var(--page)';
    if (s.style?.fill) return s.style.fill;
    if (role === 'solid') return s.style?.hatch === false ? 'var(--sk-solid)' : `url(#${opt.uid}-hatch)`;
    return 'none';
  };
  switch (s.type) {
    case 'line': {
      const a = toScreen(vp, s.a), b = toScreen(vp, s.b);
      return <path {...common} {...sp} d={`M${a.x} ${a.y} L${b.x} ${b.y}`} />;
    }
    case 'arrow': {
      const a = toScreen(vp, s.a), b = toScreen(vp, s.b);
      return (
        <g {...common}>
          <path {...sp} d={`M${a.x} ${a.y} L${b.x} ${b.y}`} />
          <path d={arrowHead(b, a)} fill={sp.stroke} stroke="none" />
          {s.double && <path d={arrowHead(a, b)} fill={sp.stroke} stroke="none" />}
        </g>
      );
    }
    case 'link': {
      const a = toScreen(vp, s.a), b = toScreen(vp, s.b);
      return (
        <g {...common}>
          <path {...sp} strokeWidth={s.style?.width ?? 4} style={{ strokeWidth: lwCss(s.style?.width ?? 4) }} d={`M${a.x} ${a.y} L${b.x} ${b.y}`} />
          <circle cx={a.x} cy={a.y} r={4.5} className="sk-joint-px" />
          <circle cx={b.x} cy={b.y} r={4.5} className="sk-joint-px" />
        </g>
      );
    }
    case 'dim': {
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const A = toScreen(vp, { x: s.a.x + nx * s.offset, y: s.a.y + ny * s.offset });
      const B = toScreen(vp, { x: s.b.x + nx * s.offset, y: s.b.y + ny * s.offset });
      const a0 = toScreen(vp, s.a), b0 = toScreen(vp, s.b);
      const ext = (p0: Pt, p1: Pt) => {
        const ex = p1.x - p0.x, ey = p1.y - p0.y, el = Math.hypot(ex, ey) || 1;
        return `M${p0.x + (ex / el) * 3} ${p0.y + (ey / el) * 3} L${p1.x + (ex / el) * 5} ${p1.y + (ey / el) * 5}`;
      };
      const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      let ang = (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;
      const label = s.text?.trim() || fmtLen(len);
      return (
        <g {...common}>
          <path {...sp} strokeWidth={1} style={{ strokeWidth: lwCss(1) }} d={`${ext(a0, A)} ${ext(b0, B)} M${A.x} ${A.y} L${B.x} ${B.y}`} />
          <path d={`${arrowHead(B, A, 7)} ${arrowHead(A, B, 7)}`} fill={sp.stroke} stroke="none" />
          <text x={mid.x} y={mid.y - 4} transform={`rotate(${ang} ${mid.x} ${mid.y})`} className="sk-dim-text" fill={sp.stroke}>{label}</text>
        </g>
      );
    }
    case 'poly':
    case 'path': {
      const pts = s.pts.map((p) => toScreen(vp, p));
      const closed = s.type === 'poly' && s.closed;
      return <path {...common} {...sp} fill={closed ? fillFor() : 'none'} d={polyD(pts, closed)} />;
    }
    case 'rect': {
      const a = toScreen(vp, s.a), b = toScreen(vp, s.b);
      return <path {...common} {...sp} fill={fillFor()} d={polyD([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], true)} />;
    }
    case 'circle': {
      const c = toScreen(vp, s.c);
      return <circle {...common} {...sp} fill={fillFor()} cx={c.x} cy={c.y} r={Math.abs(s.r) * vp.view.zoom} />;
    }
    case 'arc': {
      const c = toScreen(vp, s.c);
      const r = Math.abs(s.r) * vp.view.zoom;
      const a0 = (s.a0 * Math.PI) / 180, a1 = (s.a1 * Math.PI) / 180;
      let sweep = s.a1 - s.a0;
      while (sweep < 0) sweep += 360;
      const p0 = { x: c.x + r * Math.cos(a0), y: c.y - r * Math.sin(a0) };
      const p1 = { x: c.x + r * Math.cos(a1), y: c.y - r * Math.sin(a1) };
      return <path {...common} {...sp} fill="none" d={`M${p0.x} ${p0.y} A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 0 ${p1.x} ${p1.y}`} />;
    }
    case 'text': {
      const p = toScreen(vp, s.p);
      return (
        <text {...common} x={p.x} y={p.y} fontSize={Math.max(6, s.size * vp.view.zoom)} fill={s.style?.stroke || 'currentColor'} className={`${common.className} sk-text`}>
          {s.text}
        </text>
      );
    }
    case 'symbol': {
      const p = toScreen(vp, s.p);
      const k = s.size * vp.view.zoom;
      return (
        <g {...common} className={`${common.className} sk-sym`} transform={`translate(${p.x} ${p.y}) rotate(${-s.rot}) scale(${k} ${-k})`} stroke={sp.stroke} strokeWidth={sp.strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" style={{ color: s.style?.stroke, strokeWidth: sp.style.strokeWidth }}>
          {symbolLocal(s.symbol)}
          <rect x={-1.2} y={-1.3} width={2.4} height={2.6} fill="transparent" stroke="none" className="sk-hit" />
        </g>
      );
    }
    case 'section': {
      let prims: Primitive[] = [];
      try {
        const nums = Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, Number(v)]));
        prims = placePrimitives(templatePrimitives(s.template, nums), s.p, s.rot);
      } catch {
        prims = [];
      }
      if (!prims.length) {
        const p = toScreen(vp, s.p);
        return <circle {...common} {...sp} cx={p.x} cy={p.y} r={6} fill="none" strokeDasharray="3 3" />;
      }
      const { solid, holes } = primitivesD(vp, prims);
      return <path {...common} {...sp} d={solid + holes} fillRule="evenodd" fill={fillFor()} />;
    }
  }
}

/** Centroid marker and principal axes. */
export function PropsOverlay({ props, vp, unit }: { props: SectionProps; vp: Viewport; unit: string }) {
  const c = toScreen(vp, { x: props.xc, y: props.yc });
  const L = Math.max(props.xmax - props.xmin, props.ymax - props.ymin) * 0.6 * vp.view.zoom;
  const a = (props.theta * Math.PI) / 180;
  const ax = (ang: number) => `M${c.x - L * Math.cos(ang)} ${c.y + L * Math.sin(ang)} L${c.x + L * Math.cos(ang)} ${c.y - L * Math.sin(ang)}`;
  const r = 6;
  return (
    <g className="sk-props" pointerEvents="none">
      <path d={`${ax(a)} ${ax(a + Math.PI / 2)}`} className="sk-axis" />
      <circle cx={c.x} cy={c.y} r={r} className="sk-centroid" />
      <path d={`M${c.x} ${c.y - r} A${r} ${r} 0 0 1 ${c.x + r} ${c.y} L${c.x} ${c.y} Z M${c.x} ${c.y + r} A${r} ${r} 0 0 1 ${c.x - r} ${c.y} L${c.x} ${c.y} Z`} className="sk-centroid-fill" />
      <text x={c.x + 9} y={c.y - 8} className="sk-props-text">
        A = {fmtLen(props.A)} {unit}²
      </text>
    </g>
  );
}

export function SketchDefs({ uid }: { uid: string }) {
  return (
    <defs>
      <pattern id={`${uid}-hatch`} patternUnits="userSpaceOnUse" width={7} height={7} patternTransform="rotate(45)">
        <rect width={7} height={7} className="sk-hatch-bg" />
        <line x1={0} y1={0} x2={0} y2={7} className="sk-hatch-line" />
      </pattern>
    </defs>
  );
}

export function Grid({ vp, step }: { vp: Viewport; step: number }) {
  if (!step || step * vp.view.zoom < 6) return null;
  const tl = toWorld(vp, 0, 0), br = toWorld(vp, vp.width, vp.height);
  const xs: number[] = [], ys: number[] = [];
  for (let x = Math.ceil(tl.x / step) * step; x <= br.x; x += step) xs.push(x);
  for (let y = Math.ceil(br.y / step) * step; y <= tl.y; y += step) ys.push(y);
  if (xs.length * ys.length > 6000) return null;
  const dots: string[] = [];
  for (const x of xs) for (const y of ys) {
    const p = toScreen(vp, { x, y });
    dots.push(`M${p.x.toFixed(1)} ${p.y.toFixed(1)}h0.01`);
  }
  const o = toScreen(vp, { x: 0, y: 0 });
  return (
    <g className="sk-grid" pointerEvents="none">
      <path d={dots.join('')} className="sk-grid-dots" />
      <path d={`M${o.x - 8} ${o.y} L${o.x + 8} ${o.y} M${o.x} ${o.y - 8} L${o.x} ${o.y + 8}`} className="sk-origin" />
    </g>
  );
}

/** Resolve all shapes of a sketch against engine output. */
export function resolveShapes(shapes: Shape[], resolved: Record<string, Record<string, number>> | undefined): Shape[] {
  return shapes.map((s) => applyResolved(s, resolved?.[s.id]));
}
