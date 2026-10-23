// Appearances of CAD bodies: how a surface looks, apart from what it is made of. Each is
// a physically based description (base colour, metalness, roughness, opacity) that the
// 3-D view shades with GGX (ui/cad/pbr.ts). Base colours are sRGB: a dielectric's diffuse
// colour, a metal's reflectance at normal incidence (measured F0 of the pure metals, as in
// Real-Time Rendering 4th ed. Table 9.2, for the bare ones).
//
// What a face shows, most specific first: its own appearance → its body's → the body's
// material's → the component's appearance → the component's colour → the component's (or
// the part's) material's → the palette colour of the component.
import type { CadComponent, CadDesign } from './design';
import { cadMaterial } from './materials';
import { resolveRef, type BodyTopology, type TopoRef } from './topology';

export type AppearanceGroup = 'Paint' | 'Anodised' | 'Metal' | 'Plastic' | 'Rubber' | 'Wood' | 'Transparent' | 'Mineral';

export interface Appearance {
  id: string;
  name: string;
  group: AppearanceGroup;
  /** sRGB hex: a dielectric's diffuse colour, a metal's reflectance. */
  color: string;
  /** 0 a dielectric (paint, plastic, wood, glass) … 1 a metal. */
  metal: number;
  /** Perceptual roughness: 0 a mirror … 1 fully matte. */
  rough: number;
  /** 1 opaque … 0 invisible. */
  opacity: number;
}

/** What the renderer takes: an appearance with its colour as sRGB 0…1. */
export interface Look {
  color: [number, number, number];
  metal: number;
  rough: number;
  opacity: number;
}

/** A face in an appearance of its own, found again after edits by its reference. */
export interface FaceAppearance {
  face: TopoRef;
  appearance: string;
}

const a = (id: string, name: string, group: AppearanceGroup, color: string, metal: number, rough: number, opacity = 1): Appearance => ({ id, name, group, color, metal, rough, opacity });

export const APPEARANCES: Appearance[] = [
  // paints and powder coats (RAL colours)
  a('paint-gloss-white', 'Paint gloss, white (RAL 9010)', 'Paint', '#f1ede1', 0, 0.22),
  a('paint-gloss-red', 'Paint gloss, red (RAL 3020)', 'Paint', '#c1121c', 0, 0.22),
  a('paint-gloss-blue', 'Paint gloss, blue (RAL 5015)', 'Paint', '#2271b3', 0, 0.22),
  a('paint-gloss-yellow', 'Paint gloss, yellow (RAL 1023)', 'Paint', '#f0ca00', 0, 0.22),
  a('paint-gloss-green', 'Paint gloss, green (RAL 6018)', 'Paint', '#57a639', 0, 0.22),
  a('paint-matte-black', 'Paint matte, black (RAL 9005)', 'Paint', '#0e0e10', 0, 0.75),
  a('paint-matte-grey', 'Paint matte, light grey (RAL 7035)', 'Paint', '#c5c7c4', 0, 0.75),
  a('powder-anthracite', 'Powder coat, anthracite (RAL 7016)', 'Paint', '#383e42', 0, 0.55),
  // anodised aluminium: the metal tinted by the dyed oxide
  a('anodised-clear', 'Anodised, clear', 'Anodised', '#c9ccd0', 1, 0.42),
  a('anodised-black', 'Anodised, black', 'Anodised', '#2a2b2e', 1, 0.4),
  a('anodised-red', 'Anodised, red', 'Anodised', '#b3303a', 1, 0.36),
  a('anodised-blue', 'Anodised, blue', 'Anodised', '#3a6db5', 1, 0.36),
  a('anodised-gold', 'Anodised, gold', 'Anodised', '#d6b25e', 1, 0.36),
  // bare metals
  a('steel-satin', 'Steel, satin', 'Metal', '#c4c6c8', 1, 0.38),
  a('steel-polished', 'Steel, polished', 'Metal', '#c4c6c8', 1, 0.12),
  a('stainless-brushed', 'Stainless steel, brushed', 'Metal', '#d0cfcb', 1, 0.3),
  a('stainless-polished', 'Stainless steel, polished', 'Metal', '#d0cfcb', 1, 0.08),
  a('aluminium-brushed', 'Aluminium, brushed', 'Metal', '#f5f6f6', 1, 0.32),
  a('aluminium-polished', 'Aluminium, polished', 'Metal', '#f5f6f6', 1, 0.1),
  a('cast-iron', 'Cast iron, as cast', 'Metal', '#9b9a98', 1, 0.62),
  a('brass-polished', 'Brass, polished', 'Metal', '#f6e3a8', 1, 0.14),
  a('brass-satin', 'Brass, satin', 'Metal', '#f6e3a8', 1, 0.4),
  a('copper-polished', 'Copper, polished', 'Metal', '#fad0c0', 1, 0.15),
  a('titanium', 'Titanium, satin', 'Metal', '#c2bbb3', 1, 0.36),
  a('chrome', 'Chrome', 'Metal', '#c7c8c8', 1, 0.04),
  a('zinc-galvanised', 'Galvanised (zinc)', 'Metal', '#d4dde0', 1, 0.5),
  // plastics: gloss a moulded surface, matte a textured or printed one
  a('plastic-gloss-white', 'Plastic gloss, white', 'Plastic', '#f2f1ed', 0, 0.18),
  a('plastic-gloss-black', 'Plastic gloss, black', 'Plastic', '#121214', 0, 0.18),
  a('plastic-gloss-red', 'Plastic gloss, red', 'Plastic', '#c62828', 0, 0.18),
  a('plastic-gloss-grey', 'Plastic gloss, grey', 'Plastic', '#8d9196', 0, 0.2),
  a('plastic-matte-white', 'Plastic matte, white', 'Plastic', '#efeee9', 0, 0.62),
  a('plastic-matte-black', 'Plastic matte, black', 'Plastic', '#1a1a1c', 0, 0.62),
  a('plastic-matte-grey', 'Plastic matte, grey', 'Plastic', '#7c8086', 0, 0.62),
  a('plastic-matte-blue', 'Plastic matte, blue', 'Plastic', '#2f62b0', 0, 0.62),
  a('plastic-natural', 'Plastic, natural (nylon)', 'Plastic', '#ebe4d1', 0, 0.5),
  a('peek-natural', 'PEEK, natural', 'Plastic', '#c7b08a', 0, 0.42),
  a('rubber-black', 'Rubber, black', 'Rubber', '#202022', 0, 0.9),
  a('rubber-grey', 'Rubber, grey', 'Rubber', '#5d6064', 0, 0.9),
  a('wood-spruce', 'Wood, spruce', 'Wood', '#dcc08f', 0, 0.68),
  a('wood-oak', 'Wood, oak', 'Wood', '#b48a57', 0, 0.6),
  a('wood-walnut', 'Wood, walnut', 'Wood', '#6b4a31', 0, 0.55),
  a('glass-clear', 'Glass, clear', 'Transparent', '#e8f2f0', 0, 0.04, 0.16),
  a('glass-tinted', 'Glass, tinted', 'Transparent', '#7fa79c', 0, 0.04, 0.35),
  a('acrylic-clear', 'Acrylic (PMMA), clear', 'Transparent', '#f2f4f5', 0, 0.06, 0.2),
  a('polycarbonate-clear', 'Polycarbonate, clear', 'Transparent', '#eef1f2', 0, 0.08, 0.24),
  a('polycarbonate-smoke', 'Polycarbonate, smoke', 'Transparent', '#55595e', 0, 0.08, 0.45),
  a('concrete', 'Concrete', 'Mineral', '#a9a69d', 0, 0.92),
];

const BY_ID = new Map(APPEARANCES.map((x) => [x.id, x]));

export const appearance = (id: string | undefined): Appearance | undefined => (id ? BY_ID.get(id) : undefined);

export const APPEARANCE_GROUPS: AppearanceGroup[] = [...new Set(APPEARANCES.map((x) => x.group))];

/** sRGB hex → 0…1. */
export function hexRgb(h: string): [number, number, number] | null {
  const m = /^#?([\da-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const lookOf = (x: Appearance): Look => ({ color: hexRgb(x.color) ?? [0.7, 0.7, 0.7], metal: x.metal, rough: x.rough, opacity: x.opacity });

/** A colour picked without an appearance: a satin paint. */
export const colourLook = (color: [number, number, number]): Look => ({ color, metal: 0, rough: 0.45, opacity: 1 });

/**
 * The appearance a body shows (its faces' own aside), or undefined for the component's
 * colour: see the order at the top.
 */
export function bodyAppearanceId(design: CadDesign, comp: CadComponent, body: string): string | undefined {
  const own = appearance(comp.bodyAppearances?.[body]) ?? appearance(cadMaterial(comp.bodyMaterials?.[body])?.appearance);
  if (own) return own.id;
  if (appearance(comp.appearance)) return comp.appearance;
  if (comp.color) return undefined;
  // a component with a density of its own is of no library material, not even the part's
  const mat = comp.material ? cadMaterial(comp.material) : comp.density?.trim() ? undefined : cadMaterial(design.material);
  return appearance(mat?.appearance)?.id;
}

/** How a body looks; `colour` is the component's (its own or from the palette). */
export function bodyLook(design: CadDesign, comp: CadComponent, body: string, colour: [number, number, number]): Look {
  const x = appearance(bodyAppearanceId(design, comp, body));
  return x ? lookOf(x) : colourLook(colour);
}

export interface FaceLooks {
  faces: number[];
  look: Look;
}

/**
 * The faces of a component's bodies in appearances of their own, per body (face index in
 * that body), grouped by appearance. References are found among the bodies as built (a
 * face joined into another body goes along); a lost one paints nothing, and a later
 * override of the same face wins.
 */
export function faceLooks(comp: CadComponent, bodies: BodyTopology[]): Map<string, FaceLooks[]> {
  const at = new Map<string, Map<number, string>>();
  for (const fa of comp.faceAppearances ?? []) {
    if (!appearance(fa.appearance)) continue;
    const r = resolveRef(fa.face, bodies);
    if (!r.ok) continue;
    if (!at.has(r.body)) at.set(r.body, new Map());
    at.get(r.body)!.set(r.index, fa.appearance);
  }
  const out = new Map<string, FaceLooks[]>();
  for (const [body, faces] of at) {
    const groups = new Map<string, number[]>();
    for (const [f, id] of faces) groups.set(id, [...(groups.get(id) ?? []), f]);
    out.set(body, [...groups].map(([id, fs]) => ({ faces: fs.sort((p, q) => p - q), look: lookOf(appearance(id)!) })));
  }
  return out;
}

/** The appearance a face was given (by its reference, as `faceLooks` finds it), if any. */
export function faceAppearanceAt(comp: CadComponent, bodies: BodyTopology[], body: string, face: number): FaceAppearance | undefined {
  let hit: FaceAppearance | undefined;
  for (const fa of comp.faceAppearances ?? []) {
    const r = resolveRef(fa.face, bodies);
    if (r.ok && r.body === body && r.index === face) hit = fa;
  }
  return hit;
}
