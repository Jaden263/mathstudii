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
import { projectView, STANDARD_VIEWS, type ViewLines, type ViewSpec } from '../drawing';
import { approxDistance } from '../inspect';
import { designKey } from '../keys';
import { cross3, dot3, initKernel, kernel, norm3, type Vec3 } from '../solid';
import { buildDesignCached } from '../occ/build';
import { mmPerUnit, stepFile, stlFile } from '../occ/exchange';
import { initOcc, occ, occFailure, renewOcc, type OC } from '../occ/kernel';
import { distanceOcc, interferenceOcc, outlineOcc, sectionOcc, visibleBoxOcc } from '../occ/query';
import { cachedResultOcc } from '../occ/result';
import { interferenceMesh, meshBuilt, outlineMesh, sectionMesh, stlMesh } from './meshFallback';
import { buffersOf, type KernelCall, type KernelReply, type KernelRequest } from './protocol';

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

const displays = new Map<string, BuildResult>();
const DISPLAYS = 6;
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
  if (hit) {
    displays.delete(key);
    displays.set(key, hit);
    return hit;
  }
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
  if (displays.size > DISPLAYS) displays.delete(displays.keys().next().value!);
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

/** A 3-D box seen along a view: its extent across (right) and up the paper. */
export function viewBox(b: { min: Vec3; max: Vec3 }, v: ViewSpec): ViewLines['box'] {
  const d = norm3(v.dir), right = norm3(cross3(d, v.up)), up = cross3(right, d);
  const out = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let k = 0; k < 8; k++) {
    const p: Vec3 = [k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]];
    const x = dot3(p, right), y = dot3(p, up);
    out.x0 = Math.min(out.x0, x); out.x1 = Math.max(out.x1, x);
    out.y0 = Math.min(out.y0, y); out.y1 = Math.max(out.y1, y);
  }
  return out;
}

/** Answer one request; `transfer` lists buffers nothing else holds on to. */
export async function answer(req: KernelRequest): Promise<{ value: unknown; kernel: 'brep' | 'mesh' | 'none'; transfer: ArrayBuffer[] }> {
  const hasBrep = await ensureBrep();
  if (!hasBrep || !brepNow()) await ensureMesh();
  if (req.op === 'warm') return { value: { brep: hasBrep }, kernel: brepNow() ? 'brep' : 'mesh', transfer: [] };
  const oc = brepNow(), K = kernel();
  const which = oc ? 'brep' : K ? 'mesh' : 'none';
  const { design, numbers } = req;
  // the display data stays cached here: it travels as a copy
  if (req.op === 'display') return { value: await shownFor(design, numbers), kernel: which, transfer: [] };
  if (req.op === 'views') {
    // hidden lines of the display meshes, off the UI thread
    const shown = await shownFor(design, numbers);
    if (!shown) return { value: null, kernel: which, transfer: [] };
    const meshes = drawMeshes(shown, design);
    const views: Record<string, ViewLines> = {};
    for (const s of req.specs) views[s.key] = projectView(meshes, STANDARD_VIEWS[s.view], { hidden: s.hidden });
    // the views along the axes are dimensioned from the exact box, not the facets
    const box = oc ? visibleBoxOcc(oc, buildDesignCached(oc, design, numbers), design) : null;
    if (box) for (const s of req.specs) if (s.view !== 'iso') views[s.key].box = viewBox(box, STANDARD_VIEWS[s.view]);
    return { value: views, kernel: which, transfer: [] };
  }
  if (!oc && !K) throw new Error('the 3-D kernel could not load');
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

/** Serve kernel requests arriving on a port, one at a time (OCCT is synchronous anyway). */
export function serveKernel(port: { postMessage(m: unknown, transfer: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null }) {
  let queue = Promise.resolve();
  port.onmessage = (e: MessageEvent<KernelCall>) => {
    const { rid, req } = e.data;
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
      }
      port.postMessage(reply, transfer);
    });
  };
}
