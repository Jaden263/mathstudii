// The UI's side of the 3-D kernel. Nothing here touches a kernel: requests go to a kernel
// worker (in the worksheet window the calculation worker, which already has the solids
// it built for the worksheet; a separate CAD window starts a worker of its own) and come
// back as promises. Display data of built designs arrives from the calculation worker
// after the results it belongs to, once per design key, and is kept here for the views.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { BuildResult } from '../../cad/buildResult';
import type { CadDesign } from '../../cad/design';
import type { CadResult } from '../../cad/evaluate';
import { designNumbers } from '../../cad/keys';
import type { DisplayMessage, KernelCall, KernelOp, KernelReply, KernelRequest, KernelValues } from '../../cad/kernel/protocol';

/** A request replaced by a newer one in its lane before it was sent: nobody waits for it. */
export class Superseded extends Error {
  constructor() {
    super('superseded');
  }
}

export const isSuperseded = (e: unknown) => e instanceof Superseded;

let host: (() => Worker) | null = null;
let own: Worker | null = null;
let link: { worker: Worker; port: MessagePort } | null = null;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 0;

/** The worksheet window's calculation worker answers kernel requests (null: start a worker of our own). */
export function setKernelHost(h: (() => Worker) | null) {
  host = h;
}

function port(): MessagePort {
  const w = host ? host() : (own ??= new Worker(new URL('../../cad/kernel/worker.ts', import.meta.url), { type: 'module' }));
  if (link?.worker === w) return link.port;
  // a new worker (the calculation was interrupted): what the old one was asked is lost
  for (const p of waiting.values()) p.reject(new Error('the calculation was interrupted — try again'));
  waiting.clear();
  link?.port.close();
  const ch = new MessageChannel();
  ch.port1.onmessage = (e: MessageEvent<KernelReply>) => {
    const r = e.data, p = waiting.get(r.rid);
    if (!p) return;
    waiting.delete(r.rid);
    if (r.ok) p.resolve(r.value);
    else p.reject(new Error(r.error));
  };
  w.postMessage({ kernelPort: ch.port2 }, [ch.port2]);
  link = { worker: w, port: ch.port1 };
  return ch.port1;
}

function send(req: KernelRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const p = port();
    const rid = ++nextId;
    waiting.set(rid, { resolve, reject });
    p.postMessage({ rid, req } satisfies KernelCall);
  });
}

interface Lane {
  busy: boolean;
  next?: { req: KernelRequest; resolve: (v: unknown) => void; reject: (e: Error) => void };
}
const lanes = new Map<string, Lane>();

/**
 * Ask the kernel. Requests in the same `lane` (a section plane being dragged, the display
 * of one part) run one at a time and only the newest waiting one is sent: the ones it
 * replaces reject with Superseded.
 */
export function kernelRequest<K extends KernelOp>(req: Extract<KernelRequest, { op: K }>, lane?: string): Promise<KernelValues[K]> {
  if (!lane) return send(req) as Promise<KernelValues[K]>;
  let l = lanes.get(lane);
  if (!l) lanes.set(lane, (l = { busy: false }));
  const ln = l;
  return new Promise((resolve, reject) => {
    if (ln.busy) {
      ln.next?.reject(new Superseded());
      ln.next = { req, resolve: resolve as (v: unknown) => void, reject };
      return;
    }
    const run = (r: KernelRequest, ok: (v: unknown) => void, fail: (e: Error) => void) => {
      ln.busy = true;
      send(r).then(ok, fail).finally(() => {
        ln.busy = false;
        const n = ln.next;
        ln.next = undefined;
        if (n) run(n.req, n.resolve, n.reject);
      });
    };
    run(req, resolve as (v: unknown) => void, reject);
  });
}

/** Load the kernel now (the CAD workspace opened), so the first build does not wait for it. */
export function warmKernel() {
  kernelRequest({ op: 'warm' }, 'warm').catch(() => {});
}

// ------------------------------------------------------------ display data

const shown = new Map<string, BuildResult>();
const SHOWN = 24;
const listeners = new Set<() => void>();
let version = 0;

function put(key: string, b: BuildResult) {
  shown.delete(key);
  shown.set(key, b);
  while (shown.size > SHOWN) shown.delete(shown.keys().next().value!);
}

/** Display data from the calculation worker. */
export function receiveDisplay(m: DisplayMessage) {
  for (const [k, b] of m.display) put(k, b);
  version++;
  for (const f of listeners) f();
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** What a view of a part shows: its display data, or why there is none (yet). */
export interface Shown {
  build: BuildResult | null;
  /** loading: the kernel is loading (or the worksheet evaluating); rebuilding: `build` is the previous design. */
  state: 'loading' | 'rebuilding' | 'ready' | 'none';
  /** The mesh kernel stood in for OpenCascade. */
  notice?: string;
}

/** The last display data each part showed, kept on screen while a new build is on its way. */
const lastShown = new Map<string, BuildResult>();

/** The display data of a part for its latest result; asks the kernel when nobody sent it. */
export function useBuildResult(regionId: string, design: CadDesign, result: CadResult | undefined): Shown {
  useSyncExternalStore(subscribe, () => version);
  const dr = result?.design;
  const key = dr?.display;
  const build = key ? shown.get(key) ?? null : null;
  const [, bump] = useState(0);
  useEffect(() => {
    if (!key || !dr || build || result?.needsBrep) return;
    let live = true;
    // the calculation worker sends display data right after the results: ask only when it
    // did not come (or in a CAD window of its own)
    const t = window.setTimeout(() => {
      kernelRequest({ op: 'display', design, numbers: designNumbers(dr) }, `display:${regionId}`).then((b) => {
        if (b) put(key, b);
        if (live) bump((n) => n + 1);
      }, () => {});
    }, host ? 1500 : 0);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [key, build, regionId, !!result?.needsBrep]); // eslint-disable-line react-hooks/exhaustive-deps
  if (build) lastShown.set(regionId, build);
  const notice = build?.kernel === 'mesh' || dr?.brepError ? 'Mesh kernel: OpenCascade did not load, so faces, edges and values are approximate' : undefined;
  if (build) return { build, state: 'ready', notice };
  const stale = lastShown.get(regionId) ?? null;
  if (!result || result.needsBrep || result.needsKernel) return { build: stale, state: 'loading', notice };
  return { build: stale, state: key ? 'rebuilding' : 'none', notice };
}
