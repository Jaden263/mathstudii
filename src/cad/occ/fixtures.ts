// Designs for the kernel tests: sketches that the solver leaves where they are, and a
// worksheet evaluation that resolves a design the way the app does.
import { evaluateWorksheet, type CadResult } from '../../engine/evaluator';
import { createRegion, emptyWorksheet, type CadRegion } from '../../model/types';
import type { CadSketch } from '../model';
import type { CadDesign, DesignItem, DesignNumbers } from '../design';
import type { OC } from './kernel';

type P = [number, number];

/** Closed polygon of lines (unconstrained). */
export function poly(p: string, pts: P[]): CadSketch {
  return {
    points: pts.map(([x, y], i) => ({ id: `${p}p${i}`, x, y })),
    entities: pts.map((_, i) => ({ id: `${p}l${i}`, type: 'line' as const, p1: `${p}p${i}`, p2: `${p}p${(i + 1) % pts.length}` })),
    constraints: [],
  };
}

export const rect = (p: string, x0: number, y0: number, x1: number, y1: number) => poly(p, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

/** Add circles (centre, radius) to a sketch. */
export function withCircles(sk: CadSketch, p: string, circles: [number, number, number][]): CadSketch {
  return {
    ...sk,
    points: [...sk.points, ...circles.map(([x, y], i) => ({ id: `${p}c${i}`, x, y }))],
    entities: [...sk.entities, ...circles.map(([, , r], i) => ({ id: `${p}k${i}`, type: 'circle' as const, c: `${p}c${i}`, r }))],
  };
}

export const circles = (p: string, cs: [number, number, number][]): CadSketch => withCircles({ points: [], entities: [], constraints: [] }, p, cs);

export function points(p: string, pts: P[]): CadSketch {
  return {
    points: pts.map(([x, y], i) => ({ id: `${p}q${i}`, x, y })),
    entities: pts.map((_, i) => ({ id: `${p}e${i}`, type: 'point' as const, p: `${p}q${i}` })),
    constraints: [],
  };
}

export const single = (items: DesignItem[], name = 'Part'): CadDesign => ({
  version: 2, components: [{ id: 'c1', name, items }], occurrences: [{ id: 'o1', component: 'c1', grounded: true }], joints: [],
});

/** Evaluate a part in a worksheet (with optional definitions before it). */
export function solve(design: CadDesign, pre: string[] = [], density = '7850 kg/m^3'): { res: CadResult; numbers: DesignNumbers } {
  const ws = emptyWorksheet();
  const before = pre.map((s, i) => createRegion('math', 20, 20 + 20 * i, { source: s }));
  const cad = createRegion('cad', 20, 400, { name: 'part', design, density }) as CadRegion;
  ws.regions = [...before, cad];
  const res = evaluateWorksheet(ws).results.get(cad.id) as CadResult;
  if (!res.design) throw new Error(res.error ?? 'the part did not evaluate');
  return { res, numbers: res.design };
}

/** Volumes of the bodies of a component in the result. */
export const volumes = (res: CadResult, cid = 'c1') => (res.design?.bodies[cid] ?? []).map((b) => b.mass?.V ?? 0);

/**
 * Watch every OCCT object made from now on (constructed, or returned by a method):
 * `undeleted()` lists the ones nobody deleted, by where they came from. `stop()` puts
 * the kernel back as it was.
 */
export function watchHandles(oc: OC): { undeleted(): string[]; stop(): void } {
  const K = oc as unknown as Record<string, unknown>;
  const made: { o: { isDeleted(): boolean }; where: string }[] = [];
  const undo: (() => void)[] = [];
  const track = (v: unknown, where: string) => {
    if (v && typeof v === 'object' && typeof (v as { isDeleted?: unknown }).isDeleted === 'function') made.push({ o: v as { isDeleted(): boolean }, where });
    return v;
  };
  // embind keeps overload tables on the functions: copy them onto the wrappers
  const wrap = (owner: Record<string, unknown>, k: string, where: string, method: boolean) => {
    const f = owner[k] as (...a: unknown[]) => unknown;
    const w = method ? function (this: unknown, ...a: unknown[]) { return track(f.apply(this, a), where); } : (...a: unknown[]) => track(f(...a), where);
    Object.assign(w, f);
    try {
      owner[k] = w;
      undo.push(() => (owner[k] = f));
    } catch {
      /* read-only */
    }
  };
  const seen = new Set<object>();
  for (const [name, C] of Object.entries(K)) {
    const proto = typeof C === 'function' ? (C as { prototype?: Record<string, unknown> }).prototype : undefined;
    if (!proto) continue;
    if (!seen.has(proto)) {
      seen.add(proto);
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (['constructor', 'delete', 'isDeleted', 'clone', 'deleteLater', 'isAliasOf'].includes(k)) continue;
        if (typeof Object.getOwnPropertyDescriptor(proto, k)?.value === 'function') wrap(proto, k, `${name}.${k}`, true);
      }
    }
    for (const k of Object.getOwnPropertyNames(C)) {
      if (!['length', 'name', 'prototype'].includes(k) && typeof (C as unknown as Record<string, unknown>)[k] === 'function') wrap(C as unknown as Record<string, unknown>, k, `${name}::${k}`, false);
    }
    if (typeof proto.delete === 'function') {
      K[name] = new Proxy(C as new (...a: unknown[]) => object, { construct: (T, a) => track(new T(...a), `new ${name}`) as object });
      undo.push(() => (K[name] = C));
    }
  }
  return {
    undeleted: () => made.filter((x) => !x.o.isDeleted()).map((x) => x.where),
    stop: () => undo.reverse().forEach((u) => u()),
  };
}
