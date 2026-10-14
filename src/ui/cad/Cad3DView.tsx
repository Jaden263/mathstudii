// Shaded 3-D preview of a CAD feature: WebGL triangles with feature edges on top,
// orthographic and fitted to the bounding sphere so the size stays put while orbiting.
// The view (yaw / pitch, degrees) belongs to the caller; a drag only previews it
// locally and reports the result on release.
import { useEffect, useRef, useState, type JSX } from 'react';
import type { Mesh } from '../../cad/mesh';

type View = { yaw: number; pitch: number };
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

function createRenderer(gl: WebGLRenderingContext): Renderer {
  const tri = program(gl, TRI_VS, TRI_FS);
  const line = program(gl, LINE_VS, LINE_FS);
  const tPos = gl.getAttribLocation(tri, 'aPos'), tNrm = gl.getAttribLocation(tri, 'aNrm');
  const lPos = gl.getAttribLocation(line, 'aPos');
  const u = {
    tMvp: gl.getUniformLocation(tri, 'uMvp'), tRot: gl.getUniformLocation(tri, 'uRot'), tColor: gl.getUniformLocation(tri, 'uColor'),
    lMvp: gl.getUniformLocation(line, 'uMvp'), lColor: gl.getUniformLocation(line, 'uColor'),
  };
  const bufs = { pos: gl.createBuffer(), nrm: gl.createBuffer(), edge: gl.createBuffer() };
  let mesh: Mesh | null = null;

  return {
    setMesh(m) {
      mesh = m;
      if (!m) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos);
      gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.nrm);
      gl.bufferData(gl.ARRAY_BUFFER, m.normals, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.edge);
      gl.bufferData(gl.ARRAY_BUFFER, m.edges, gl.STATIC_DRAW);
    },
    draw({ w, h, rot, theme }) {
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0); // transparent: the page shows through
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!mesh || !mesh.positions.length) return;
      const mvp = projection(mesh, rot, w, h);
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

      if (mesh.edges.length) {
        gl.useProgram(line);
        gl.uniformMatrix4fv(u.lMvp, false, mvp);
        gl.uniform4fv(u.lColor, theme.dark ? [0.05, 0.06, 0.08, 1] : [0.12, 0.14, 0.18, 1]);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.edge);
        gl.enableVertexAttribArray(lPos);
        gl.vertexAttribPointer(lPos, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, mesh.edges.length / 3);
      }
    },
    dispose() {
      if (gl.isContextLost()) return; // everything is gone already
      gl.deleteBuffer(bufs.pos);
      gl.deleteBuffer(bufs.nrm);
      gl.deleteBuffer(bufs.edge);
      gl.deleteProgram(tri);
      gl.deleteProgram(line);
    },
  };
}

// ------------------------------------------------------------ view maths

const RAD = Math.PI / 180;

/** Row-major R = Rx(pitch) · Ry(yaw): yaw turns about the vertical, pitch tips the top towards the viewer. */
function rotation({ yaw, pitch }: View): number[] {
  const cy = Math.cos(yaw * RAD), sy = Math.sin(yaw * RAD);
  const cp = Math.cos(pitch * RAD), sp = Math.sin(pitch * RAD);
  return [cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy];
}

function sphere(m: Mesh): { c: RGB; r: number } {
  const { min, max } = m.bounds;
  const c: RGB = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const r = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
  return { c, r };
}

/** Column-major MVP: centre the bounding sphere, rotate, fit it to the shorter side. */
function projection(m: Mesh, R: number[], w: number, h: number): Float32Array {
  const { c, r } = sphere(m);
  const fit = 0.92 / r;
  const sx = (fit * Math.min(w, h)) / w, sy = (fit * Math.min(w, h)) / h, sz = -1 / (r * 1.05); // nearer = smaller depth
  const s = [sx, sy, sz];
  const out = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) out[col * 4 + row] = R[row * 3 + col] * s[row];
    out[12 + row] = -(R[row * 3] * c[0] + R[row * 3 + 1] * c[1] + R[row * 3 + 2] * c[2]) * s[row];
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

function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, rot: number[], mesh: Mesh | null, theme: Theme, unit?: string) {
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
  if (mesh && mesh.positions.length) {
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

export function Cad3DView(props: {
  mesh: Mesh | null;
  width: number;
  height: number;
  yaw: number;
  pitch: number;
  onView: (v: View) => void;
  unitLabel?: string;
  message?: string;
}): JSX.Element {
  const { mesh, width, height } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  // 'none': no WebGL at all; 'lost': context lost and not (yet) restored
  const [gl, setGl] = useState<'ok' | 'none' | 'lost'>('ok');
  // bumps when a (re)created renderer needs the mesh uploaded again
  const [generation, setGeneration] = useState(0);
  const [live, setLive] = useState<View | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; start: View; view: View } | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const view = live ?? { yaw: props.yaw, pitch: props.pitch };

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
    const rot = rotation(view);
    renderer.current?.draw({ w, h, rot, theme });
    const g = o.getContext('2d');
    if (g && gl === 'ok' && mesh) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverlay(g, width, height, rot, mesh, theme, props.unitLabel);
    } else g?.clearRect(0, 0, w, h);
  }, [mesh, view.yaw, view.pitch, width, height, themeTick, generation, gl, props.unitLabel]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !mesh || gl !== 'ok') return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: view, view };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // the region may be CSS-scaled (page zoom); screen pixels are what the hand moved
    d.view = {
      yaw: wrap(d.start.yaw + (e.clientX - d.x) * 0.5),
      pitch: Math.max(-89, Math.min(89, d.start.pitch + (e.clientY - d.y) * 0.5)),
    };
    setLive(d.view);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setLive(null);
    if (d.view.yaw !== d.start.yaw || d.view.pitch !== d.start.pitch) props.onView(d.view);
  };

  const text = !mesh ? props.message ?? 'No 3-D model' : gl === 'none' ? props.message ?? 'No 3-D model (WebGL is not available)' : gl === 'lost' ? '3-D view paused (graphics context lost)' : null;
  const layer = { position: 'absolute', inset: 0, width, height } as const;
  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      <canvas
        ref={canvas}
        style={{ ...layer, touchAction: 'none', cursor: mesh && gl === 'ok' ? (live ? 'grabbing' : 'grab') : 'default', visibility: text ? 'hidden' : 'visible' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
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
