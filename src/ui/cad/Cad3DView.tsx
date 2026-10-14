// Shaded 3-D preview of a CAD feature: WebGL triangles with feature edges on top,
// orthographic and fitted to the bounding sphere so the size stays put while orbiting.
// The view (yaw / pitch in degrees, zoom, pan) belongs to the caller; a gesture only
// previews it locally and reports the result once it ends.
import { useEffect, useRef, useState, type JSX } from 'react';
import type { Mesh } from '../../cad/mesh';

type Pan = { x: number; y: number };
/** zoom 1 fits the bounding sphere; pan is a screen offset (x right, y up) in half the shorter side, applied before zoom. */
export type View = { yaw: number; pitch: number; zoom?: number; pan?: Pan };
type FullView = Required<View>;
export type Display = 'shaded' | 'shadedEdges' | 'wireframe';
type RGB = [number, number, number];

interface Theme {
  dark: boolean;
  text: string;
  muted: string;
}

// ------------------------------------------------------------ GL renderer

const TRI_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uMvp;
uniform mat3 uRot;
varying vec3 vNrm;
void main() {
  vNrm = uRot * aNrm;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const TRI_FS = `
precision mediump float;
uniform vec3 uColor;
varying vec3 vNrm;
void main() {
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n; // inside of an open or self-crossing solid
  // headlight from above-left of the viewer, plus a weak fill so shadows keep their shape
  float key = max(dot(n, normalize(vec3(-0.35, 0.55, 1.0))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.6, -0.3, 0.5))), 0.0);
  gl_FragColor = vec4(uColor * (0.32 + 0.62 * key + 0.12 * fill), 1.0);
}`;

const LINE_VS = `
attribute vec3 aPos;
uniform mat4 uMvp;
void main() { gl_Position = uMvp * vec4(aPos, 1.0); }`;

const LINE_FS = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

interface DrawOpts {
  w: number; // device pixels
  h: number;
  rot: number[]; // row-major 3×3
  zoom: number;
  pan: Pan;
  display: Display;
  theme: Theme;
}

interface Renderer {
  setMesh(m: Mesh | null): void;
  draw(o: DrawOpts): void;
  dispose(): void;
}

function program(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type);
    if (!s) throw new Error('createShader failed');
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    gl.attachShader(p, s);
    gl.deleteShader(s); // freed with the program
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}

const TRI_SIDES = [[0, 3], [3, 6], [6, 0]] as const;

/** Every triangle side as a line segment: smooth solids (a torus) have no feature edges to draw. */
function triangleEdges(p: Float32Array): Float32Array {
  const out = new Float32Array(p.length * 2);
  let o = 0;
  for (let t = 0; t < p.length; t += 9) {
    for (const [a, b] of TRI_SIDES) {
      out.set(p.subarray(t + a, t + a + 3), o);
      out.set(p.subarray(t + b, t + b + 3), o + 3);
      o += 6;
    }
  }
  return out;
}

function createRenderer(gl: WebGLRenderingContext): Renderer {
  const tri = program(gl, TRI_VS, TRI_FS);
  const line = program(gl, LINE_VS, LINE_FS);
  const tPos = gl.getAttribLocation(tri, 'aPos'), tNrm = gl.getAttribLocation(tri, 'aNrm');
  const lPos = gl.getAttribLocation(line, 'aPos');
  const u = {
    tMvp: gl.getUniformLocation(tri, 'uMvp'), tRot: gl.getUniformLocation(tri, 'uRot'), tColor: gl.getUniformLocation(tri, 'uColor'),
    lMvp: gl.getUniformLocation(line, 'uMvp'), lColor: gl.getUniformLocation(line, 'uColor'),
  };
  const bufs = { pos: gl.createBuffer(), nrm: gl.createBuffer(), edge: gl.createBuffer(), wire: gl.createBuffer() };
  let mesh: Mesh | null = null;
  // triangle sides are built on first use only: twice the vertex data, and only wireframe needs them
  let wire = -1; // vertex count, −1 = not uploaded for this mesh

  const lines = (buf: WebGLBuffer | null, count: number, color: number[]) => {
    gl.uniform4fv(u.lColor, color);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(lPos);
    gl.vertexAttribPointer(lPos, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.LINES, 0, count);
  };

  return {
    setMesh(m) {
      mesh = m;
      wire = -1;
      if (!m) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos);
      gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.nrm);
      gl.bufferData(gl.ARRAY_BUFFER, m.normals, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.edge);
      gl.bufferData(gl.ARRAY_BUFFER, m.edges, gl.STATIC_DRAW);
    },
    draw({ w, h, rot, zoom, pan, display, theme }) {
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0); // transparent: the page shows through
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!mesh || !mesh.positions.length) return;
      const mvp = projection(mesh, rot, w, h, zoom, pan);

      if (display === 'wireframe') {
        // see-through: no faces to hide anything, so no depth test; the lines take the
        // text colour's side of the theme to stay visible on the transparent background
        if (wire < 0) {
          const segs = triangleEdges(mesh.positions);
          gl.bindBuffer(gl.ARRAY_BUFFER, bufs.wire);
          gl.bufferData(gl.ARRAY_BUFFER, segs, gl.STATIC_DRAW);
          wire = segs.length / 3;
        }
        const ink = theme.dark ? [0.86, 0.89, 0.94] : [0.12, 0.14, 0.18];
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        // the canvas is premultiplied: colour times alpha, alpha itself kept as is
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(line);
        gl.uniformMatrix4fv(u.lMvp, false, mvp);
        lines(bufs.wire, wire, [...ink, 0.22]);
        if (mesh.edges.length) lines(bufs.edge, mesh.edges.length / 3, [...ink, 1]);
        gl.disable(gl.BLEND);
        return;
      }

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      // faces pushed back a little so coplanar edges win the depth test
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      gl.useProgram(tri);
      gl.uniformMatrix4fv(u.tMvp, false, mvp);
      // column-major for GL: transpose of the row-major rotation
      gl.uniformMatrix3fv(u.tRot, false, [rot[0], rot[3], rot[6], rot[1], rot[4], rot[7], rot[2], rot[5], rot[8]]);
      gl.uniform3fv(u.tColor, theme.dark ? [0.5, 0.56, 0.64] : [0.66, 0.72, 0.8]);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos);
      gl.enableVertexAttribArray(tPos);
      gl.vertexAttribPointer(tPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.nrm);
      gl.enableVertexAttribArray(tNrm);
      gl.vertexAttribPointer(tNrm, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.positions.length / 3);
      gl.disableVertexAttribArray(tNrm);
      gl.disable(gl.POLYGON_OFFSET_FILL);

      if (display === 'shadedEdges' && mesh.edges.length) {
        gl.useProgram(line);
        gl.uniformMatrix4fv(u.lMvp, false, mvp);
        lines(bufs.edge, mesh.edges.length / 3, theme.dark ? [0.05, 0.06, 0.08, 1] : [0.12, 0.14, 0.18, 1]);
      }
    },
    dispose() {
      if (gl.isContextLost()) return; // everything is gone already
      for (const b of Object.values(bufs)) gl.deleteBuffer(b);
      gl.deleteProgram(tri);
      gl.deleteProgram(line);
    },
  };
}

// ------------------------------------------------------------ view maths

const RAD = Math.PI / 180;

/** Named views; on screen x is right, y up and z towards the viewer, and yaw 0 / pitch 0 looks down −Z. */
export const STANDARD_VIEWS: Record<'front' | 'back' | 'top' | 'bottom' | 'right' | 'left' | 'iso', { yaw: number; pitch: number }> = {
  front: { yaw: 0, pitch: 0 }, // XY plane from +Z
  back: { yaw: 180, pitch: 0 }, // from −Z
  top: { yaw: 0, pitch: 90 }, // XZ plane from +Y, +Z towards the bottom of the screen
  bottom: { yaw: 0, pitch: -90 }, // from −Y
  right: { yaw: -90, pitch: 0 }, // YZ plane from +X
  left: { yaw: 90, pitch: 0 }, // from −X
  iso: { yaw: -45, pitch: Math.atan(Math.SQRT1_2) / RAD }, // true isometric: looking along −(1, 1, 1)
};

/**
 * Row-major R = Rx(pitch) · Ry(yaw): yaw turns about the vertical, pitch tips the top towards the viewer.
 * The matrix has no singularity, so pitch may reach ±90° (top / bottom) exactly.
 */
export function viewRotation({ yaw, pitch }: { yaw: number; pitch: number }): number[] {
  const cy = Math.cos(yaw * RAD), sy = Math.sin(yaw * RAD);
  const cp = Math.cos(pitch * RAD), sp = Math.sin(pitch * RAD);
  return [cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy];
}

export const clampZoom = (z: number): number => (Number.isFinite(z) ? Math.max(0.05, Math.min(200, z)) : 1);
export const clampPitch = (p: number): number => Math.max(-90, Math.min(90, p));

// Screen positions here are centre-relative, y up, in half the shorter side (NDC on that
// axis), and a model point q (fitted to the unit-ish disc) lands at zoom · (q + pan).

/** Move the view by d on screen. */
export function panBy<T extends { zoom: number; pan: Pan }>(v: T, d: Pan): T {
  return { ...v, pan: { x: v.pan.x + d.x / v.zoom, y: v.pan.y + d.y / v.zoom } };
}

/** Scale zoom by factor, keeping the model point under the screen point u in place (CAD-style zoom to cursor). */
export function zoomAt<T extends { zoom: number; pan: Pan }>(v: T, u: Pan, factor: number): T {
  const zoom = clampZoom(v.zoom * factor);
  // u = z0 · (q + p0) = z1 · (q + p1)  ⇒  p1 = p0 + u / z1 − u / z0
  return { ...v, zoom, pan: { x: v.pan.x + u.x / zoom - u.x / v.zoom, y: v.pan.y + u.y / zoom - u.y / v.zoom } };
}

function sphere(m: Mesh): { c: RGB; r: number } {
  const { min, max } = m.bounds;
  const c: RGB = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const r = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
  return { c, r };
}

/** Column-major MVP: centre the bounding sphere, rotate, fit it to the shorter side, then pan and zoom. */
function projection(m: Mesh, R: number[], w: number, h: number, zoom: number, pan: Pan): Float32Array {
  const { c, r } = sphere(m);
  const k = Math.min(w, h), fit = (0.92 / r) * zoom;
  // depth is not zoomed: an orthographic zoom never clips the model front or back
  const s = [(fit * k) / w, (fit * k) / h, -1 / (r * 1.05)]; // nearer = smaller depth
  const off = [(zoom * pan.x * k) / w, (zoom * pan.y * k) / h, 0];
  const out = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) out[col * 4 + row] = R[row * 3 + col] * s[row];
    out[12 + row] = -(R[row * 3] * c[0] + R[row * 3 + 1] * c[1] + R[row * 3 + 2] * c[2]) * s[row] + off[row];
  }
  out[15] = 1;
  return out;
}

// ------------------------------------------------------------ 2-D overlay

function readTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  const text = v('--text', '#1c1d21');
  return { dark: luminance(text) > 0.5, text, muted: v('--text-muted', '#686b75') };
}

function luminance(color: string): number {
  let rgb: number[] = [];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else rgb = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  if (rgb.length < 3) return 0;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

const fmt = (x: number) => String(+x.toPrecision(4));

function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, rot: number[], mesh: Mesh | null, theme: Theme, unit: string | undefined, dims: boolean) {
  ctx.clearRect(0, 0, w, h);
  // axis triad, back to front so the nearest axis is on top
  const L = 18, ox = 14 + L, oy = h - 14 - L;
  const axes = [
    { name: 'X', color: '#e03131', v: [rot[0], rot[3], rot[6]] },
    { name: 'Y', color: '#2f9e44', v: [rot[1], rot[4], rot[7]] },
    { name: 'Z', color: '#1c7ed6', v: [rot[2], rot[5], rot[8]] },
  ].sort((a, b) => a.v[2] - b.v[2]);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const a of axes) {
    const x = ox + a.v[0] * L, y = oy - a.v[1] * L;
    ctx.strokeStyle = ctx.fillStyle = a.color;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(x, y);
    ctx.stroke();
    // labels pushed out along the axis; a head-on axis gets its label beside the origin
    const len = Math.hypot(a.v[0], a.v[1]);
    const [dx, dy] = len > 0.2 ? [a.v[0] / len, -a.v[1] / len] : [0.7, -0.7];
    ctx.fillText(a.name, x + dx * 7, y + dy * 7);
  }
  if (dims && mesh && mesh.positions.length) {
    const { min, max } = mesh.bounds;
    const size = [0, 1, 2].map((k) => fmt(max[k] - min[k])).join(' × ') + (unit ? ` ${unit}` : '');
    ctx.fillStyle = theme.muted;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(size, w - 8, h - 8);
  }
}

// ------------------------------------------------------------ component

type Gesture =
  | { kind: 'orbit' | 'pan'; id: number; x: number; y: number; start: FullView; view: FullView }
  | { kind: 'pinch'; ids: [number, number]; d0: number; m0: Pan; base: FullView; start: FullView; view: FullView };

const same = (a: FullView, b: FullView) => a.yaw === b.yaw && a.pitch === b.pitch && a.zoom === b.zoom && a.pan.x === b.pan.x && a.pan.y === b.pan.y;

/** Client coordinates to centre-relative screen units, from the rendered box (which page zoom may scale). */
function toUnits(el: Element, x: number, y: number): Pan {
  const r = el.getBoundingClientRect(), k = Math.min(r.width, r.height) / 2 || 1;
  return { x: (x - r.left - r.width / 2) / k, y: (r.top + r.height / 2 - y) / k };
}

export function Cad3DView(props: {
  mesh: Mesh | null;
  width: number;
  height: number;
  yaw: number;
  pitch: number;
  zoom?: number;
  pan?: Pan;
  onView: (v: View) => void;
  /** 'orbit': left-drag orbits, nothing else (embedded in a scrolling page). 'full': also pan, wheel / pinch zoom, double-click fit. */
  navigation?: 'orbit' | 'full';
  display?: Display;
  showDims?: boolean;
  unitLabel?: string;
  message?: string;
}): JSX.Element {
  const { mesh, width, height, navigation = 'orbit', display = 'shadedEdges', showDims = true } = props;
  const full = navigation === 'full';
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  // 'none': no WebGL at all; 'lost': context lost and not (yet) restored
  const [gl, setGl] = useState<'ok' | 'none' | 'lost'>('ok');
  // bumps when a (re)created renderer needs the mesh uploaded again
  const [generation, setGeneration] = useState(0);
  const [live, setLive] = useState<{ view: FullView; kind: Gesture['kind'] | 'wheel' } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, Pan>()); // client positions of the fingers down ('full' only)
  const wheel = useRef<{ start: FullView; view: FullView; timer: number } | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const given: FullView = { yaw: props.yaw, pitch: props.pitch, zoom: clampZoom(props.zoom ?? 1), pan: { x: props.pan?.x ?? 0, y: props.pan?.y ?? 0 } };
  const view = live?.view ?? given;
  const active = !!mesh && gl === 'ok';
  // for the native wheel listener and its timer, which outlive a render
  const latest = useRef({ view, active, onView: props.onView });
  useEffect(() => { latest.current = { view, active, onView: props.onView }; });

  /** Report a pending wheel zoom now; returns the view it ended on. */
  const flushWheel = (): FullView | null => {
    const w = wheel.current;
    if (!w) return null;
    clearTimeout(w.timer);
    wheel.current = null;
    setLive(null);
    if (!same(w.view, w.start)) latest.current.onView(w.view);
    return w.view;
  };

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const obs = new MutationObserver(() => setThemeTick((t) => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const onMq = () => setThemeTick((t) => t + 1);
    mq?.addEventListener('change', onMq);
    return () => { obs.disconnect(); mq?.removeEventListener('change', onMq); };
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let ctx: WebGLRenderingContext | null = null;
    try {
      // keep the frame so printing and PDF export capture the 3-D view
      const attrs: WebGLContextAttributes = { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true };
      ctx = (c.getContext('webgl', attrs) ?? c.getContext('experimental-webgl', attrs)) as WebGLRenderingContext | null;
    } catch {
      ctx = null;
    }
    if (!ctx) return setGl('none');
    const init = () => {
      try {
        renderer.current = createRenderer(ctx);
        setGl('ok');
        setGeneration((g) => g + 1);
      } catch {
        renderer.current = null;
        setGl(ctx.isContextLost() ? 'lost' : 'none');
      }
    };
    const onLost = (e: Event) => {
      e.preventDefault(); // lets the browser restore it
      renderer.current = null;
      setGl('lost');
    };
    c.addEventListener('webglcontextlost', onLost);
    c.addEventListener('webglcontextrestored', init);
    init();
    return () => {
      c.removeEventListener('webglcontextlost', onLost);
      c.removeEventListener('webglcontextrestored', init);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);

  // Wheel zoom only in 'full': embedded in a page, the wheel must keep scrolling it.
  // Native and non-passive, since React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !full) return;
    const onWheel = (e: WheelEvent) => {
      if (!latest.current.active) return;
      e.preventDefault();
      if (gesture.current) return; // a drag owns the view meanwhile
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      // trackpad pinch arrives as ctrl+wheel with small deltas
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
      const w = wheel.current ?? { start: latest.current.view, view: latest.current.view, timer: 0 };
      clearTimeout(w.timer);
      w.view = zoomAt(w.view, toUnits(c, e.clientX, e.clientY), factor);
      w.timer = window.setTimeout(flushWheel, 250);
      wheel.current = w;
      setLive({ view: w.view, kind: 'wheel' });
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => { c.removeEventListener('wheel', onWheel); flushWheel(); };
  }, [full]); // flushWheel reads refs only

  useEffect(() => {
    renderer.current?.setMesh(mesh);
  }, [mesh, generation]);

  useEffect(() => {
    const c = canvas.current, o = overlay.current;
    if (!c || !o) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    // resizing clears the canvas, so only when it changes
    for (const el of [c, o]) {
      if (el.width !== w) el.width = w;
      if (el.height !== h) el.height = h;
    }
    const theme = readTheme(c);
    const rot = viewRotation(view);
    renderer.current?.draw({ w, h, rot, zoom: view.zoom, pan: view.pan, display, theme });
    const g = o.getContext('2d');
    if (g && gl === 'ok' && mesh) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverlay(g, width, height, rot, mesh, theme, props.unitLabel, showDims);
    } else g?.clearRect(0, 0, w, h);
  }, [mesh, view.yaw, view.pitch, view.zoom, view.pan.x, view.pan.y, width, height, display, showDims, themeTick, generation, gl, props.unitLabel]);

  const end = (g: Gesture, el: Element, id: number) => {
    gesture.current = null;
    el.releasePointerCapture?.(id);
    setLive(null);
    if (!same(g.view, g.start)) props.onView(g.view);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active) return;
    const el = e.currentTarget;
    const touch = full && e.pointerType === 'touch';
    if (touch) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (touch && g && g.kind !== 'pinch' && touches.current.size === 2) {
      // a second finger turns the one-finger orbit into pinch zoom + pan, from where it got to
      e.stopPropagation();
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      const [a, b] = [...touches.current.values()];
      const m0 = toUnits(el, (a.x + b.x) / 2, (a.y + b.y) / 2);
      gesture.current = { kind: 'pinch', ids: [g.id, e.pointerId], d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), m0, base: g.view, start: g.start, view: g.view };
      return;
    }
    if (touch && touches.current.size > 1) return;
    const pan = full && (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey));
    if (e.button !== 0 && !pan) return;
    e.stopPropagation();
    e.preventDefault(); // also stops middle-button autoscroll
    el.setPointerCapture?.(e.pointerId);
    const start = flushWheel() ?? view;
    gesture.current = { kind: pan ? 'pan' : 'orbit', id: e.pointerId, x: e.clientX, y: e.clientY, start, view: start };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (!g.ids.includes(e.pointerId)) return;
      const [a, b] = g.ids.map((id) => touches.current.get(id) ?? { x: 0, y: 0 });
      const m = toUnits(e.currentTarget, (a.x + b.x) / 2, (a.y + b.y) / 2);
      // follow the midpoint, then scale about it
      g.view = zoomAt(panBy(g.base, { x: m.x - g.m0.x, y: m.y - g.m0.y }), m, Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) / g.d0);
    } else {
      if (g.id !== e.pointerId) return;
      if (g.kind === 'pan') {
        const p = toUnits(e.currentTarget, e.clientX, e.clientY), p0 = toUnits(e.currentTarget, g.x, g.y);
        g.view = panBy(g.start, { x: p.x - p0.x, y: p.y - p0.y });
      } else {
        // the region may be CSS-scaled (page zoom); screen pixels are what the hand moved
        g.view = { ...g.start, yaw: wrap(g.start.yaw + (e.clientX - g.x) * 0.5), pitch: clampPitch(g.start.pitch + (e.clientY - g.y) * 0.5) };
      }
    }
    setLive({ view: g.view, kind: g.kind });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    touches.current.delete(e.pointerId);
    const g = gesture.current;
    // lifting either pinch finger ends it; the other one is then ignored until it lifts
    if (g && (g.kind === 'pinch' ? g.ids.includes(e.pointerId) : g.id === e.pointerId)) end(g, e.currentTarget, e.pointerId);
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !active) return;
    e.preventDefault();
    const fit: FullView = { ...view, zoom: 1, pan: { x: 0, y: 0 } };
    if (!same(fit, view)) props.onView(fit);
  };

  const text = !mesh ? props.message ?? 'No 3-D model' : gl === 'none' ? props.message ?? 'No 3-D model (WebGL is not available)' : gl === 'lost' ? '3-D view paused (graphics context lost)' : null;
  const cursor = !active ? 'default' : live?.kind === 'pan' ? 'move' : live && live.kind !== 'wheel' ? 'grabbing' : 'grab';
  const layer = { position: 'absolute', inset: 0, width, height } as const;
  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      <canvas
        ref={canvas}
        style={{ ...layer, touchAction: 'none', cursor, visibility: text ? 'hidden' : 'visible' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={full ? onDoubleClick : undefined}
        onContextMenu={full ? (e) => e.preventDefault() : undefined}
      />
      <canvas ref={overlay} style={{ ...layer, pointerEvents: 'none' }} />
      {text && (
        <div style={{ ...layer, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 12, boxSizing: 'border-box', color: 'var(--text-muted)', fontSize: 13 }}>
          {text}
        </div>
      )}
    </div>
  );
}

/** Keep yaw in (−180°, 180°] so stored views stay tidy. */
function wrap(deg: number): number {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
}
