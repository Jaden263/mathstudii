// Keys of built designs. A built design depends on the design and the numbers the
// worksheet resolved; the editor's viewports, colours and names do not change a solid,
// so they stay out of the keys (panning a sketch must not rebuild the part).
//
// Two kinds: the key of a whole design (display data, measured values) and the key of
// every step of a component's timeline, which chains the keys of the steps before it so
// a rebuild can resume after the last step that did not change.
import type { CadDesign, DesignItem, DesignNumbers, DesignSketch } from './design';

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

/** Editor state that never changes a solid. */
const PRESENTATION = new Set(['view', 'color']);

/** JSON without the editor's viewports and colours. */
const solidJson = (v: unknown) => JSON.stringify(v, (k, x) => (PRESENTATION.has(k) ? undefined : x));

/** Key of a built design: its display data and measured values are the same for equal keys. */
export function designKey(design: CadDesign, numbers: DesignNumbers): string {
  // only the solved geometry of each sketch counts, not its dimension readouts
  const sketches = Object.fromEntries(Object.entries(numbers.sketches).map(([id, s]) => [id, [s.points, s.radii]]));
  return `d${hashString(solidJson([design, sketches, numbers.frames, numbers.params, numbers.errors]))}`;
}

/** A sketch as the features using it see it: its curves, plane and solved geometry. */
function sketchInput(ds: DesignSketch | undefined, id: string, numbers: DesignNumbers): unknown {
  const s = numbers.sketches[id];
  return [ds && { plane: ds.plane, sketch: ds.sketch }, numbers.frames[id] ?? null, s ? [s.points, s.radii] : null, numbers.errors[id] ?? null];
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
  return out;
}

/**
 * Key of the state after `item`, given the key of the state before it: the item (less its
 * name), its evaluated parameters and error, and every sketch it reads.
 */
export function stepKey(prev: string, item: DesignItem, numbers: DesignNumbers, sketches: (id: string) => DesignSketch | undefined): string {
  // a name or a hidden sketch never changes a solid (undefined drops out of the JSON)
  const own = { ...item, name: undefined, ...(item.kind === 'sketch' ? { hidden: undefined } : {}) };
  const input = item.kind === 'sketch'
    ? [own, sketchInput(item, item.id, numbers)]
    : [own, numbers.params[item.id] ?? null, numbers.errors[item.id] ?? null, sketchesOf(item).map((id) => sketchInput(sketches(id), id, numbers))];
  return hashString(`${prev}|${solidJson(input)}`);
}

/**
 * The numbers a design result was built from: a build needs them without the errors the
 * build itself added (`resolveErrors`; results without it have only resolve errors).
 */
export function designNumbers(dr: DesignNumbers & { resolveErrors?: Record<string, string> }): DesignNumbers {
  return { sketches: dr.sketches, frames: dr.frames, params: dr.params, errors: dr.resolveErrors ?? dr.errors };
}
