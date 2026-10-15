// Navigation cube for the 3-D scene: a CSS 3-D cube turned with the camera, so its FRONT
// face points where the model's +Z points. Faces pick the standard views; the strips and
// corners around them pick the edge and corner views in between; the house goes home (iso).
import { useState, type JSX } from 'react';
import { Home } from 'lucide-react';
import { STANDARD_VIEWS, viewRotation } from './Cad3DView';

type Face = 'front' | 'back' | 'top' | 'bottom' | 'right' | 'left';
const FACES: Face[] = ['front', 'back', 'top', 'bottom', 'right', 'left'];
const RAD = Math.PI / 180;

// World (x right, y up, z towards the viewer) to CSS (y down): S = diag(1, −1, 1).
const S = [1, -1, 1];

/** CSS matrix3d (column-major) from a row-major 3×3 and a translation. */
function matrix3d(m: number[], t: number[] = [0, 0, 0]): string {
  const f = (x: number) => (Math.abs(x) < 1e-10 ? 0 : +x.toFixed(6));
  return `matrix3d(${[m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0, t[0], t[1], t[2], 1].map(f).join(',')})`;
}

/** The camera rotation in CSS space: S · R · S. */
function cubeTransform(view: { yaw: number; pitch: number }): string {
  const R = viewRotation(view);
  return matrix3d(R.map((x, i) => x * S[Math.floor(i / 3)] * S[i % 3]));
}

/** Screen right, screen up and towards-the-viewer directions in the world for a face's standard view. */
function faceBasis(face: Face) {
  const R = viewRotation(STANDARD_VIEWS[face]);
  return { right: R.slice(0, 3), up: R.slice(3, 6), out: R.slice(6, 9) };
}

/** Face div → its place on the cube: its x along the face's right, its (down) y along −up, its z out. */
function faceTransform(face: Face, half: number): string {
  const { right, up, out } = faceBasis(face);
  const cols = [right, up.map((x) => -x), out].map((c) => c.map((x, k) => x * S[k]));
  const m = [0, 1, 2].flatMap((r) => cols.map((c) => c[r]));
  return matrix3d(m, out.map((x, k) => x * S[k] * half));
}

/** The view looking back along the world direction d (from the viewer's side). */
function viewFrom(d: number[]): { yaw: number; pitch: number } {
  const l = Math.hypot(d[0], d[1], d[2]);
  const y = d[1] / l;
  return { yaw: Math.atan2(-d[0], d[2]) / RAD || 0, pitch: Math.asin(Math.max(-1, Math.min(1, y))) / RAD };
}

const LIGHT = (() => {
  const l = Math.hypot(-0.35, 0.55, 1);
  return [-0.35 / l, 0.55 / l, 1 / l];
})();

export function ViewCube(props: { view: { yaw: number; pitch: number }; onView: (v: { yaw: number; pitch: number }) => void; size?: number }): JSX.Element {
  const size = props.size ?? 84;
  const edge = Math.round(size * 0.56); // corner to corner the turned cube spans up to √3 times this
  const half = edge / 2;
  const [hot, setHot] = useState<string | null>(null);
  const R = viewRotation(props.view);

  const pick = (face: Face, i: number, j: number) => {
    if (!i && !j) return props.onView({ ...STANDARD_VIEWS[face] });
    const { right, up, out } = faceBasis(face);
    props.onView(viewFrom([0, 1, 2].map((k) => out[k] + i * right[k] + j * up[k])));
  };

  // Hit testing by ray casting against the cube ourselves: browsers' hit testing of
  // preserve-3d content is unreliable, and this way it matches what is drawn exactly.
  const cellAt = (e: React.PointerEvent | React.MouseEvent): { face: Face; i: number; j: number } | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const k = size / (r.width || size);
    const X = (e.clientX - r.left) * k - size / 2, Y = size / 2 - (e.clientY - r.top) * k;
    // view → world: Rᵀ; the ray runs from the viewer's side along −(towards the viewer)
    const o = [0, 1, 2].map((c) => R[c] * X + R[3 + c] * Y + R[6 + c] * 2 * edge);
    const d = [-R[6], -R[7], -R[8]];
    const band = half - 0.22 * edge;
    for (const face of FACES) {
      const { right, up, out } = faceBasis(face);
      const dn = d[0] * out[0] + d[1] * out[1] + d[2] * out[2];
      if (dn > -1e-6) continue; // turned away
      const t = (half - (o[0] * out[0] + o[1] * out[1] + o[2] * out[2])) / dn;
      const p = [0, 1, 2].map((c) => o[c] + t * d[c]);
      const a = p[0] * right[0] + p[1] * right[1] + p[2] * right[2], b = p[0] * up[0] + p[1] * up[1] + p[2] * up[2];
      if (Math.abs(a) > half + 0.5 || Math.abs(b) > half + 0.5) continue;
      return { face, i: a > band ? 1 : a < -band ? -1 : 0, j: b > band ? 1 : b < -band ? -1 : 0 };
    }
    return null;
  };
  const keyOf = (c: { face: Face; i: number; j: number }) => {
    const { right, up, out } = faceBasis(c.face);
    return dirKey([0, 1, 2].map((k) => out[k] + c.i * right[k] + c.j * up[k]));
  };

  return (
    <div
      style={{ position: 'relative', width: size, height: size, userSelect: 'none', cursor: hot ? 'pointer' : 'default' }}
      onPointerMove={(e) => {
        const c = cellAt(e);
        const k = c ? keyOf(c) : null;
        if (k !== hot) setHot(k);
      }}
      onPointerLeave={() => setHot(null)}
      onClick={(e) => {
        const c = cellAt(e);
        if (c) pick(c.face, c.i, c.j);
      }}
    >
      <div
        style={{
          position: 'absolute', left: (size - edge) / 2, top: (size - edge) / 2, width: edge, height: edge,
          transformStyle: 'preserve-3d', pointerEvents: 'none', transform: cubeTransform(props.view),
        }}
      >
        {FACES.map((face) => {
          const { right, up, out } = faceBasis(face);
          // a little shading by the same headlight as the model keeps the cube readable as a solid
          const n = [0, 1, 2].map((r) => R[r * 3] * out[0] + R[r * 3 + 1] * out[1] + R[r * 3 + 2] * out[2]);
          const shade = 0.16 * (1 - Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]));
          const faceHot = hot === dirKey(out);
          return (
            <div
              key={face}
              style={{
                position: 'absolute', inset: 0, boxSizing: 'border-box', transform: faceTransform(face, half),
                backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden',
                background: 'var(--surface, #fff)', border: '1px solid var(--border-strong, #c7cbd4)',
                boxShadow: `inset 0 0 0 ${edge}px rgba(110, 116, 130, ${shade.toFixed(3)})`,
                display: 'grid', gridTemplateColumns: '22% 1fr 22%', gridTemplateRows: '22% 1fr 22%',
              }}
            >
              {[1, 0, -1].flatMap((j) => [-1, 0, 1].map((i) => {
                const key = dirKey([0, 1, 2].map((k) => out[k] + i * right[k] + j * up[k]));
                return (
                  <div key={`${i},${j}`} style={{ background: hot === key ? 'var(--accent-soft, rgba(47, 111, 223, 0.18))' : undefined }} />
                );
              }))}
              <span
                style={{
                  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
                  font: `600 ${Math.max(7, Math.round(size / 10.5))}px system-ui, sans-serif`, letterSpacing: 0.3,
                  color: faceHot ? 'var(--accent, #2f6fdf)' : 'var(--text-muted, #686b75)',
                }}
              >
                {face.toUpperCase()}
              </span>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        title="Home view"
        aria-label="Home view"
        onClick={(e) => {
          e.stopPropagation();
          props.onView({ ...STANDARD_VIEWS.iso });
        }}
        onPointerMove={(e) => {
          e.stopPropagation();
          if (hot) setHot(null);
        }}
        style={{
          position: 'absolute', left: 0, top: 0, width: 20, height: 20, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', borderRadius: 4, background: 'transparent', color: 'var(--text-muted, #686b75)', cursor: 'pointer',
        }}
      >
        <Home size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

/** Same key for the same direction from any of the faces sharing an edge or corner. */
function dirKey(d: number[]): string {
  return d.map((x) => Math.round(x)).join(',');
}
