// Keys of built designs. A built design depends on the design and the numbers the
// worksheet resolved; the editor's viewports, colours and names do not change a solid,
// so they stay out of the keys (panning a sketch must not rebuild the part). Nor do the
// positions a sketch stores: they are only where the solver starts, and the solved
// geometry is in the numbers (the page writes it back into the sketch, which must not
// rebuild the part a second time).
//
// Two kinds: the key of a whole design (display data, measured values) and the key of
// every step of a component's timeline, which chains the keys of the steps before it so
// a rebuild can resume after the last step that did not change.
import type { CadDesign, DesignItem, DesignNumbers, DesignSketch, SolvedSketch } from './design';
import type { CadSketch } from './model';

/** A 53-bit hash of a string (cyrb53), as 14 hex digits. */
export function hashString(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Editor state that never changes a solid (appearances included: materials change the densities, which are in the numbers). */
const PRESENTATION = new Set(['view', 'color', 'appearance', 'bodyAppearances', 'faceAppearances']);

/** A sketch constraint (features have a kind; joints and planes have no refs). */
const isConstraint = (o: unknown) => !!o && typeof o === 'object' && Array.isArray((o as { refs?: unknown }).refs) && !('kind' in o);

/**
 * JSON without the editor's viewports, colours and where dimension texts sit (dragging a
 * dimension's label must not rebuild the features after its sketch).
 */
const solidJson = (v: unknown) => JSON.stringify(v, function (this: unknown, k, x) {
  return PRESENTATION.has(k) || (k === 'offset' && isConstraint(this)) ? undefined : x;
});

/** A sketch's curves without the positions it stores (points by id, circles and ellipses without radius). */
const curves = (sk: CadSketch) => ({ ...sk, points: sk.points.map((p) => p.id), entities: sk.entities.map((e) => (e.type === 'circle' || e.type === 'ellipse' ? { ...e, r: undefined } : e)) });

/**
 * Solved geometry on a 10⁻⁹ grid (sketch units): the solver started from other positions
 * lands a few ulps away (1e-15 for a zero), which must not miss the caches.
 */
const snap = (v: number) => Math.round(v * 1e9) / 1e9;
const solved = (s: SolvedSketch) => [
  Object.fromEntries(Object.entries(s.points).map(([id, [x, y]]) => [id, [snap(x), snap(y)]])),
  Object.fromEntries(Object.entries(s.radii).map(([id, r]) => [id, snap(r)])),
];

/** Key of a built design: its display data and measured values are the same for equal keys. */
export function designKey(design: CadDesign, numbers: DesignNumbers): string {
  const bare = {
    ...design, components: design.components.map((c) => ({ ...c, items: c.items.map((i) => (i.kind === 'sketch' ? { ...i, sketch: curves(i.sketch) } : i)) })),
    // an imported file is its hash (which the import features name): its megabytes stay out of the key
    files: design.files && Object.keys(design.files).sort(),
  };
  // only the solved geometry of each sketch counts, not its dimension readouts
  const sketches = Object.fromEntries(Object.entries(numbers.sketches).map(([id, s]) => [id, solved(s)]));
  return `d${hashString(solidJson([bare, sketches, numbers.frames, numbers.params, numbers.errors, numbers.unit]))}`;
}

/** A sketch as the features using it see it: its curves, plane and solved geometry. */
function sketchInput(ds: DesignSketch | undefined, id: string, numbers: DesignNumbers): unknown {
  const s = numbers.sketches[id];
  return [ds && { plane: ds.plane, sketch: curves(ds.sketch) }, numbers.frames[id] ?? null, s ? solved(s) : null, numbers.errors[id] ?? null];
}

/** Sketches an item reads besides its own fields (profiles, axes, mirror planes). */
export function sketchesOf(item: DesignItem): string[] {
  const out: string[] = [];
  const add = (id?: string) => id && !out.includes(id) && out.push(id);
  if (item.kind === 'sketch') return out;
  if ('sketch' in item) add(item.sketch);
  if (item.kind === 'loft') add(item.sketch2);
  if (item.kind === 'mirror' && !['XY', 'XZ', 'YZ'].includes(item.plane)) add(item.plane);
  if (item.kind === 'pattern') for (const a of [item.axis, item.axis2]) if (a?.includes('/')) add(a.split('/')[0]);
  // planes and axes of modify features: a sketch's plane, or a sketch line `${sketch}/${line}`
  const plane = (pk: unknown) => typeof pk === 'string' && !['XY', 'XZ', 'YZ'].includes(pk) && add(pk);
  const axis = (pk: unknown) => typeof pk === 'string' && pk.includes('/') && add(pk.split('/')[0]);
  if (item.kind === 'split') plane(item.plane);
  if (item.kind === 'draft') {
    plane(item.plane);
    axis(item.pull);
  }
  if (item.kind === 'move') axis(item.axis);
  if (item.kind === 'sweep' && item.path.kind === 'sketch') add(item.path.sketch);
  // what a coil stands on and construction geometry is made from: sketch planes, points
  // `${sketch}/${point}` and curves `${sketch}/${curve}` (construction items' own ids add nothing)
  const picks = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.includes('/')) axis(v);
      else plane(v);
    } else if (Array.isArray(v)) v.forEach(picks);
  };
  if (item.kind === 'coil') [item.plane, item.centre].forEach(picks);
  if (item.kind === 'plane' || item.kind === 'axis' || item.kind === 'point') for (const [k, v] of Object.entries(item.def)) if (!['type', 'd', 'angle', 'at'].includes(k)) picks(v);
  return out;
}

/**
 * Key of the state after `item`, given the key of the state before it: the item (less its
 * name), its evaluated parameters and error, and every sketch it reads.
 */
export function stepKey(prev: string, item: DesignItem, numbers: DesignNumbers, sketches: (id: string) => DesignSketch | undefined): string {
  // a name, a hidden sketch or construction item never changes a solid (undefined drops out of the JSON)
  const own = { ...item, name: undefined, hidden: undefined, ...(item.kind === 'sketch' ? { sketch: curves(item.sketch) } : {}) };
  const input = item.kind === 'sketch'
    ? [own, sketchInput(item, item.id, numbers)]
    : [own, numbers.params[item.id] ?? null, numbers.errors[item.id] ?? null, sketchesOf(item).map((id) => sketchInput(sketches(id), id, numbers)), numbers.unit];
  return hashString(`${prev}|${solidJson(input)}`);
}

/**
 * The numbers a design result was built from: a build needs them without the errors the
 * build itself added (`resolveErrors`; results without it have only resolve errors), with
 * the sketch planes as resolved, not as the build moved them onto their faces, and the
 * sketches as resolved, not as the build solved them again.
 */
export function designNumbers(dr: DesignNumbers & { resolveErrors?: Record<string, string>; resolveFrames?: DesignNumbers['frames']; resolveSketches?: DesignNumbers['sketches'] }): DesignNumbers {
  return { sketches: dr.resolveSketches ?? dr.sketches, frames: dr.resolveFrames ?? dr.frames, params: dr.params, errors: dr.resolveErrors ?? dr.errors, ...(dr.unit ? { unit: dr.unit } : {}) };
}
