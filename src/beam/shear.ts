// Shear deformation data of a beam section: the shear modulus from the material, and
// the shear area A_v from the shape (EN 1993-1-1 6.2.6(3) for steel sections). SI units.
import { sectionProps } from '../engine/sections';
import { timberGrade } from '../engine/materials';
import type { BeamMaterial, BeamSection } from './model';

/** Poisson's ratio: steel EN 1993-1-1 3.2.6, concrete EN 1992-1-1 3.1.3(4) (uncracked). */
export const POISSON: Record<Exclude<BeamMaterial, 'timber'>, number> = { steel: 0.3, concrete: 0.2 };

/**
 * Shear modulus, Pa: G = E / (2 (1 + ν)). Timber is not isotropic: G_mean of its class
 * (EN 338, EN 14080), or E/16 (the EN 338 ratio) without one.
 */
export function shearModulus(E: number, material: BeamMaterial = 'steel', grade?: string): number {
  if (material === 'timber') {
    if (grade) {
      try {
        return timberGrade(grade).G_mean * 1e9;
      } catch {
        // not a timber class: the ratio below
      }
    }
    return E / 16;
  }
  return E / (2 * (1 + POISSON[material]));
}

/**
 * Rolled I or H section, load parallel to the web (EN 1993-1-1 6.2.6(3)a):
 * A − 2 b t_f + (t_w + 2 r) t_f, but at least η h_w t_w (η = 1, on the safe side).
 */
export function rolledIShearArea(A: number, b: number, tf: number, tw: number, r: number, hw: number, eta = 1): number {
  return Math.max(A - 2 * b * tf + (tw + 2 * r) * tf, eta * hw * tw);
}

/** Welded I, H or box section, load parallel to the webs (6.2.6(3)d): η Σ h_w t_w. */
export const weldedShearArea = (hw: number, tw: number, eta = 1) => eta * hw * tw;

/** Rectangular hollow section of uniform thickness, load parallel to the depth h (6.2.6(3)f): A h / (b + h). */
export const rhsShearArea = (A: number, h: number, b: number) => (A * h) / (b + h);

/**
 * A_v / A for solid and thin round sections: rectangle 5/6 (Timoshenko's shear
 * coefficient), solid circle 0.9, circular hollow section 2/π (6.2.6(3)g).
 */
export const SHEAR_FACTOR = { rect: 5 / 6, circle: 0.9, chs: 2 / Math.PI } as const;

/** Shear area (m²) of a section from the steel library ("IPE 300", "CHS 168.3x5", "RHS 200x100x6.3"), or null. */
export function profileShearArea(label?: string): number | null {
  if (!label) return null;
  let p;
  try {
    p = sectionProps(label);
  } catch {
    return null;
  }
  // the library's A_vz is 6.2.6(3)a for I sections, 2A/π and A h/(b + h) for hollow ones
  const A = p.A * 1e-6;
  if (p.family === 'I') return rolledIShearArea(A, p.b * 1e-3, p.t_f * 1e-3, p.t_w * 1e-3, p.r * 1e-3, (p.h - 2 * p.t_f) * 1e-3);
  return p.family === 'CHS' ? SHEAR_FACTOR.chs * A : rhsShearArea(A, p.h * 1e-3, p.b * 1e-3);
}

/** Where a section's shear area comes from, in words. */
export function shearAreaRule(s: BeamSection): string {
  const r = s.shear;
  if (!r) return profileShearArea(s.label) !== null ? `${s.label}, EN 1993-1-1 6.2.6(3)` : 'rectangle, 5/6 A';
  switch (r.kind) {
    case 'rect': return 'rectangle, 5/6 A';
    case 'circle': return 'solid circle, 0.9 A';
    case 'chs': return 'circular hollow, 2A/π';
    case 'rhs': return 'rectangular hollow, A h/(b + h)';
    case 'welded': return 'welded I, h_w t_w';
    case 'value': return 'given';
  }
}
