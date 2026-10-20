// Which appearance a body and a face show, and the defaults the materials bring.
import { describe, expect, it } from 'vitest';
import { APPEARANCES, appearance, bodyAppearanceId, bodyLook, faceAppearanceAt, faceLooks, hexRgb, lookOf } from './appearances';
import { CAD_MATERIALS } from './materials';
import type { CadComponent, CadDesign } from './design';
import type { BodyTopology } from './topology';
import { refTo } from './topology';
import type { FaceInfo } from './buildResult';

const comp = (patch: Partial<CadComponent> = {}): CadComponent => ({ id: 'c1', name: 'C', items: [], ...patch });
const design = (c: CadComponent, patch: Partial<CadDesign> = {}): CadDesign => ({ version: 2, components: [c], occurrences: [{ id: 'o1', component: 'c1' }], joints: [], ...patch });
const PALETTE: [number, number, number] = [0.64, 0.69, 0.77];

describe('appearance library', () => {
  it('every entry is physically plausible', () => {
    for (const x of APPEARANCES) {
      expect(hexRgb(x.color), x.id).not.toBeNull();
      expect(x.metal === 0 || x.metal === 1, x.id).toBe(true);
      expect(x.rough, x.id).toBeGreaterThan(0);
      expect(x.rough, x.id).toBeLessThanOrEqual(1);
      expect(x.opacity, x.id).toBeGreaterThan(0);
      // a metal reflects at least half the light at normal incidence (measured F0 of the metals ≥ 0.5 in linear terms ~ 0.73 sRGB),
      // except dyed (anodised) oxides and dark finishes
      if (x.metal && x.group === 'Metal') expect(Math.max(...hexRgb(x.color)!), x.id).toBeGreaterThan(0.6);
    }
    expect(new Set(APPEARANCES.map((x) => x.id)).size).toBe(APPEARANCES.length);
  });

  it('covers paints, anodised, brushed and polished metals, plastics gloss and matte, rubber, wood and transparent ones', () => {
    const groups = new Set(APPEARANCES.map((x) => x.group));
    for (const g of ['Paint', 'Anodised', 'Metal', 'Plastic', 'Rubber', 'Wood', 'Transparent'] as const) expect(groups.has(g), g).toBe(true);
    expect(appearance('aluminium-brushed')!.rough).toBeGreaterThan(appearance('aluminium-polished')!.rough);
    expect(appearance('plastic-matte-white')!.rough).toBeGreaterThan(appearance('plastic-gloss-white')!.rough);
    expect(appearance('glass-clear')!.opacity).toBeLessThan(0.3);
  });

  it('every material has a default appearance that exists, of its kind', () => {
    for (const m of CAD_MATERIALS) expect(appearance(m.appearance), `${m.id} → ${m.appearance}`).toBeDefined();
    const look = (id: string) => appearance(CAD_MATERIALS.find((m) => m.id === id)!.appearance)!;
    // metals look metallic, plastics, timber and concrete do not, glass is see-through
    for (const id of ['S355', '1.4404', 'EN AW-6061-T6', 'EN-GJS-400-15', 'CuZn39Pb3', 'Cu-ETP', 'Ti-6Al-4V']) expect(look(id).metal, id).toBe(1);
    for (const id of ['POM', 'PA6', 'ABS', 'PLA', 'PEEK', 'C24', 'C30/37']) expect(look(id).metal, id).toBe(0);
    expect(look('Glass').opacity).toBeLessThan(0.5);
    expect(look('C24').group).toBe('Wood');
  });
});

describe('what a body shows', () => {
  it('in order: body appearance, body material, component appearance, colour, component material, part material', () => {
    const full = comp({ material: 'S355', appearance: 'anodised-red', color: '#ff0000', bodyMaterials: { b2: 'PA6' }, bodyAppearances: { b1: 'chrome' } });
    const d = design(full, { material: 'PEEK' });
    expect(bodyAppearanceId(d, full, 'b1')).toBe('chrome');
    expect(bodyAppearanceId(d, full, 'b2')).toBe('plastic-natural');
    expect(bodyAppearanceId(d, full, 'b3')).toBe('anodised-red');
    const coloured = comp({ material: 'S355', color: '#ff0000' });
    expect(bodyAppearanceId(design(coloured), coloured, 'b1')).toBeUndefined();
    expect(bodyLook(design(coloured), coloured, 'b1', [1, 0, 0])).toEqual({ color: [1, 0, 0], metal: 0, rough: 0.45, opacity: 1 });
    const steel = comp({ material: 'S355' });
    expect(bodyAppearanceId(design(steel), steel, 'b1')).toBe('steel-satin');
    const plain = comp();
    expect(bodyAppearanceId(design(plain, { material: 'PEEK' }), plain, 'b1')).toBe('peek-natural');
    // a density of its own: no library material, so the palette colour
    const custom = comp({ density: '7000 kg/m^3' });
    expect(bodyLook(design(custom, { material: 'PEEK' }), custom, 'b1', PALETTE).color).toEqual(PALETTE);
  });

  it('an unknown appearance id falls back to the next in line', () => {
    const c = comp({ appearance: 'no-such-look', material: 'Glass' });
    expect(bodyAppearanceId(design(c), c, 'b1')).toBe('glass-clear');
    expect(lookOf(appearance('glass-clear')!).opacity).toBeCloseTo(0.16, 12);
  });
});

describe('faces in an appearance of their own', () => {
  const face = (index: number, key: string, c: [number, number, number]): FaceInfo => ({ index, key, feature: 'f1', type: 'plane', area: 100, c, frame: { o: c, u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] } });
  const body = (id: string, faces: FaceInfo[]): BodyTopology => ({ id, faces, edges: [], vertices: [], box: null, named: true });
  const b1 = body('b1', [face(0, 'f1/start', [0, 0, 0]), face(1, 'f1/end', [0, 0, 10]), face(2, 'f1/side:l0', [5, 0, 5])]);

  it('are found by their references, a later one of the same face winning', () => {
    const c = comp({
      faceAppearances: [
        { face: refTo('face', 'b1', b1.faces[1]), appearance: 'paint-gloss-red' },
        { face: refTo('face', 'b1', b1.faces[2]), appearance: 'paint-gloss-red' },
        { face: refTo('face', 'b1', b1.faces[2]), appearance: 'rubber-black' },
      ],
    });
    const looks = faceLooks(c, [b1]).get('b1')!;
    expect(looks.map((g) => [g.faces, g.look.color])).toEqual([[[1], hexRgb('#c1121c')], [[2], hexRgb('#202022')]]);
    expect(faceAppearanceAt(c, [b1], 'b1', 2)?.appearance).toBe('rubber-black');
    expect(faceAppearanceAt(c, [b1], 'b1', 0)).toBeUndefined();
  });

  it('follow a face that moved into another body (a join), and a lost one paints nothing', () => {
    const c = comp({ faceAppearances: [{ face: refTo('face', 'b1', b1.faces[1]), appearance: 'chrome' }, { face: { kind: 'face', body: 'b1', key: 'f9/gone', hint: { p: [99, 99, 99], type: 'plane' } }, appearance: 'chrome' }] });
    const joined = body('b2', [face(0, 'f1/end+f2/end', [0, 0, 10])]);
    const looks = faceLooks(c, [joined]);
    expect([...looks.keys()]).toEqual(['b2']);
    expect(looks.get('b2')![0].faces).toEqual([0]);
  });
});
