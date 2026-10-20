// The worker side of the kernel requests. Builds go through the timeline cache, so a
// request about the design the worksheet has just built finds its solids ready, and the
// display data of a design is made once per design key.
//
// OpenCascade loads on the first request (or the first worksheet with a CAD part); while
// it loads nothing is shown, and if it cannot load the mesh kernel answers instead.
import type { BuildResult } from '../buildResult';
import { meshBuildResult } from '../buildResult';
import type { CadDesign, DesignNumbers } from '../design';
import { drawMeshes } from '../display';
import { meshDrawView } from '../drawing';
import type { DrawView, DrawViewRequest } from '../drawing2d';
import { approxDistance } from '../inspect';
import { designKey } from '../keys';
import { initKernel, kernel } from '../solid';
import { buildDesignCached } from '../occ/build';
import { mmPerUnit, stepFile, stlFile } from '../occ/exchange';
import { initOcc, occ, occFailure, onOccRenewed, renewOcc, type OC } from '../occ/kernel';
import { ByteLru } from '../../model/lru';
import { distanceOcc, interferenceOcc, outlineOcc, sectionOcc } from '../occ/query';
import { cachedResultOcc } from '../occ/result';
import { drawViewOcc } from '../occ/drawing';
import { interferenceMesh, meshBuilt, outlineMesh, sectionMesh, stlMesh } from './meshFallback';
import { buffersOf, NO_KERNEL, type KernelCall, type KernelReply, type KernelRequest } from './protocol';

let loadBrep: () => Promise<unknown> = () => initOcc();
let loadMesh: () => Promise<unknown> = () => initKernel();

/** How the kernels load here (browsers pass the bundled WASM URLs). */
export function setKernelLoaders(brep: () => Promise<unknown>, mesh: () => Promise<unknown>) {
  loadBrep = brep;
  loadMesh = mesh;
}

let brep: Promise<boolean> | null = null;
let mesh: Promise<boolean> | null = null;

/** Load OpenCascade once; true when it is there. */
export function ensureBrep(): Promise<boolean> {
  brep ??= loadBrep().then(() => true, (e) => {
    console.warn('the B-rep kernel failed to load', e);
    return false;
  });
  return brep;
}

export function ensureMesh(): Promise<boolean> {
  mesh ??= loadMesh().then(() => true, (e) => {
    console.warn('the mesh kernel failed to load', e);
    return false;
  });
  return mesh;
}

/** The B-rep kernel, or null when the mesh kernel has to answer (it could not load, or is switched off). */
const brepNow = (): OC | null => occ();

/** Display data made here, by design key: a few parts, within a byte budget. */
const displays = new ByteLru<string, BuildResult>(48 * 2 ** 20, 6);
let displaysBy: OC | null = null;

/**
 * Display data of a design: from the B-rep kernel when it is loaded, from the mesh kernel
 * when OpenCascade failed (to load, or on this design), null while it is still loading.
 */
export function displayFor(design: CadDesign, numbers: DesignNumbers): BuildResult | null {
  // a renewed kernel builds afresh: the old one may have failed on a part (a trap)
  if (brepNow() !== displaysBy) {
    displays.clear();
    displaysBy = brepNow();
  }
  const key = designKey(design, numbers);
  const hit = displays.get(key);
  if (hit) return hit;
  const oc = brepNow();
  let out: BuildResult | null = null;
  if (oc) {
    try {
      out = cachedResultOcc(oc, buildDesignCached(oc, design, numbers));
    } catch (e) {
      console.warn('the B-rep kernel failed on this part; showing the mesh kernel’s', e);
    }
  }
  const K = kernel();
  if (!out && (oc || occFailure()) && K) out = meshBuildResult(K, design, numbers);
  if (!out) return null;
  displays.set(key, out);
  return out;
}

/**
 * Display data for a request: when OpenCascade fails on this design the mesh kernel
 * stands in, which a kernel worker of its own has not loaded yet.
 */
async function shownFor(design: CadDesign, numbers: DesignNumbers): Promise<BuildResult | null> {
  const b = displayFor(design, numbers);
  if (b || !brepNow()) return b;
  return (await ensureMesh()) ? displayFor(design, numbers) : null;
}

/** Drawing views made here (a drawing has a few views; a part edited makes new ones). */
const drawn = new ByteLru<string, DrawView>(24 * 2 ** 20, 24);
let drawnBy: OC | null = null;

// a renewed kernel builds afresh (the old one may have failed on a part), and nothing here
// may keep the old instance reachable
onOccRenewed(() => {
  displays.clear();
  drawn.clear();
  displaysBy = drawnBy = null;
});

/** Bytes of display data and drawing views kept here. */
export const kernelCacheBytes = () => displays.bytes + drawn.bytes;

/** Forget the display data and drawing views kept here (they are made again on demand). */
export function dropKernelCaches() {
  displays.clear();
  drawn.clear();
}

/**
 * A drawing view of a design, filed by its design key and the view (a drawing that
 * redraws for another reason, or a second drawing of the part, finds it ready). The
 * B-rep kernel's exact hidden-line removal; the display mesh's lines where OpenCascade is
 * not loaded or failed on the part.
 */
export function drawViewFor(design: CadDesign, numbers: DesignNumbers, shown: BuildResult, v: DrawViewRequest, key = designKey(design, numbers)): DrawView {
  const oc = brepNow();
  if (oc !== drawnBy) {
    drawn.clear();
    drawnBy = oc;
  }
  const k = `${key}|${shown.kernel}|${JSON.stringify([v.name, v.dir, v.up, v.hidden, v.cut ?? null])}`;
  const hit = drawn.get(k);
  if (hit) return hit;
  let out: DrawView | null = null;
  if (oc && shown.kernel === 'brep') {
    try {
      out = drawViewOcc(oc, buildDesignCached(oc, design, numbers), design, v);
    } catch (e) {
      console.warn('the exact drawing failed on this part; drawing the mesh', e);
    }
  }
  out ??= meshDrawView(drawMeshes(shown, design), v);
  drawn.set(k, out);
  return out;
}

/** Answer one request; `transfer` lists buffers nothing else holds on to. */
export async function answer(req: KernelRequest): Promise<{ value: unknown; kernel: 'brep' | 'mesh' | 'none'; transfer: ArrayBuffer[] }> {
  const hasBrep = await ensureBrep();
  const hasMesh = !hasBrep || !brepNow() ? await ensureMesh() : !!kernel();
  if (req.op === 'warm') return { value: { brep: hasBrep, mesh: hasMesh }, kernel: brepNow() ? 'brep' : hasMesh ? 'mesh' : 'none', transfer: [] };
  if (!hasBrep && !hasMesh) throw new Error(NO_KERNEL);
  const oc = brepNow(), K = kernel();
  const which = oc ? 'brep' : K ? 'mesh' : 'none';
  const { design, numbers } = req;
  // the display data stays cached here: a copy of it travels, its arrays moved (not copied again)
  if (req.op === 'display') {
    const value = structuredClone(await shownFor(design, numbers));
    return { value, kernel: which, transfer: buffersOf(value) };
  }
  if (req.op === 'drawing') {
    const shown = await shownFor(design, numbers);
    if (!shown) return { value: null, kernel: which, transfer: [] };
    const key = designKey(design, numbers);
    const views: Record<string, DrawView> = {};
    for (const v of req.views) views[v.key] = drawViewFor(design, numbers, shown, v, key);
    return { value: views, kernel: which, transfer: [] };
  }
  if (!oc && !K) throw new Error(NO_KERNEL);
  switch (req.op) {
    case 'section': {
      const value = oc ? sectionOcc(oc, buildDesignCached(oc, design, numbers), design, req.plane) : sectionMesh(meshBuilt(K!, design, numbers), design, req.plane);
      return { value, kernel: which, transfer: buffersOf(value) };
    }
    case 'outline':
      return { value: oc ? outlineOcc(oc, buildDesignCached(oc, design, numbers), req.component, req.frame) : outlineMesh(meshBuilt(K!, design, numbers), req.component, req.frame), kernel: which, transfer: [] };
    case 'interference':
      return { value: oc ? interferenceOcc(oc, buildDesignCached(oc, design, numbers), design) : interferenceMesh(meshBuilt(K!, design, numbers), design), kernel: which, transfer: [] };
    case 'distance': {
      if (oc) return { value: distanceOcc(oc, buildDesignCached(oc, design, numbers), design, req.a, req.b), kernel: which, transfer: [] };
      const shown = displayFor(design, numbers);
      return { value: shown && approxDistance(shown, design, req.a, req.b), kernel: which, transfer: [] };
    }
    case 'export': {
      let data: Uint8Array;
      if (req.format === 'step') {
        if (!oc) throw new Error('STEP export needs the B-rep kernel (OpenCascade did not load)');
        data = new TextEncoder().encode(stepFile(oc, buildDesignCached(oc, design, numbers), design, req.scope, { unit: req.unit, name: req.name }));
      } else {
        // STL has no units: written in millimetres, which slicers assume
        const scale = mmPerUnit(req.unit);
        data = oc ? stlFile(oc, buildDesignCached(oc, design, numbers), design, req.scope, { name: req.name, scale }) : stlMesh(meshBuilt(K!, design, numbers), design, req.scope, req.name, scale);
      }
      return { value: data, kernel: which, transfer: [data.buffer as ArrayBuffer] };
    }
  }
}

let pendingRequests = 0;
let lastRequest = 0;

/** Kernel requests waiting or running here, and when the last one was answered (performance.now()). */
export const kernelActivity = () => ({ pending: pendingRequests, last: lastRequest });

/** Serve kernel requests arriving on a port, one at a time (OCCT is synchronous anyway). */
export function serveKernel(port: { postMessage(m: unknown, transfer: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }) {
  let queue = Promise.resolve();
  port.onmessage = (e: MessageEvent<KernelCall>) => {
    const { rid, req } = e.data;
    pendingRequests++;
    queue = queue.then(async () => {
      let reply: KernelReply, transfer: Transferable[] = [];
      try {
        const a = await answer(req);
        reply = { rid, ok: true, value: a.value, kernel: a.kernel };
        transfer = a.transfer;
      } catch (err) {
        reply = { rid, ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        // between requests: a CAD window's own worker never measures a worksheet, where the
        // calculation worker renews the heap OCCT's own leaks fill, so it is renewed here too
        renewOcc()?.catch((err) => console.warn('renewing the B-rep kernel failed', err));
        pendingRequests--;
        lastRequest = performance.now();
      }
      port.postMessage(reply, transfer);
    });
  };
}
