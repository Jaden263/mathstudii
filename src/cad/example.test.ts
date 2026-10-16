import { describe, it, expect, beforeAll } from 'vitest';
import { initKernel } from './solid';
import { evaluateWorksheet, type CadResult, type MathResult } from '../engine/evaluator';
import { cadExample, curvesExample, sweepExample } from '../model/examples';
import { designOf } from './design';
import { designKey, designNumbers } from './keys';
import { withSolution } from './edit';
import { timelineCache } from './occ/cache';
import type { CadRegion, Worksheet } from '../model/types';

beforeAll(async () => {
  await initKernel();
});

describe('CAD example worksheet', () => {
  it('evaluates the parts and the assembly without errors', () => {
    const ws = cadExample();
    const out = evaluateWorksheet(ws);
    for (const r of ws.regions) {
      const res = out.results.get(r.id);
      if (r.kind === 'math') expect((res as MathResult).error, r.source).toBeUndefined();
      if (r.kind === 'cad') {
        const c = res as CadResult;
        expect(c.error, r.name).toBeUndefined();
        expect(c.featureError, r.name).toBeUndefined();
        expect(c.mass?.m, r.name).toBeGreaterThan(0);
      }
    }
    const asm = ws.regions.find((r) => r.kind === 'cad' && r.name === 'asm')!;
    const res = out.results.get(asm.id) as CadResult;
    // flange: plate + hub − bore − 6 counterbored holes (d_2 = 50 mm)
    const bore = Math.PI * 25.5 ** 2;
    const hole = Math.PI * 4.5 ** 2 * 12 + Math.PI * (7.5 ** 2 - 4.5 ** 2) * 4;
    const Vf = Math.PI * 100 ** 2 * 12 + Math.PI * 50 ** 2 * 20 - bore * 32 - 6 * hole;
    // built by the B-rep kernel (loaded in test-setup): exact, not just within the mesh's faceting
    expect(res.design!.brep).toBe(true);
    expect(Math.abs(res.design!.components.cf!.V / Vf - 1)).toBeLessThan(1e-9);
    expect(res.design!.placements.os.by).toBe('joint');
    const shaftLine = out.results.get(ws.regions.find((r) => r.kind === 'math' && r.source.startsWith('asm.Spin'))!.id) as MathResult;
    expect(shaftLine.tex).toContain('15');
  });

  it('each part carries the key of the design and numbers it was built from', () => {
    const ws = cadExample();
    const keys = (w: Worksheet) => {
      const out = evaluateWorksheet(w);
      return w.regions.filter((r): r is CadRegion => r.kind === 'cad').map((r) => {
        // as the UI holds it: a structured clone of the worker's result
        const dr = structuredClone((out.results.get(r.id) as CadResult).design!);
        // the UI files display data under this key and checks its requests against it
        expect(designKey(designOf(r), designNumbers(dr))).toBe(dr.display);
        return dr.display;
      });
    };
    const k = keys(ws);
    expect(new Set(k).size).toBe(k.length);
    // a math-only change keeps every key; the bolt count changes the assembly's alone
    const edit = (src: string, to: string): Worksheet => ({ ...ws, regions: ws.regions.map((r) => (r.kind === 'math' && r.source.startsWith(src) ? { ...r, source: to } : r)) });
    expect(keys(edit('ω', 'ω := 2*π*1500/(60 s)'))).toEqual(k);
    const nb = keys(edit('n_b', 'n_b := 8'));
    expect(nb.filter((x, i) => x !== k[i])).toHaveLength(1);
  });

  it('the page writing solutions back, and a length there and back, rebuild nothing', () => {
    let ws = cadExample();
    const parts = (w: Worksheet) => w.regions.filter((r): r is CadRegion => r.kind === 'cad');
    const run = (w: Worksheet) => {
      const out = evaluateWorksheet(w);
      return parts(w).map((r) => out.results.get(r.id) as CadResult);
    };
    // what the page preview does with a single-sketch part: store the solved geometry
    const writeBack = (w: Worksheet, res: CadResult[]): Worksheet => ({
      ...w, regions: w.regions.map((r) => {
        const i = parts(w).indexOf(r as CadRegion);
        return i >= 0 && !(r as CadRegion).design ? { ...r, sketch: withSolution((r as CadRegion).sketch, res[i].points, res[i].radii) } : r;
      }),
    });
    const setL = (w: Worksheet, v: string): Worksheet => ({ ...w, regions: w.regions.map((r) => (r.kind === 'math' && r.source.startsWith('L :=') ? { ...r, source: `L := ${v}` } : r)) });
    const first = run(ws);
    const k0 = first.map((r) => r.design!.display);
    ws = writeBack(ws, first);
    expect(run(ws).map((r) => r.design!.display)).toEqual(k0);
    ws = setL(ws, '200 mm');
    const longer = run(ws);
    // the shaft and the assembly (its shaft is L long) change, the plate does not
    expect(longer.map((r, i) => r.design!.display !== k0[i])).toEqual([true, false, true]);
    // back to 180 mm from the stored 200 mm solution: the solver lands ulps away (1e-15)
    ws = setL(writeBack(ws, longer), '180 mm');
    const ran = timelineCache.ran;
    const back = run(ws);
    expect(back.map((r) => r.design!.display)).toEqual(k0);
    expect(timelineCache.ran).toBe(ran);
    // V of the stepped shaft by Pappus: Ø40 × 60 and Ø50 × 120
    expect(Math.abs(back[0].mass!.V / (Math.PI * (20 ** 2 * 60 + 25 ** 2 * 120)) - 1)).toBeLessThan(1e-9);
  });
});

describe('CAD sweeps example worksheet', () => {
  it('builds the spring, the threaded bolt and the swept pipe; the worksheet uses their data', () => {
    const ws = sweepExample();
    const out = evaluateWorksheet(ws);
    const tex = new Map<string, string>();
    for (const r of ws.regions) {
      const res = out.results.get(r.id);
      if (r.kind === 'math') {
        expect((res as MathResult).error, r.source).toBeUndefined();
        tex.set(r.source, (res as MathResult).tex);
      }
    }
    const cad = ws.regions.find((r) => r.kind === 'cad')!;
    const res = out.results.get(cad.id) as CadResult;
    expect(res.featureError).toBeUndefined();
    expect(res.design!.brep).toBe(true);
    const V = (cid: string) => res.design!.components[cid]!.V;
    // coil: π (d/2)² n √((π D)² + p²); the helix is approximated to 10⁻⁷
    expect(Math.abs(V('cs') / (Math.PI * 1.5 ** 2 * 6 * Math.hypot(30 * Math.PI, 8)) - 1)).toBeLessThan(1e-6);
    // pipe: the annulus times the path, 80 + π/2·40 + 80 (exact: cylinders and a torus)
    expect(Math.abs(V('cp') / ((Math.PI / 4) * (400 - 256) * (160 + 20 * Math.PI)) - 1)).toBeLessThan(1e-9);
    // bolt: head + shank less the thread's groove (screw flux, sweep.test.ts); a little less than the plain bolt
    const plain = (3 * Math.sqrt(3) / 2) * (18 / Math.sqrt(3)) ** 2 * 7.5 + Math.PI * 36 * 50;
    expect(V('cb')).toBeLessThan(plain);
    expect(V('cb')).toBeGreaterThan(plain - 20 * 30);
    // k = G d⁴ / (8 D³ n) = 81 500 · 81 / (8 · 27 000 · 6) = 5.094 N/mm; F_t,Rd = 0.9 · 800 · 84.27 / 1.25 = 48.5 kN
    expect([...tex.entries()].find(([s]) => s.startsWith('k_s'))![1]).toContain('5.09');
    expect([...tex.entries()].find(([s]) => s.startsWith('F_tRd'))![1]).toContain('48.5');
  });
});

describe('CAD sketcher curves example worksheet', () => {
  it('exact volumes from an ellipse, a closed spline and text; the hole keeps to the projected edge as the plate widens', () => {
    const rel = (v: number, want: number) => Math.abs(v / want - 1);
    for (const w of [120, 160]) {
      const ws0 = curvesExample();
      const ws = { ...ws0, regions: ws0.regions.map((r) => (r.kind === 'math' && r.source.startsWith('w_p') ? { ...r, source: `w_p := ${w} mm` } : r)) };
      const out = evaluateWorksheet(ws);
      for (const r of ws.regions) if (r.kind === 'math') expect((out.results.get(r.id) as MathResult).error, r.source).toBeUndefined();
      const res = out.results.get(ws.regions.find((r) => r.kind === 'cad')!.id) as CadResult;
      expect(res.featureError).toBeUndefined();
      expect(res.design!.errors).toEqual({});
      expect(res.design!.brep).toBe(true);
      expect(res.dof).toBe(0);
      const C = res.design!.components;
      // plate: the box less the elliptical pocket π·a·b·d (an exact ellipse) and the hole
      const hole = Math.PI * 5 ** 2 * 10, Vp = w * 80 * 10 - Math.PI * 30 * 18 * 4 - hole;
      expect(rel(C.cpl!.V, Vp)).toBeLessThan(1e-9);
      // the hole 15 left of the plate's projected right-hand edge (x = w/2): the centroid moves by its moment
      expect(Math.abs(C.cpl!.xg - (-hole * (w / 2 - 15)) / Vp)).toBeLessThan(1e-9);
      // and its moment of inertia about the vertical axis through its centroid: the box's
      // V(w² + h²)/12 less the pocket's Vp(a² + b²)/4 and the hole's Vh(r²/2 + x²), moved to
      // the centroid (Steiner); ρ = 7850 kg/m³ in kg/mm³
      const Vpk = Math.PI * 30 * 18 * 4, xh = w / 2 - 15;
      const Jz = (w * 80 * 10 * (w * w + 80 * 80)) / 12 - (Vpk * (30 * 30 + 18 * 18)) / 4 - hole * (5 * 5 / 2 + xh * xh) - Vp * C.cpl!.xg ** 2;
      expect(rel(C.cpl!.Izz, Jz)).toBeLessThan(1e-8);
      expect(rel(C.cpl!.Im![2], 7.85e-6 * Jz)).toBeLessThan(1e-8);
      expect(res.design!.sketches.sq2.points.hc[0]).toBeCloseTo(w / 2 - 15, 9);
      // cam: the closed spline's area from the sketch (Green's theorem, exact per knot span) times its thickness
      expect(rel(C.ccm!.V, res.design!.sketches.sm0.section!.A * 12)).toBeLessThan(1e-9);
      // tag: what the engraving took is the letters' area (their counters left standing) times its depth
      expect(rel(70 * 24 * 3 - C.ctg!.V, res.design!.sketches.st1.section!.A * 0.8)).toBeLessThan(1e-7);
    }
  });
});
