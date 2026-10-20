// When the calculation worker lets go of what it holds. WASM memory never shrinks: the
// only way to give back what OpenCascade, the mesh kernel or Python took is to stop the
// worker, which the page then does once it has been idle for a while and the worksheet
// does not need it (or its B-rep heap has grown far past a fresh one). The next
// calculation starts a new worker, and the views keep their display data meanwhile, so
// nothing on the page changes.
import type { WorkerMemory } from '../engine/memoryProtocol';
import type { Worksheet } from '../model/types';

/** Idle this long before anything is let go. */
export const IDLE_RELEASE_MS = 60_000;
/** After this long without any calculation even kernels the worksheet uses are let go (they load again on the next change). */
export const LONG_IDLE_MS = 10 * 60_000;
/** A B-rep heap (with replaced ones not collected yet) past this is given back once idle: a fresh one is 100 MB. */
export const BLOATED_OCCT = 256 * 2 ** 20;
/** The same for the worker's JavaScript heap, where the browser tells it … */
export const BLOATED_JS = 384 * 2 ** 20;
/** … and for Python's (30 MB fresh; big arrays grow it, and it keeps its peak). */
export const BLOATED_PYTHON = 512 * 2 ** 20;

/** What the worksheet needs of the calculation worker. */
export interface WorksheetNeeds {
  /** It has CAD regions (they use the 3-D kernels). */
  cad: boolean;
  /** It has Python regions that run. */
  python: boolean;
}

export function needsOf(ws: Worksheet): WorksheetNeeds {
  let cad = false, python = false;
  for (const r of ws.regions) {
    if (r.kind === 'cad') cad = true;
    else if (r.kind === 'python' && !r.disabled && r.code.trim()) python = true;
  }
  return { cad, python };
}

const MB = (b: number) => `${Math.round(b / 2 ** 20)} MB`;

/** Why the worker should be stopped now, or null. */
export function releaseReason(m: WorkerMemory, needs: WorksheetNeeds): string | null {
  if (m.busy || m.idleMs < IDLE_RELEASE_MS) return null;
  const kernels = m.occt > 0 || m.manifold;
  if (m.python && !needs.python) return 'Python is not used by this worksheet';
  if (kernels && !needs.cad) return 'the 3-D kernels are not used by this worksheet';
  if (m.occt + m.occtStale > BLOATED_OCCT) return `the B-rep kernel grew to ${MB(m.occt + m.occtStale)}`;
  if (m.jsHeap && m.jsHeap > BLOATED_JS) return `the calculation heap grew to ${MB(m.jsHeap)}`;
  if (m.python > BLOATED_PYTHON) return `Python's heap grew to ${MB(m.python)}`;
  // left alone for long: kernels load again quickly, Python (seconds, and its packages) stays
  if (m.idleMs >= LONG_IDLE_MS && kernels && !m.python) return 'idle for 10 minutes';
  return null;
}

/** When to look again (ms from now), or null when nothing can be let go before the worker is used again. */
export function nextCheck(m: WorkerMemory, needs: WorksheetNeeds): number | null {
  if (m.busy) return IDLE_RELEASE_MS;
  if (m.idleMs < IDLE_RELEASE_MS) return IDLE_RELEASE_MS - m.idleMs;
  if (m.idleMs < LONG_IDLE_MS && (m.occt > 0 || m.manifold) && !m.python && needs.cad) return LONG_IDLE_MS - m.idleMs;
  return null;
}
