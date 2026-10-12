import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { loadPref, savePref } from '../platform/files';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** Zoom steps for buttons and Ctrl +/−, like a browser's. */
const STOPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Convert a wheel event's delta to pixels, whatever its deltaMode. */
export function wheelPixels(e: WheelEvent): number {
  return e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
}

/**
 * Zoom factor for one wheel event: proportional to the scroll distance, so a
 * mouse notch (~100 px) zooms ~18 % while a trackpad pinch (many tiny deltas)
 * zooms smoothly instead of racing.
 */
export function wheelZoomFactor(e: WheelEvent): number {
  const d = Math.max(-120, Math.min(120, wheelPixels(e)));
  return Math.exp(-d * 0.002);
}

interface Anchor {
  /** Page point (unzoomed px) that must stay under the screen point. */
  wx: number;
  wy: number;
  cx: number;
  cy: number;
}

/**
 * Page zoom that keeps the point under the cursor (or pinch centre) fixed,
 * like map and design apps do. The sheet is CSS-scaled inside `innerSelector`.
 */
export function usePageZoom(scrollerRef: RefObject<HTMLDivElement | null>, innerSelector: string) {
  const [zoom, setZoomState] = useState<number>(() => clamp(loadPref('zoom', 1) ?? 1));
  /** Zoom of the DOM as currently laid out. */
  const committed = useRef(zoom);
  /** Zoom requested but not yet rendered (several wheel events can arrive per frame). */
  const target = useRef(zoom);
  const anchor = useRef<Anchor | null>(null);

  const inner = useCallback(() => scrollerRef.current?.querySelector<HTMLElement>(innerSelector) ?? null, [scrollerRef, innerSelector]);

  /** Scroll so that the anchor's page point is under its screen point at the given zoom. */
  const applyAnchor = useCallback((a: Anchor, z: number) => {
    const sc = scrollerRef.current;
    const el = inner();
    if (!sc || !el) return;
    const r = el.getBoundingClientRect();
    sc.scrollLeft += r.left + a.wx * z - a.cx;
    sc.scrollTop += r.top + a.wy * z - a.cy;
  }, [scrollerRef, inner]);

  const pagePoint = useCallback((cx: number, cy: number): Anchor | null => {
    const el = inner();
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { wx: (cx - r.left) / committed.current, wy: (cy - r.top) / committed.current, cx, cy };
  }, [inner]);

  /** Zoom to `z`, keeping the screen point (default: centre of the view) fixed. */
  const zoomTo = useCallback((z: number, clientX?: number, clientY?: number) => {
    const sc = scrollerRef.current;
    const next = clamp(Math.round(z * 1000) / 1000);
    if (sc) {
      const r = sc.getBoundingClientRect();
      const cx = clientX ?? r.left + r.width / 2;
      const cy = clientY ?? r.top + r.height / 2;
      // keep the first anchor of a burst: the DOM has not been re-laid out since
      if (!anchor.current) anchor.current = pagePoint(cx, cy);
      else anchor.current = { ...anchor.current, cx, cy };
    }
    target.current = next;
    setZoomState(next);
  }, [scrollerRef, pagePoint]);

  const zoomBy = useCallback((factor: number, clientX?: number, clientY?: number) => {
    zoomTo(target.current * factor, clientX, clientY);
  }, [zoomTo]);

  /** Next/previous browser-style step. */
  const step = useCallback((dir: 1 | -1) => {
    const z = target.current;
    const next = dir > 0 ? STOPS.find((s) => s > z + 1e-3) ?? MAX_ZOOM : [...STOPS].reverse().find((s) => s < z - 1e-3) ?? MIN_ZOOM;
    zoomTo(next);
  }, [zoomTo]);

  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    committed.current = zoom;
    if (a) applyAnchor(a, zoom);
  }, [zoom, applyAnchor]);

  useEffect(() => savePref('zoom', zoom), [zoom]);

  // Ctrl/⌘ + wheel, and trackpad pinch (which browsers report as ctrl + wheel)
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(wheelZoomFactor(e), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scrollerRef, zoomBy]);

  // two-finger pinch on touch screens: zoom about the fingers and pan with them
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let pinch: { d0: number; z0: number; a: Anchor } | null = null;
    const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const m = mid(e.touches);
      const a = pagePoint(m.x, m.y);
      if (a) pinch = { d0: dist(e.touches), z0: committed.current, a };
    };
    const onMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const m = mid(e.touches);
      const z = clamp(pinch.z0 * (dist(e.touches) / pinch.d0));
      const a = { ...pinch.a, cx: m.x, cy: m.y };
      if (Math.abs(z - committed.current) < 1e-3) applyAnchor(a, committed.current); // pure two-finger pan
      else {
        anchor.current = a;
        target.current = z;
        setZoomState(z);
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [scrollerRef, pagePoint, applyAnchor]);

  return { zoom, zoomTo, zoomBy, step };
}
