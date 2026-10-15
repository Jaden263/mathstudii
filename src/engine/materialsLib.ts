// Worksheet functions for the section and material library:
//   s := section("HEB 200")      s.A, s.I_y, s.W_pl_y, s.i_z …
//   m := steel("S355")            m.f_y, m.E …   steel("S355", 50 mm) for thick plates
//   c := concrete("C30/37")       c.f_ck, c.f_ctm, c.E_cm …
//   t := timber("GL24h")          t.f_m_k, t.E_0_mean …
//   r := rebar("B500B")           r.f_yk, r.E_s …
//   bars(4, 16 mm)                area of 4 Ø16 bars
import { math, isUnit } from './math';
import { sectionProps } from './sections';
import { steelGrade, concreteGrade, timberGrade, rebarGrade } from './materials';

const u = (v: number, unit: string) => math.unit(v, unit);

function str(v: unknown, fn: string): string {
  if (typeof v !== 'string') throw new Error(`${fn} needs a name in quotes, e.g. ${fn}("${fn === 'section' ? 'HEB 200' : fn === 'steel' ? 'S355' : fn === 'concrete' ? 'C30/37' : fn === 'timber' ? 'C24' : 'B500B'}")`);
  return v;
}

function section(name: unknown) {
  const p = sectionProps(str(name, 'section'));
  return {
    name: p.name,
    h: u(p.h, 'mm'), b: u(p.b, 'mm'), t_w: u(p.t_w, 'mm'), t_f: u(p.t_f, 'mm'), r: u(p.r, 'mm'),
    A: u(p.A, 'mm^2'), A_vz: u(p.A_vz, 'mm^2'),
    I_y: u(p.I_y, 'mm^4'), I_z: u(p.I_z, 'mm^4'),
    W_el_y: u(p.W_el_y, 'mm^3'), W_el_z: u(p.W_el_z, 'mm^3'), W_pl_y: u(p.W_pl_y, 'mm^3'), W_pl_z: u(p.W_pl_z, 'mm^3'),
    i_y: u(p.i_y, 'mm'), i_z: u(p.i_z, 'mm'),
    I_t: u(p.I_t, 'mm^4'), I_w: u(p.I_w, 'mm^6'),
    mass: u(p.mass, 'kg/m'), g: u(p.mass * 9.80665 / 1000, 'kN/m'), surface: u(p.surface, 'm^2/m'),
  };
}

function steel(grade: unknown, t?: unknown) {
  let tmm = 0;
  if (t !== undefined) {
    if (!isUnit(t)) throw new Error('steel(grade, t): give the thickness with a unit, e.g. 50 mm');
    tmm = t.toNumber('mm');
  }
  const g = steelGrade(str(grade, 'steel'), tmm);
  const eps = Math.sqrt(235 / g.f_y);
  const rho = u(7850, 'kg/m^3');
  return {
    name: g.name, f_y: u(g.f_y, 'MPa'), f_u: u(g.f_u, 'MPa'), E: u(210, 'GPa'), G: u(81, 'GPa'), nu: 0.3,
    rho, ρ: rho, alpha_T: u(1.2e-5, '1/K'), epsilon: eps, ε: eps,
  };
}

function concrete(grade: unknown) {
  const c = concreteGrade(str(grade, 'concrete'));
  const rho = u(2500, 'kg/m^3');
  return {
    name: c.name, f_ck: u(c.f_ck, 'MPa'), f_ck_cube: u(c.f_ck_cube, 'MPa'), f_cm: u(c.f_cm, 'MPa'), f_ctm: u(c.f_ctm, 'MPa'),
    f_ctk_005: u(c.f_ctk_005, 'MPa'), f_ctk_095: u(c.f_ctk_095, 'MPa'), E_cm: u(c.E_cm, 'GPa'),
    eps_c1: c.eps_c1 / 1000, eps_cu1: c.eps_cu1 / 1000, eps_c2: c.eps_c2 / 1000, eps_cu2: c.eps_cu2 / 1000, n: c.n,
    eps_c3: c.eps_c3 / 1000, eps_cu3: c.eps_cu3 / 1000, nu: 0.2, rho, ρ: rho, alpha_T: u(1e-5, '1/K'),
  };
}

function timber(grade: unknown) {
  const t = timberGrade(str(grade, 'timber'));
  const rk = u(t.rho_k, 'kg/m^3'), rm = u(t.rho_mean, 'kg/m^3');
  return {
    name: t.name, f_m_k: u(t.f_m_k, 'MPa'), f_t_0_k: u(t.f_t_0_k, 'MPa'), f_t_90_k: u(t.f_t_90_k, 'MPa'),
    f_c_0_k: u(t.f_c_0_k, 'MPa'), f_c_90_k: u(t.f_c_90_k, 'MPa'), f_v_k: u(t.f_v_k, 'MPa'),
    E_0_mean: u(t.E_0_mean, 'GPa'), E_0_05: u(t.E_0_05, 'GPa'), E_90_mean: u(t.E_90_mean, 'GPa'), G_mean: u(t.G_mean, 'GPa'),
    rho_k: rk, ρ_k: rk, rho_mean: rm, ρ_mean: rm,
  };
}

function rebar(grade: unknown) {
  const r = rebarGrade(str(grade, 'rebar'));
  return { name: r.name, f_yk: u(r.f_yk, 'MPa'), E_s: u(200, 'GPa'), k: r.k, eps_uk: r.eps_uk / 100 };
}

function bars(n: unknown, d: unknown) {
  if (typeof n !== 'number' || !isUnit(d)) throw new Error('bars(n, d): a count and a diameter with a unit, e.g. bars(4, 16 mm)');
  return math.multiply(n * Math.PI / 4, math.multiply(d, d));
}

math.import({ section, steel, concrete, timber, rebar, bars }, { override: false });
