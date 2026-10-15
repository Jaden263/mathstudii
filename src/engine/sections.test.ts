import { describe, expect, it } from 'vitest';
import { sectionProps, ROLLED_SECTIONS } from './sections';
import { concreteGrade, steelGrade, timberGrade, rebarGrade } from './materials';
import { evaluateWorksheet, type MathResult } from './evaluator';
import { createRegion, emptyWorksheet } from '../model/types';

// catalogue values (ArcelorMittal / EN 10210-2), cm-based
const close = (v: number, ref: number, tol = 0.01) => expect(Math.abs(v / ref - 1)).toBeLessThan(tol);

describe('section library', () => {
  it('matches catalogue values for rolled sections', () => {
    const ipe = sectionProps('IPE 300');
    close(ipe.A / 1e2, 53.81);
    close(ipe.I_y / 1e4, 8356);
    close(ipe.I_z / 1e4, 603.8);
    close(ipe.W_pl_y / 1e3, 628.4);
    close(ipe.W_pl_z / 1e3, 125.2);
    close(ipe.I_t / 1e4, 20.12);
    close(ipe.A_vz / 1e2, 25.68);
    close(ipe.mass, 42.2);
    const heb = sectionProps('HE 200 B');
    expect(heb.name).toBe('HEB 200');
    close(heb.I_y / 1e4, 5696);
    close(heb.W_pl_y / 1e3, 642.5);
    close(heb.I_t / 1e4, 59.28);
    close(sectionProps('hea200').I_y / 1e4, 3692);
    close(sectionProps('HEM 300').W_pl_y / 1e3, 4078);
    expect(ROLLED_SECTIONS.length).toBeGreaterThan(80);
  });

  it('computes hollow sections of any size', () => {
    const chs = sectionProps('CHS 168.3x5');
    close(chs.A / 1e2, 25.7);
    close(chs.I_y / 1e4, 856);
    const shs = sectionProps('SHS 100×5');
    close(shs.I_y / 1e4, 279);
    close(shs.W_pl_y / 1e3, 66.4);
    const rhs = sectionProps('RHS 200x100x6.3');
    close(rhs.I_y / 1e4, 1829);
    close(rhs.I_z / 1e4, 613);
    expect(() => sectionProps('IPE 999')).toThrow(/not a standard size/);
    expect(() => sectionProps('XYZ')).toThrow(/Unknown section/);
  });

  it('knows material grades', () => {
    expect(steelGrade('S355J2').f_y).toBe(355);
    expect(steelGrade('S355', 60).f_y).toBe(335);
    const c = concreteGrade('C30/37');
    expect(c.f_cm).toBe(38);
    close(c.f_ctm, 2.9, 0.01);
    close(c.E_cm, 33, 0.01);
    expect(concreteGrade('C70/85').eps_cu2).toBeLessThan(3.5);
    expect(timberGrade('gl24h').f_m_k).toBe(24);
    expect(rebarGrade('B500B').eps_uk).toBe(5);
  });

  it('works in the worksheet with units', () => {
    const srcs = ['s := section("IPE 300")', 'm := steel("S355")', 's.W_pl_y m.f_y =', 'bars(4, 16 mm) =', 'concrete("C30/37").f_ck ='];
    const ws = { ...emptyWorksheet(), regions: srcs.map((src, i) => createRegion('math', 0, i * 30, { source: src })) };
    const out = evaluateWorksheet(ws);
    const tex = ws.regions.map((r) => (out.results.get(r.id) as MathResult).tex);
    expect(tex[2]).toContain('223.0');
    expect(tex[2]).toContain('kN');
    expect(tex[3]).toContain('804.2');
    expect(tex[4]).toContain('30\\ \\mathrm{MPa}');
  });
});
