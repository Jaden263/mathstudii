import { describe, expect, it } from 'vitest';
import { STANDARD_VIEWS, clampZoom, panBy, viewRotation, zoomAt } from './Cad3DView';

// screen = zoom · (q + pan), the mapping zoomAt / panBy promise to respect
const screen = (v: { zoom: number; pan: { x: number; y: number } }, q: { x: number; y: number }) => ({ x: v.zoom * (q.x + v.pan.x), y: v.zoom * (q.y + v.pan.y) });

/** Rows of R: where screen right, screen up and the direction towards the viewer point in the world. */
function axes(v: { yaw: number; pitch: number }) {
  const r = viewRotation(v);
  return { right: r.slice(0, 3), up: r.slice(3, 6), toViewer: r.slice(6, 9) };
}

const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));

describe('zoomAt', () => {
  it('keeps the model point under the cursor fixed', () => {
    const v = { yaw: 10, pitch: 20, zoom: 1.7, pan: { x: 0.3, y: -0.2 } };
    const u = { x: 0.6, y: -0.45 };
    const q = { x: u.x / v.zoom - v.pan.x, y: u.y / v.zoom - v.pan.y }; // the point under u now
    for (const f of [0.5, 1.1, 3, 1e6, 1e-6]) {
      const w = zoomAt(v, u, f);
      const s = screen(w, q);
      expect(s.x).toBeCloseTo(u.x, 12);
      expect(s.y).toBeCloseTo(u.y, 12);
      expect(w.yaw).toBe(10); // the rest of the view rides along
    }
  });

  it('clamps zoom to 0.05..200', () => {
    expect(zoomAt({ zoom: 1, pan: { x: 0, y: 0 } }, { x: 0, y: 0 }, 1e6).zoom).toBe(200);
    expect(zoomAt({ zoom: 1, pan: { x: 0, y: 0 } }, { x: 0, y: 0 }, 1e-6).zoom).toBe(0.05);
    expect(clampZoom(NaN)).toBe(1);
  });

  it('zooming at the centre leaves pan alone', () => {
    expect(zoomAt({ zoom: 2, pan: { x: 0.4, y: 0.1 } }, { x: 0, y: 0 }, 3).pan).toEqual({ x: 0.4, y: 0.1 });
  });
});

describe('panBy', () => {
  it('moves the picture by exactly the screen offset at any zoom', () => {
    const v = { zoom: 4, pan: { x: 0.1, y: 0.2 } };
    const q = { x: 0.3, y: -0.7 };
    const a = screen(v, q), b = screen(panBy(v, { x: 0.25, y: -0.5 }), q);
    expect(b.x - a.x).toBeCloseTo(0.25, 12);
    expect(b.y - a.y).toBeCloseTo(-0.5, 12);
  });
});

describe('STANDARD_VIEWS', () => {
  it('front looks at the XY plane from +Z', () => close(Object.values(axes(STANDARD_VIEWS.front)).flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1]));
  it('back looks from −Z, Y up', () => {
    const a = axes(STANDARD_VIEWS.back);
    close(a.toViewer, [0, 0, -1]);
    close(a.up, [0, 1, 0]);
  });
  it('top looks at the XZ plane from +Y, X right, −Z up', () => {
    const a = axes(STANDARD_VIEWS.top);
    close(a.toViewer, [0, 1, 0]);
    close(a.right, [1, 0, 0]);
    close(a.up, [0, 0, -1]);
  });
  it('bottom looks from −Y, X right', () => {
    const a = axes(STANDARD_VIEWS.bottom);
    close(a.toViewer, [0, -1, 0]);
    close(a.right, [1, 0, 0]);
  });
  it('right looks at the YZ plane from +X, Y up, −Z right', () => {
    const a = axes(STANDARD_VIEWS.right);
    close(a.toViewer, [1, 0, 0]);
    close(a.up, [0, 1, 0]);
    close(a.right, [0, 0, -1]);
  });
  it('left looks from −X, Y up', () => {
    const a = axes(STANDARD_VIEWS.left);
    close(a.toViewer, [-1, 0, 0]);
    close(a.up, [0, 1, 0]);
  });
  it('iso looks from +X+Y+Z with Y pointing up the screen', () => {
    const a = axes(STANDARD_VIEWS.iso);
    close(a.toViewer, [1, 1, 1].map((x) => x / Math.sqrt(3)));
    expect(a.up[1]).toBeGreaterThan(0.8);
    expect(a.right[0]).toBeGreaterThan(0); // +X towards the right, as in a CAD iso view
  });
});
