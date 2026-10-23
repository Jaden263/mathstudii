// Physical materials of CAD bodies: density, elastic constants, strengths and thermal
// expansion of common engineering materials, each from its standard (the plastics from
// typical datasheet values, ISO 527 at 23 °C). A component, or a single body, takes one:
// its density sets the mass unless a density expression stands in its place, and the
// worksheet reads the rest (part.Body1.material.E, .rho, .f_y).
//
// Which density a body weighs with, most specific first (expressions win at their level,
// so documents from before materials keep their masses):
//   the body's own material → the component's density expression → the component's
//   material → the part's density expression → the part's material → no mass.
import { math } from '../engine/math';
import { concreteGrade, steelGrade, timberGrade } from '../engine/materials';
import type { CadComponent, CadDesign } from './design';

export type MaterialFamily = 'Structural steel' | 'Stainless steel' | 'Aluminium' | 'Cast iron' | 'Copper alloy' | 'Titanium' | 'Plastic' | 'Timber' | 'Concrete' | 'Glass';

export interface CadMaterial {
  /** The designation, as the standard writes it (also its key in documents). */
  id: string;
  name: string;
  family: MaterialFamily;
  /** Density, kg/m³. */
  rho: number;
  /** Young's modulus, GPa (timber: E0,mean along the grain). */
  E: number;
  /** Poisson's ratio (none for timber, which is orthotropic). */
  nu?: number;
  /** Shear modulus, GPa: the standard's, else E / 2(1 + ν). */
  G?: number;
  /** Yield or 0.2 % proof strength, MPa (grey cast iron: 0.1 % proof; none for brittle materials). */
  fy?: number;
  /** Tensile strength, MPa (timber f_t,0,k, glass its characteristic bending strength, concrete f_ctm). */
  fu?: number;
  /** Compressive strength, MPa (concrete f_ck, timber f_c,0,k). */
  fc?: number;
  /** Linear thermal expansion, 1/K (about 20–100 °C). */
  alpha: number;
  /** Default appearance (appearances.ts). */
  appearance: string;
  /** Where the numbers come from. */
  source: string;
}

const STEEL_SRC = 'EN 10025-2/-3/-4; f_y, f_u for t ≤ 40 mm, E, G, ν, α from EN 1993-1-1 §3.2.6 and Table 3.1; ρ 7850 kg/m³';
const steel = (id: string): CadMaterial => {
  const g = steelGrade(id);
  return { id, name: `${id} structural steel`, family: 'Structural steel', rho: 7850, E: 210, nu: 0.3, G: 81, fy: g.f_y, fu: g.f_u, alpha: 12e-6, appearance: 'steel-satin', source: STEEL_SRC };
};

const timber = (id: string, src: string): CadMaterial => {
  const t = timberGrade(id);
  // the mean density weighs the part (ρ_k is the 5 % fractile for design); α along the grain
  return {
    id, name: `${id} ${id.startsWith('GL') ? 'glulam' : 'softwood'}`, family: 'Timber', rho: t.rho_mean, E: t.E_0_mean, G: t.G_mean, fu: t.f_t_0_k, fc: t.f_c_0_k,
    alpha: 4e-6, appearance: 'wood-spruce', source: `${src}; α along the grain: Wood Handbook FPL-GTR-190 (3–5·10⁻⁶ /K)`,
  };
};

const c30 = concreteGrade('C30/37');

export const CAD_MATERIALS: CadMaterial[] = [
  steel('S235'), steel('S275'), steel('S355'), steel('S460'),
  {
    id: '1.4301', name: '1.4301 (X5CrNi18-10, 304)', family: 'Stainless steel', rho: 7900, E: 200, nu: 0.3, G: 76.9, fy: 210, fu: 520, alpha: 16e-6, appearance: 'stainless-brushed',
    source: 'EN 1993-1-4 Table 2.1 (hot-rolled plate, t ≤ 75 mm) and §2.1.3; ρ, α: EN 10088-1 Annex E',
  },
  {
    id: '1.4404', name: '1.4404 (X2CrNiMo17-12-2, 316L)', family: 'Stainless steel', rho: 8000, E: 200, nu: 0.3, G: 76.9, fy: 220, fu: 520, alpha: 16e-6, appearance: 'stainless-brushed',
    source: 'EN 1993-1-4 Table 2.1 (hot-rolled plate, t ≤ 75 mm) and §2.1.3; ρ, α: EN 10088-1 Annex E',
  },
  {
    id: 'EN AW-6061-T6', name: 'EN AW-6061-T6 aluminium', family: 'Aluminium', rho: 2700, E: 70, nu: 0.3, G: 27, fy: 240, fu: 260, alpha: 23e-6, appearance: 'aluminium-brushed',
    source: 'EN 1999-1-1 Table 3.2b (extrusions) and §3.2.5; ρ: Aluminum Association Teal Sheets',
  },
  {
    id: 'EN AW-6082-T6', name: 'EN AW-6082-T6 aluminium', family: 'Aluminium', rho: 2700, E: 70, nu: 0.3, G: 27, fy: 260, fu: 310, alpha: 23e-6, appearance: 'aluminium-brushed',
    source: 'EN 1999-1-1 Table 3.2b (extrusions, 5 < t ≤ 15 mm) and §3.2.5; ρ: Aluminum Association Teal Sheets',
  },
  {
    id: 'EN AW-5083-H111', name: 'EN AW-5083-H111 aluminium', family: 'Aluminium', rho: 2660, E: 70, nu: 0.3, G: 27, fy: 110, fu: 270, alpha: 23e-6, appearance: 'aluminium-brushed',
    source: 'EN 1999-1-1 Table 3.2b (O/H111) and §3.2.5; ρ: Aluminum Association Teal Sheets',
  },
  {
    id: 'EN AW-7075-T6', name: 'EN AW-7075-T6 aluminium', family: 'Aluminium', rho: 2810, E: 71.7, nu: 0.33, fy: 480, fu: 540, alpha: 23.6e-6, appearance: 'aluminium-polished',
    source: 'EN 755-2 (extruded bars, D ≤ 25 mm); E, ν, α: ASM Handbook Vol. 2; ρ: Aluminum Association Teal Sheets',
  },
  {
    id: 'EN-GJL-250', name: 'EN-GJL-250 grey cast iron', family: 'Cast iron', rho: 7200, E: 110, nu: 0.26, fy: 165, fu: 250, alpha: 11.7e-6, appearance: 'cast-iron',
    source: 'EN 1561 Table 1 and Annex (E 103–118 GPa: 110; 0.1 % proof strength 165–228 MPa: its lower bound)',
  },
  {
    id: 'EN-GJS-400-15', name: 'EN-GJS-400-15 ductile iron', family: 'Cast iron', rho: 7100, E: 169, nu: 0.275, fy: 250, fu: 400, alpha: 12.5e-6, appearance: 'cast-iron',
    source: 'EN 1563 Table 3 and Annex D',
  },
  {
    id: 'CuZn39Pb3', name: 'CuZn39Pb3 brass (CW614N)', family: 'Copper alloy', rho: 8470, E: 96, nu: 0.34, fy: 250, fu: 430, alpha: 20.9e-6, appearance: 'brass-polished',
    source: 'EN 12164 R430 (drawn rod); E, ρ, α: Deutsches Kupferinstitut data sheet CuZn39Pb3',
  },
  {
    id: 'Cu-ETP', name: 'Cu-ETP copper (CW004A)', family: 'Copper alloy', rho: 8930, E: 127, nu: 0.34, fy: 180, fu: 240, alpha: 17e-6, appearance: 'copper-polished',
    source: 'EN 1652 R240 (half hard); E, ρ, α: Deutsches Kupferinstitut data sheet Cu-ETP',
  },
  {
    id: 'Ti-6Al-4V', name: 'Ti-6Al-4V titanium (grade 5)', family: 'Titanium', rho: 4430, E: 113.8, nu: 0.342, fy: 828, fu: 895, alpha: 8.6e-6, appearance: 'titanium',
    source: 'ASTM B348 grade 5 (minimum strengths); E, ν, ρ, α: ASM Handbook Vol. 2',
  },
  {
    id: 'POM', name: 'POM-C (acetal)', family: 'Plastic', rho: 1410, E: 2.85, nu: 0.37, fy: 64, alpha: 110e-6, appearance: 'plastic-matte-white',
    source: 'typical (Hostaform C 9021 data sheet: ISO 527, ISO 1183, ISO 11359)',
  },
  {
    id: 'PA6', name: 'PA6 (nylon, dry)', family: 'Plastic', rho: 1130, E: 3.0, nu: 0.39, fy: 80, alpha: 80e-6, appearance: 'plastic-natural',
    source: 'typical dry as moulded (Ultramid B3S data sheet: ISO 527); conditioned E ≈ 1 GPa, f_y ≈ 40 MPa',
  },
  {
    id: 'ABS', name: 'ABS', family: 'Plastic', rho: 1050, E: 2.3, nu: 0.35, fy: 45, alpha: 90e-6, appearance: 'plastic-gloss-grey',
    source: 'typical (Terluran GP-22 data sheet: ISO 527, ISO 1183, ISO 11359)',
  },
  {
    id: 'PLA', name: 'PLA', family: 'Plastic', rho: 1240, E: 3.6, nu: 0.36, fy: 60, alpha: 68e-6, appearance: 'plastic-matte-white',
    source: 'typical (NatureWorks Ingeo 4043D data sheet); a 3-D print is lighter by its infill',
  },
  {
    id: 'PETG', name: 'PETG', family: 'Plastic', rho: 1270, E: 2.0, nu: 0.38, fy: 50, alpha: 68e-6, appearance: 'plastic-gloss-grey',
    source: 'typical (Eastman Eastar 6763 data sheet: ISO 527)',
  },
  {
    id: 'PC', name: 'PC (polycarbonate)', family: 'Plastic', rho: 1200, E: 2.4, nu: 0.37, fy: 65, alpha: 65e-6, appearance: 'polycarbonate-clear',
    source: 'typical (Makrolon 2405 data sheet: ISO 527, ISO 1183, ISO 11359)',
  },
  {
    id: 'PEEK', name: 'PEEK', family: 'Plastic', rho: 1300, E: 4.0, nu: 0.4, fy: 98, alpha: 45e-6, appearance: 'peek-natural',
    source: 'typical (Victrex PEEK 450G data sheet: ISO 527; α below T_g)',
  },
  timber('C24', 'EN 338:2016 Table 1 (ρ_mean, E_0,mean, G_mean, f_t,0,k, f_c,0,k)'),
  timber('GL24h', 'EN 14080:2013 Table 5 (ρ_g,mean, E_0,g,mean, G_g,mean, f_t,0,g,k, f_c,0,g,k)'),
  {
    id: 'C30/37', name: 'C30/37 concrete', family: 'Concrete', rho: 2400, E: c30.E_cm, nu: 0.2, fu: c30.f_ctm, fc: c30.f_ck, alpha: 10e-6, appearance: 'concrete',
    source: 'EN 1992-1-1 Table 3.1 (E_cm, f_ctm by its formulas) and §3.1.3; ρ: plain normal-weight concrete (EN 1991-1-1 Table A.1: 24 kN/m³, reinforced 25)',
  },
  {
    id: 'Glass', name: 'Soda-lime silicate glass', family: 'Glass', rho: 2500, E: 70, nu: 0.2, fu: 45, alpha: 9e-6, appearance: 'glass-clear',
    source: 'EN 572-1 §4 (f_u: the characteristic bending strength f_g,k of annealed glass)',
  },
];

const BY_ID = new Map(CAD_MATERIALS.map((m) => [m.id, m]));

export const cadMaterial = (id: string | undefined): CadMaterial | undefined => (id ? BY_ID.get(id) : undefined);

/** Shear modulus, GPa: the standard's, else that of an isotropic material. */
export const shearModulus = (m: CadMaterial) => m.G ?? (m.nu !== undefined ? m.E / (2 * (1 + m.nu)) : undefined);

/** The families in library order, for grouped lists. */
export const MATERIAL_FAMILIES: MaterialFamily[] = [...new Set(CAD_MATERIALS.map((m) => m.family))];

// ------------------------------------------------------------ assignment

/** A library material by id, or an error naming it (a document from a newer version). */
function known(id: string): CadMaterial {
  const m = BY_ID.get(id);
  if (!m) throw new Error(`unknown material "${id}"`);
  return m;
}

/**
 * The densities a component's bodies weigh with (kg per part unit³): `density` for the
 * component, `rho:${body}` for a body of a material of its own. `expr` evaluates a density
 * expression (it throws when that is no density: the bodies of their own still weigh).
 */
export function componentDensities(design: CadDesign, comp: CadComponent, partDensity: string, unit: string, expr: (src: string) => number): { params: Record<string, number>; error?: string } {
  const params: Record<string, number> = {};
  const lib = (id: string) => math.unit(known(id).rho, 'kg/m^3').toNumeric(`kg/${unit}^3`) as number;
  let error: string | undefined;
  for (const [body, id] of Object.entries(comp.bodyMaterials ?? {})) {
    try {
      params[`rho:${body}`] = lib(id);
    } catch (e) {
      error ??= e instanceof Error ? e.message : String(e);
    }
  }
  try {
    const own = comp.density?.trim(), part = partDensity.trim();
    const d = own ? expr(own) : comp.material ? lib(comp.material) : part ? expr(part) : design.material ? lib(design.material) : undefined;
    if (d !== undefined) params.density = d;
  } catch (e) {
    error ??= e instanceof Error ? e.message : String(e);
  }
  return { params, ...(error ? { error } : {}) };
}

/**
 * The library material a body (or, without one, a component) is made of: the body's own,
 * else the component's, else the part's, unless the component has a density expression
 * of its own instead (a material with a density expression keeps its other properties).
 */
export function materialOfBody(design: CadDesign, comp: CadComponent, body?: string): CadMaterial | undefined {
  const own = body ? cadMaterial(comp.bodyMaterials?.[body]) : undefined;
  if (own) return own;
  if (comp.material) return cadMaterial(comp.material);
  return comp.density?.trim() ? undefined : cadMaterial(design.material);
}

/** A material for the worksheet, with the density the body actually weighs with (kg per part unit³). */
export function materialValue(m: CadMaterial, density?: number, unit = 'mm'): Record<string, unknown> {
  const u = (v: number, s: string) => math.unit(v, s);
  const rho = density !== undefined ? math.unit(density, `kg/${unit}^3`).to('kg/m^3') : u(m.rho, 'kg/m^3');
  const alpha = u(m.alpha, '1/K');
  const out: Record<string, unknown> = { name: m.id, rho, ρ: rho, E: u(m.E, 'GPa'), alpha_T: alpha, α_T: alpha };
  const G = shearModulus(m);
  if (G !== undefined) out.G = u(G, 'GPa');
  if (m.nu !== undefined) out.nu = out.ν = m.nu;
  // f_y as in steel(), fy as the shorter spelling
  if (m.fy !== undefined) out.f_y = out.fy = u(m.fy, 'MPa');
  if (m.fu !== undefined) out.f_u = out.fu = u(m.fu, 'MPa');
  if (m.fc !== undefined) out.f_c = out.fc = u(m.fc, 'MPa');
  return out;
}
