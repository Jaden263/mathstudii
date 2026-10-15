import { describe, expect, it } from 'vitest';
import { kernel } from './solid';
import { drawMesh, projectView, STANDARD_VIEWS, standardScale, scaleText } from './drawing';

function blockWithHole() {
  const K = kernel()!;
  const box = K.Manifold.cube([100, 60, 40]);
  const hole = K.Manifold.cylinder(60, 10, 10, 48).translate([50, 30, -10]);
  const m = box.subtract(hole);
  const mesh = m.getMesh();
  const dm = drawMesh(mesh.vertProperties, mesh.numProp, mesh.triVerts);
  box.delete(); hole.delete(); m.delete();
  return dm;
}

const lengths = (s: number[]) => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) out.push(Math.hypot(s[i + 2] - s[i], s[i + 3] - s[i + 1]));
  return out;
};

describe('drawings', () => {
  it('front view: the outline visible, the hole as two hidden lines', () => {
    const v = projectView([blockWithHole()], STANDARD_VIEWS.front);
    expect(v.box.x1 - v.box.x0).toBeCloseTo(100, 6);
    expect(v.box.y1 - v.box.y0).toBeCloseTo(40, 6);
    const vis = lengths(v.visible);
    // the outline: 2 × 100 + 2 × 40
    expect(vis.reduce((a, b) => a + b, 0)).toBeCloseTo(280, 3);
    // hidden: the hole's silhouette, two lines of 40
    const hid = lengths(v.hidden);
    expect(hid.length).toBe(2);
    hid.forEach((l) => expect(l).toBeCloseTo(40, 3));
  });

  it('top view shows the hole as a visible circle', () => {
    const v = projectView([blockWithHole()], STANDARD_VIEWS.top);
    const vis = lengths(v.visible).reduce((a, b) => a + b, 0);
    // rectangle 2·(100 + 60) plus a 48-gon of radius 10 (perimeter ≈ 2π·10)
    expect(vis).toBeGreaterThan(320 + 62);
    expect(vis).toBeLessThan(320 + 63.2);
    expect(v.hidden.length).toBe(0);
  });

  it('picks standard scales', () => {
    expect(scaleText(standardScale(100, 120))).toBe('1:1');
    expect(scaleText(standardScale(500, 120))).toBe('1:5');
    expect(scaleText(standardScale(10, 120))).toBe('10:1');
  });
});
