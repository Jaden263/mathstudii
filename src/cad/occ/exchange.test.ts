// STEP and STL from the exact shapes: read back with OCCT's own STEP reader, the
// volumes and placements must survive.
import { describe, expect, it } from 'vitest';
import { circles, rect, single, solve, withCircles } from './fixtures';
import { occ, scratch, type OC } from './kernel';
import { buildDesignOcc, occBox, occMass } from './build';
import { part21Ascii, stepFile, stlFile } from './exchange';
import type { CadDesign } from '../design';

const { PI } = Math;
const near = (v: number, want: number, rel: number) => expect(Math.abs(v - want) / Math.abs(want)).toBeLessThan(rel);

/** Read a STEP text with OCCT and measure what came back. */
function readStep(oc: OC, text: string) {
  return scratch((t) => {
    oc.FS.writeFile('/read.step', text);
    try {
      const r = t.add(new oc.STEPControl_Reader());
      expect(r.ReadFile('/read.step')).toBe(oc.IFSelect_ReturnStatus.IFSelect_RetDone);
      r.TransferRoots(t.add(new oc.Message_ProgressRange()));
      const s = t.add(r.OneShape());
      return { mass: occMass(oc, s), box: occBox(oc, [s])! };
    } finally {
      oc.FS.unlink('/read.step');
    }
  });
}

/** A flange (plate with a bored, filleted hub) and a shaft, the shaft placed twice. */
function assembly(): CadDesign {
  return {
    version: 2,
    components: [
      { id: 'cf', name: 'Flange', color: '#8fa3bf', items: [
        { kind: 'sketch', id: 's1', name: 'Plate', plane: { ref: 'XY' }, sketch: withCircles(rect('p', -50, -50, 50, 50), 'b', [[0, 0, 12]]) },
        { kind: 'extrude', id: 'f1', name: 'Plate', sketch: 's1', extent: { type: 'one', d: '10' }, op: 'new', edgeEnd: { type: 'fillet', r: '2' } },
      ] },
      { id: 'cs', name: 'Shaft', items: [
        { kind: 'sketch', id: 's2', name: 'Shaft', plane: { ref: 'XY' }, sketch: circles('s', [[0, 0, 10]]) },
        { kind: 'extrude', id: 'f2', name: 'Shaft', sketch: 's2', extent: { type: 'one', d: '80' }, op: 'new' },
      ] },
    ],
    occurrences: [
      { id: 'o1', component: 'cf', grounded: true },
      { id: 'o2', component: 'cs', grounded: true, pos: [0, 0, -20], name: 'Main shaft' },
      // turned to lie along X, 200 to the right
      { id: 'o3', component: 'cs', grounded: true, pos: [200, 0, 0], rot: [0, 90, 0] },
    ],
    joints: [],
  };
}

describe('STEP export', () => {
  it('round-trips a filleted body with the same volume', () => {
    const oc = occ()!;
    const design = assembly();
    const { numbers } = solve(design);
    const built = buildDesignOcc(oc, design, numbers);
    try {
      const body = built.components.get('cf')!.bodies[0];
      const text = stepFile(oc, built, design, { kind: 'body', component: 'cf', body: body.id });
      // AP214 (automotive design), millimetres, the body's name
      expect(text).toMatch(/^ISO-10303-21;/);
      expect(text).toMatch(/AUTOMOTIVE_DESIGN/);
      expect(text).toMatch(/SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
      expect(text).toContain("'Body1'");
      const back = readStep(oc, text);
      const V = occMass(oc, body.solid.shape).V;
      near(back.mass.V, V, 1e-6);
      // and that is still the closed form: the square's rim rounded (mitred corners) and the
      // bore's rim, a ring at R = 12 (Pappus, its centroid r(5/6 − π/4)/(1 − π/4) out of the bore)
      const r = 2, A = (1 - PI / 4) * r * r, k = r ** 3 * (5 / 6 - PI / 4);
      near(back.mass.V, 100 * 100 * 10 - PI * 144 * 10 - A * 400 + 8 * k - 2 * PI * (12 * A + k), 1e-6);
    } finally {
      built.free();
    }
  });

  it('writes an assembly with its placements', () => {
    const oc = occ()!;
    const design = assembly();
    const { numbers, res } = solve(design);
    const built = buildDesignOcc(oc, design, numbers);
    try {
      const text = stepFile(oc, built, design, { kind: 'assembly' }, { name: 'Test rig' });
      for (const name of ['Test rig', 'Flange', 'Shaft', 'Main shaft']) expect(text).toContain(`'${name}'`);
      // the shaft is stored once and placed twice
      expect(text.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(2);
      expect(text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE/g)).toHaveLength(3);
      const back = readStep(oc, text);
      near(back.mass.V, res.design!.total!.V, 1e-6);
      // the turned shaft reaches x = 280 at y, z within its radius
      near(back.box.max[0], 280, 1e-6);
      near(back.box.min[2], -20, 1e-6);
      const shaft = PI * 100 * 80;
      near(back.mass.V, 2 * shaft + res.design!.bodies.cf[0].mass!.V, 1e-9);
    } finally {
      built.free();
    }
  });

  it('writes the unit of the part', () => {
    const oc = occ()!;
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 2, 1) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '0.5' }, op: 'new' },
    ]);
    const { numbers } = solve(design);
    const built = buildDesignOcc(oc, design, numbers);
    try {
      // numbers in metres: the reader (in mm) sees a 2000 × 1000 × 500 block
      const text = stepFile(oc, built, design, { kind: 'component', component: 'c1' }, { unit: 'm' });
      expect(text).toMatch(/SI_UNIT\(\$,\.METRE\.\)/);
      near(readStep(oc, text).mass.V, 2000 * 1000 * 500, 1e-9);
    } finally {
      built.free();
    }
  });
});

describe('STEP text', () => {
  it('writes names beyond ASCII as ISO 10303-21 escapes', () => {
    // ü U+00FC, Ø U+00D8 (basic plane: \X2\, 4 hex digits); 𝛼 U+1D6FC (\X4\, 8 hex digits)
    expect(part21Ascii("PRODUCT('Bügel Ø𝛼',$)")).toBe("PRODUCT('B\\X2\\00FC\\X0\\gel \\X2\\00D8\\X0\\\\X4\\0001D6FC\\X0\\',$)");
    const oc = occ()!;
    const design = single([
      { kind: 'sketch', id: 's1', name: 'S', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 4, 2) },
      { kind: 'extrude', id: 'f1', name: 'E', sketch: 's1', extent: { type: 'one', d: '1' }, op: 'new' },
    ], 'Bügel');
    const { numbers } = solve(design);
    const built = buildDesignOcc(oc, design, numbers);
    try {
      const text = stepFile(oc, built, design, { kind: 'component', component: 'c1' });
      expect(/[^\x00-\x7f]/.test(text)).toBe(false);
      expect(text).toContain("'B\\X2\\00FC\\X0\\gel'");
      near(readStep(oc, text).mass.V, 8, 1e-9);
    } finally {
      built.free();
    }
  });
});

describe('STL export', () => {
  it('tessellates the exact surfaces to the tolerance asked', () => {
    const oc = occ()!;
    const design = assembly();
    const { numbers, res } = solve(design);
    const built = buildDesignOcc(oc, design, numbers);
    try {
      const stl = stlFile(oc, built, design, { kind: 'component', component: 'cs' }, { tolerance: 1e-3 });
      const dv = new DataView(stl.buffer, stl.byteOffset);
      const n = dv.getUint32(80, true);
      expect(stl.length).toBe(84 + 50 * n);
      // volume of the facets (divergence theorem) against the cylinder
      let V = 0;
      for (let t = 0; t < n; t++) {
        const o = 84 + 50 * t + 12;
        const p = Array.from({ length: 9 }, (_, k) => dv.getFloat32(o + 4 * k, true));
        V += (p[0] * (p[4] * p[8] - p[5] * p[7]) - p[1] * (p[3] * p[8] - p[5] * p[6]) + p[2] * (p[3] * p[7] - p[4] * p[6])) / 6;
      }
      // a polygon inscribed with sagitta ≤ 10⁻³ on r = 10 loses at most 2·10⁻⁴ of the area
      const exact = PI * 100 * 80;
      expect(V).toBeLessThan(exact);
      near(V, exact, 2e-4);
      // the assembly STL is in placed coordinates: three solids' worth of facets
      const all = stlFile(oc, built, design, { kind: 'assembly' });
      expect(new DataView(all.buffer).getUint32(80, true)).toBeGreaterThan(n);
      void res;
    } finally {
      built.free();
    }
  });
});
