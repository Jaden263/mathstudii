import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { PlotRegion } from '../../model/types';
import type { PlotResult } from '../../engine/evaluator';
import type { Action } from '../store';
import { drawPlot, fromPx, fmtTick, type Layout, type Theme, type View } from './draw';

function readTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return { fg: v('--text', '#1d1d1f'), muted: v('--text-muted', '#6b6b74'), grid: v('--plot-grid', '#e6e6ea'), bg: v('--page', '#fff') };
}

export function PlotView({ region, data, selected, dispatch, zoom = 1 }: { region: PlotRegion; data?: PlotResult; selected: boolean; dispatch: Dispatch<Action>; zoom?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layout = useRef<Layout | null>(null);
  const [view, setView] = useState<View>({ yaw: -0.6, pitch: 0.9 });
  const [hover, setHover] = useState<{ x: number; y: number; px: number; py: number } | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const is3D = region.plotType === 'surface';

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const obs = new MutationObserver(() => setThemeTick((t) => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const onMq = () => setThemeTick((t) => t + 1);
    mq.addEventListener('change', onMq);
    return () => { obs.disconnect(); mq.removeEventListener('change', onMq); };
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    // render at screen resolution: the page is CSS-scaled by the zoom
    const dpr = (window.devicePixelRatio || 1) * Math.max(1, zoom);
    c.width = Math.round(region.width * dpr);
    c.height = Math.round(region.height * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout.current = drawPlot(ctx, region.width, region.height, region, data, readTheme(c), view);
  }, [region, data, view, themeTick, zoom]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!is3D || !selected) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, ...view };
    const move = (ev: PointerEvent) => {
      setView({ yaw: start.yaw + (ev.clientX - start.x) * 0.01, pitch: Math.max(-1.5, Math.min(1.5, start.pitch + (ev.clientY - start.y) * 0.01)) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const L = layout.current;
    if (!L) return setHover(null);
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * region.width;
    const py = ((e.clientY - rect.top) / rect.height) * region.height;
    if (px < L.left || px > L.left + L.width || py < L.top || py > L.top + L.height) return setHover(null);
    const [x, y] = fromPx(L, px, py);
    setHover({ x, y, px, py });
  };

  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, w: region.width, h: region.height };
    // the sheet is CSS-scaled: on-screen width / layout width = zoom
    const sheet = e.currentTarget.closest('.sheet') as HTMLElement | null;
    const scale = sheet ? sheet.getBoundingClientRect().width / sheet.offsetWidth : 1;
    const move = (ev: PointerEvent) => {
      dispatch({
        type: 'update', id: region.id, coalesce: `size:${region.id}`,
        patch: { width: Math.max(160, Math.round(start.w + (ev.clientX - start.x) / scale)), height: Math.max(120, Math.round(start.h + (ev.clientY - start.y) / scale)) },
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="plot-region" style={{ width: region.width, height: region.height }}>
      <canvas
        ref={canvas}
        style={{ width: region.width, height: region.height, cursor: is3D && selected ? 'grab' : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Plot of ${region.traces.map((t) => t.y).join(', ') || region.z}`}
      />
      {hover && (
        <div className="plot-readout" style={{ left: Math.min(hover.px + 10, region.width - 120), top: Math.max(0, hover.py - 26) }}>
          {fmtTick(hover.x)}, {fmtTick(hover.y)}
        </div>
      )}
      {data?.error && <div className="plot-error" role="alert">{data.error}</div>}
      {selected && <div className="resize-handle" onPointerDown={startResize} title="Resize" />}
    </div>
  );
}
