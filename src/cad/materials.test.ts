// Masses from the materials library, and what the worksheet reads of a material.
import { describe, expect, it } from 'vitest';
import { evaluateWorksheet, type CadResult, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type CadRegion } from '../model/types';
import { rect, single, solve } from './occ/fixtures';
import type { CadDesign, DesignItem } from './design';
import { CAD_MATERIALS, cadMaterial, materialOfBody, shearModulus } from './materials';
import { bomRows } from './annotations';
import { designKey, designNumbers } from './keys';

const near = (v: number, want: number, rel = 1e-9) => expect(Math.abs(v - want) / Math.abs(want)).toBeLessThan(rel);

/** A 100 × 50 × 20 mm block, and a 40 × 40 × 10 mm one beside it when asked. */
function blocks(two = false): DesignItem[] {
  return [
    { kind: 'sketch', id: 's1', name: 'S1', plane: { ref: 'XY' }, sketch: rect('a', 0, 0, 100, 50) },
    { kind: 'extrude', id: 'f1', name: 'Block', sketch: 's1', extent: { type: 'one', d: '20' }, op: 'new' },
    ...(two ? [
      { kind: 'sketch', id: 's2', name: 'S2', plane: { ref: 'XY' }, sketch: rect('b', 200, 0, 240, 40) },
      { kind: 'extrude', id: 'f2', name: 'Pad', sketch: 's2', extent: { type: 'one', d: '10' }, op: 'new' },
    ] as DesignItem[] : []),
  ];
}

const withComp = (d: CadDesign, patch: Partial<CadDesign['components'][number]>): CadDesign => ({ ...d, components: d.components.map((c) => ({ ...c, ...patch })) });

describe('materials library', () => {
  it('lists every material with a density, a modulus, an expansion, a known appearance and a source', () => {
    expect(CAD_MATERIALS.length).toBeGreaterThanOrEqual(26);
    for (const m of CAD_MATERIALS) {
      expect(m.rho, m.id).toBeGreaterThan(300);
      expect(m.E, m.id).toBeGreaterThan(1);
      expect(m.alpha, m.id).toBeGreaterThan(1e-6);
      expect(m.source.length, m.id).toBeGreaterThan(5);
    }
    expect(new Set(CAD_MATERIALS.map((m) => m.id)).size).toBe(CAD_MATERIALS.length);
  });

  it('takes the structural values from the Eurocodes', () => {
    // EN 1993-1-1 Table 3.1 (t ≤ 40 mm) and §3.2.6
    expect(cadMaterial('S355')).toMatchObject({ rho: 7850, E: 210, nu: 0.3, fy: 355, fu: 490, alpha: 12e-6 });
    expect(cadMaterial('S460')).toMatchObject({ fy: 460, fu: 540 });
    // EN 1999-1-1 §3.2.5: E = 70 000 N/mm², G = 27 000 N/mm²
    expect(cadMaterial('EN AW-6082-T6')).toMatchObject({ E: 70, G: 27, alpha: 23e-6 });
    // EN 338: C24 E0,mean 11 GPa, ρ_mean 420 kg/m³
    expect(cadMaterial('C24')).toMatchObject({ E: 11, rho: 420 });
    // EN 1992-1-1: E_cm = 22 (f_cm/10)^0.3 GPa = 32.84 GPa for C30/37
    near(cadMaterial('C30/37')!.E, 22 * 3.8 ** 0.3);
    // isotropic G = E / 2(1 + ν) where the standard gives none: Ti-6Al-4V 113.8 / 2.684
    near(shearModulus(cadMaterial('Ti-6Al-4V')!)!, 113.8 / (2 * 1.342));
  });
});

describe('masses from materials', () => {
  it('an S355 block of 100 × 50 × 20 mm weighs 0.785 kg', () => {
    const { res } = solve(withComp(single(blocks()), { material: 'S355' }), [], '');
    // 1e5 mm³ · 7850 kg/m³ = 0.785 kg
    near(res.design!.total!.m!, 0.785);
    near(res.design!.bodies.c1[0].mass!.m!, 0.785);
    near(res.design!.components.c1!.m!, 0.785);
  });

  it('a density expression wins over the material (old documents keep their masses)', () => {
    const { res } = solve(withComp(single(blocks()), { material: 'S355', density: '7000 kg/m^3' }), [], '');
    near(res.design!.total!.m!, 0.7);
    // the part's density expression wins over the part's material
    const part = solve({ ...single(blocks()), material: 'PA6' }, [], '7200 kg/m^3').res;
    near(part.design!.total!.m!, 0.72);
    // the part's material where no expression is given
    const pa6 = solve({ ...single(blocks()), material: 'PA6' }, [], '').res;
    near(pa6.design!.total!.m!, 1e5 * 1130e-9);
  });

  it('a body of its own material overrides its component', () => {
    const d = withComp(single(blocks(true)), { material: 'S355', bodyMaterials: { f2: 'EN AW-6082-T6' } });
    const { res } = solve(d, [], '7200 kg/m^3');
    const [block, pad] = res.design!.bodies.c1;
    const V1 = 100 * 50 * 20, V2 = 40 * 40 * 10;
    near(block.mass!.m!, V1 * 7850e-9);
    near(pad.mass!.m!, V2 * 2700e-9);
    const m = V1 * 7850e-9 + V2 * 2700e-9;
    near(res.design!.components.c1!.m!, m);
    near(res.design!.total!.m!, m);
    // the centre of gravity weighs the two: the block's at x = 50, the pad's at x = 220
    near(res.design!.total!.xg, (V1 * 7850e-9 * 50 + V2 * 2700e-9 * 220) / m);
    // its inertia about z through the CoG: each about its own centre plus the parallel-axis terms
    const xg = res.design!.total!.xg, yg = res.design!.total!.yg;
    const m1 = V1 * 7850e-9, m2 = V2 * 2700e-9;
    const Izz = m1 * (100 ** 2 + 50 ** 2) / 12 + m1 * ((50 - xg) ** 2 + (25 - yg) ** 2) + m2 * (40 ** 2 + 40 ** 2) / 12 + m2 * ((220 - xg) ** 2 + (20 - yg) ** 2);
    near(res.design!.total!.Im![2], Izz, 1e-9);
    expect(res.featureError).toBeUndefined();
  });

  it('an unknown material is reported, and the bodies still weigh', () => {
    const d = withComp(single(blocks(true)), { material: 'Unobtainium', bodyMaterials: { f2: 'S235' } });
    const { res } = solve(d, [], '');
    expect(res.featureError).toMatch(/unknown material "Unobtainium"/);
    near(res.design!.bodies.c1[1].mass!.m!, 40 * 40 * 10 * 7850e-9);
    expect(res.design!.bodies.c1[0].mass!.m).toBeUndefined();
  });

  it('a document from before materials keeps its masses and its build key', () => {
    // the component's density, else the part's: as before
    const d: CadDesign = {
      ...single(blocks(true)),
      components: [{ ...single(blocks(true)).components[0], density: '2700 kg/m^3', color: '#8fa3bf' }],
    };
    const { res, numbers } = solve(d, [], '7850 kg/m^3');
    near(res.design!.total!.m!, (100 * 50 * 20 + 40 * 40 * 10) * 2700e-9);
    expect(numbers.params.c1).toEqual({ density: 2700e-9 });
    // appearances never rebuild the part: the key stays
    const looks = withComp(d, { appearance: 'anodised-red', bodyAppearances: { f1: 'chrome' }, faceAppearances: [] });
    expect(designKey(looks, numbers)).toBe(designKey(d, numbers));
  });
});

describe('materials in the worksheet', () => {
  function sheet(design: CadDesign, lines: string[], density = '') {
    const ws = emptyWorksheet();
    const cad = createRegion('cad', 20, 40, { name: 'p', design, density }) as CadRegion;
    const maths = lines.map((s, i) => createRegion('math', 20, 400 + 30 * i, { source: s }));
    ws.regions = [cad, ...maths];
    const out = evaluateWorksheet(ws);
    return { res: out.results.get(cad.id) as CadResult, tex: maths.map((r) => (out.results.get(r.id) as MathResult)) };
  }

  it('reads a body’s material: p.Body2.material.E, .rho, .f_y; the component’s on the part', () => {
    const d = withComp(single(blocks(true)), { material: 'S355', bodyMaterials: { f2: 'EN AW-6082-T6' } });
    const { tex } = sheet(d, ['p.Body2.material.E = GPa', 'p.Body2.material.rho = kg/m^3', 'p.Body1.material.f_y = MPa', 'p.material.fy = MPa', 'p.Body2.material.name =', 'p.material.alpha_T = 1/K']);
    for (const t of tex) expect(t.error).toBeUndefined();
    expect(tex[0].tex).toContain('70');
    expect(tex[1].tex).toContain('2700');
    expect(tex[2].tex).toContain('355');
    expect(tex[3].tex).toContain('355');
    expect(tex[4].tex).toContain('6082');
    expect(tex[5].tex).toMatch(/1\.2\s*\\cdot\s*10\^\{-5\}|0\.000012/);
  });

  it('a density expression with a material: the material’s properties, the expression’s density', () => {
    const d = withComp(single(blocks()), { material: 'S355', density: '7800 kg/m^3' });
    const { tex } = sheet(d, ['p.material.rho = kg/m^3', 'p.material.E = GPa']);
    expect(tex[0].tex).toContain('7800');
    expect(tex[1].tex).toContain('210');
  });

  it('without a library material there is no material record (a custom density)', () => {
    const { tex } = sheet(single(blocks()), ['p.material.E ='], '7850 kg/m^3');
    expect(tex[0].error).toBeDefined();
  });
});

describe('material names', () => {
  it('the parts list names the library material, else the one the density names', () => {
    const d: CadDesign = {
      version: 2, components: [
        { id: 'a', name: 'A', items: [], material: 'EN-GJL-250' },
        { id: 'b', name: 'B', items: [], density: '7850 kg/m^3' },
        { id: 'c', name: 'C', items: [] },
      ],
      occurrences: [{ id: 'oa', component: 'a' }, { id: 'ob', component: 'b' }, { id: 'oc', component: 'c' }], joints: [],
    };
    expect(bomRows(d, { density: '2700 kg/m^3' }).map((r) => r.material)).toEqual(['EN-GJL-250', 'Steel', 'Aluminium']);
    expect(bomRows({ ...d, material: 'PEEK' }, {}).map((r) => r.material)).toEqual(['EN-GJL-250', 'Steel', 'PEEK']);
    expect(materialOfBody({ ...d, material: 'PEEK' }, d.components[1])).toBeUndefined();
  });

  it('designNumbers of a material part carry its density', () => {
    const { res } = solve(withComp(single(blocks()), { material: 'Ti-6Al-4V' }), [], '');
    near(designNumbers(res.design!).params.c1.density, 4430e-9);
  });
});
