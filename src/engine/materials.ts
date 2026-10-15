// Material grades as plain numbers (MPa, GPa, kg/m³). Steel EN 1993-1-1 Table 3.1,
// concrete EN 1992-1-1 Table 3.1 (from its formulas, so values are unrounded),
// timber EN 338:2016 (softwood) and EN 14080 (glulam), reinforcement EN 1992-1-1 Annex C.

export interface SteelGrade { name: string; f_y: number; f_u: number }

const STEEL: Record<string, { fy: [number, number]; fu: [number, number] }> = {
  // [t ≤ 40 mm, 40 < t ≤ 80 mm]
  S235: { fy: [235, 215], fu: [360, 360] },
  S275: { fy: [275, 255], fu: [430, 410] },
  S355: { fy: [355, 335], fu: [490, 470] },
  S420: { fy: [420, 390], fu: [520, 520] },
  S450: { fy: [440, 410], fu: [550, 550] },
  S460: { fy: [460, 430], fu: [540, 540] },
};
export const STEEL_GRADES = Object.keys(STEEL);

/** Yield and ultimate strength (MPa) for a grade and element thickness (mm). */
export function steelGrade(name: string, t = 0): SteelGrade {
  const key = name.trim().toUpperCase().replace(/\s+/g, '').replace(/(JR|J0|J2|K2|N|NL|M|ML|W)+$/, '');
  const g = STEEL[key];
  if (!g) throw new Error(`Unknown steel grade "${name}" (${STEEL_GRADES.join(', ')})`);
  if (t > 80) throw new Error(`EN 1993-1-1 Table 3.1 covers thicknesses up to 80 mm (t = ${t} mm)`);
  const k = t > 40 ? 1 : 0;
  return { name: key, f_y: g.fy[k], f_u: g.fu[k] };
}

export interface ConcreteGrade {
  name: string;
  f_ck: number; f_ck_cube: number; f_cm: number; f_ctm: number; f_ctk_005: number; f_ctk_095: number;
  /** GPa */
  E_cm: number;
  /** strains in ‰ */
  eps_c1: number; eps_cu1: number; eps_c2: number; eps_cu2: number; n: number; eps_c3: number; eps_cu3: number;
}

const CUBE: Record<number, number> = { 12: 15, 16: 20, 20: 25, 25: 30, 30: 37, 35: 45, 40: 50, 45: 55, 50: 60, 55: 67, 60: 75, 70: 85, 80: 95, 90: 105 };
export const CONCRETE_GRADES = Object.entries(CUBE).map(([c, k]) => `C${c}/${k}`);

export function concreteGrade(name: string): ConcreteGrade {
  const m = /^C\s*(\d+)(?:\s*\/\s*(\d+))?$/i.exec(name.trim());
  const fck = m ? +m[1] : NaN;
  if (!m || !(fck in CUBE)) throw new Error(`Unknown concrete class "${name}" (${CONCRETE_GRADES.join(', ')})`);
  const fcm = fck + 8;
  const high = fck > 50;
  const fctm = high ? 2.12 * Math.log(1 + fcm / 10) : 0.3 * fck ** (2 / 3);
  const eps_c1 = Math.min(0.7 * fcm ** 0.31, 2.8);
  const eps_cu1 = high ? 2.8 + 27 * ((98 - fcm) / 100) ** 4 : 3.5;
  const eps_c2 = high ? 2.0 + 0.085 * (fck - 50) ** 0.53 : 2.0;
  const eps_cu2 = high ? 2.6 + 35 * ((90 - fck) / 100) ** 4 : 3.5;
  const n = high ? 1.4 + 23.4 * ((90 - fck) / 100) ** 4 : 2.0;
  const eps_c3 = high ? 1.75 + 0.55 * ((fck - 50) / 40) : 1.75;
  return {
    name: `C${fck}/${CUBE[fck]}`, f_ck: fck, f_ck_cube: CUBE[fck], f_cm: fcm, f_ctm: fctm, f_ctk_005: 0.7 * fctm, f_ctk_095: 1.3 * fctm,
    E_cm: 22 * (fcm / 10) ** 0.3, eps_c1, eps_cu1, eps_c2, eps_cu2, n, eps_c3, eps_cu3: eps_cu2,
  };
}

export interface TimberGrade {
  name: string;
  /** MPa */
  f_m_k: number; f_t_0_k: number; f_t_90_k: number; f_c_0_k: number; f_c_90_k: number; f_v_k: number;
  /** GPa */
  E_0_mean: number; E_0_05: number; E_90_mean: number; G_mean: number;
  /** kg/m³ */
  rho_k: number; rho_mean: number;
}

// fm, ft0, ft90, fc0, fc90, fv, E0mean, E005, E90mean, Gmean, ρk, ρmean
const TIMBER: Record<string, number[]> = {
  C14: [14, 7.2, 0.4, 16, 2.0, 3.0, 7.0, 4.7, 0.23, 0.44, 290, 350],
  C16: [16, 8.5, 0.4, 17, 2.2, 3.2, 8.0, 5.4, 0.27, 0.5, 310, 370],
  C18: [18, 10, 0.4, 18, 2.2, 3.4, 9.0, 6.0, 0.3, 0.56, 320, 380],
  C20: [20, 11.5, 0.4, 19, 2.3, 3.6, 9.5, 6.4, 0.32, 0.59, 330, 400],
  C22: [22, 13, 0.4, 20, 2.4, 3.8, 10.0, 6.7, 0.33, 0.63, 340, 410],
  C24: [24, 14.5, 0.4, 21, 2.5, 4.0, 11.0, 7.4, 0.37, 0.69, 350, 420],
  C27: [27, 16.5, 0.4, 22, 2.5, 4.0, 11.5, 7.7, 0.38, 0.72, 360, 430],
  C30: [30, 19, 0.4, 24, 2.7, 4.0, 12.0, 8.0, 0.4, 0.75, 380, 460],
  C35: [35, 22.5, 0.4, 25, 2.7, 4.0, 13.0, 8.7, 0.43, 0.81, 390, 470],
  C40: [40, 26, 0.4, 27, 2.8, 4.0, 14.0, 9.4, 0.47, 0.88, 400, 480],
  GL20h: [20, 16, 0.5, 20, 2.5, 3.5, 8.4, 7.0, 0.3, 0.65, 340, 370],
  GL22h: [22, 17.6, 0.5, 22, 2.5, 3.5, 10.5, 8.8, 0.3, 0.65, 370, 410],
  GL24h: [24, 19.2, 0.5, 24, 2.5, 3.5, 11.5, 9.6, 0.3, 0.65, 385, 420],
  GL26h: [26, 20.8, 0.5, 26, 2.5, 3.5, 12.1, 10.1, 0.3, 0.65, 405, 445],
  GL28h: [28, 22.3, 0.5, 28, 2.5, 3.5, 12.6, 10.5, 0.3, 0.65, 425, 460],
  GL30h: [30, 24, 0.5, 30, 2.5, 3.5, 13.6, 11.3, 0.3, 0.65, 430, 480],
  GL32h: [32, 25.6, 0.5, 32, 2.5, 3.5, 14.2, 11.8, 0.3, 0.65, 440, 490],
};
export const TIMBER_GRADES = Object.keys(TIMBER);

export function timberGrade(name: string): TimberGrade {
  const key = TIMBER_GRADES.find((k) => k.toLowerCase() === name.trim().toLowerCase().replace(/\s+/g, ''));
  if (!key) throw new Error(`Unknown timber class "${name}" (${TIMBER_GRADES.join(', ')})`);
  const [f_m_k, f_t_0_k, f_t_90_k, f_c_0_k, f_c_90_k, f_v_k, E_0_mean, E_0_05, E_90_mean, G_mean, rho_k, rho_mean] = TIMBER[key];
  return { name: key, f_m_k, f_t_0_k, f_t_90_k, f_c_0_k, f_c_90_k, f_v_k, E_0_mean, E_0_05, E_90_mean, G_mean, rho_k, rho_mean };
}

export interface RebarGrade { name: string; f_yk: number; k: number; eps_uk: number }

const REBAR: Record<string, [number, number]> = { A: [1.05, 2.5], B: [1.08, 5.0], C: [1.15, 7.5] };

/** B500A / B500B / B500C, or any B<f_yk><class> (EN 1992-1-1 Annex C, k = (f_t/f_y)k minimum). */
export function rebarGrade(name: string): RebarGrade {
  const m = /^B\s*(\d{3})\s*([ABC])$/i.exec(name.trim());
  if (!m || +m[1] < 400 || +m[1] > 600) throw new Error(`Unknown reinforcement "${name}" (B500A, B500B, B500C)`);
  const [k, eps] = REBAR[m[2].toUpperCase()];
  return { name: `B${m[1]}${m[2].toUpperCase()}`, f_yk: +m[1], k, eps_uk: eps };
}
