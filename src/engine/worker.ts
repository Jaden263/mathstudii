/// <reference lib="webworker" />
// Runs worksheet evaluation off the UI thread so long calculations (or
// accidental infinite loops) never freeze the interface.
import { evaluateWorksheet, type RegionResult } from './evaluator';
import { casReady, loadCas } from './symbolic';
import type { Worksheet } from '../model/types';
import { loadKernel } from '../cad/kernelBrowser';
import { loadOcc } from '../cad/occ/browser';
import { occ, occHeapBytes, occStaleBytes } from '../cad/occ/kernel';
import { kernel } from '../cad/solid';
import { displayFor, ensureBrep, ensureMesh, kernelActivity, kernelCacheBytes, serveKernel, setKernelLoaders } from '../cad/kernel/service';
import { buffersOf, isKernelPortMessage, type DisplayMessage } from '../cad/kernel/protocol';
import type { BuildResult } from '../cad/buildResult';
import { designOf, hasFeatures } from '../cad/design';
import { designNumbers, type CadResult } from '../cad/evaluate';
import { initPython, preparePackages, pythonHeapBytes, pythonReady } from '../python/runtime';
import { loadPythonBrowser } from '../python/browser';
import { answerExport, isExportRequest } from '../sheet/exportWorker';
import { answerWorksheetExport, isWorksheetExportRequest } from '../exporters/exportWorker';
import { isMemoryQuery, type MemoryReply, type WorkerMemory } from './memoryProtocol';

export interface EvalRequest {
  id: number;
  ws: Worksheet;
  /** variable → expression replacing its definition (animation frames) */
  overrides?: Record<string, string>;
  /** Only return results for these regions (keeps animation frames small). */
  only?: string[];
  /**
   * The first request to a restarted worker: load OpenCascade before evaluating (the
   * worksheet's parts had exact values, which must not turn approximate meanwhile) …
   */
  preload?: 'brep';
  /** … and the display data the page still has (made by OpenCascade), not to be sent again. */
  shown?: string[];
}

export interface EvalResponse {
  id: number;
  results: [string, RegionResult][];
  errorCount: number;
  millis: number;
  /** More results will follow (symbolic engine or Python still loading). */
  partial: boolean;
}

/** Python code of the regions that will run. */
function pythonCode(ws: Worksheet): string[] {
  return ws.regions.flatMap((r) => (r.kind === 'python' && !r.disabled && r.code.trim() ? [r.code] : []));
}

async function startPython(): Promise<string | null> {
  try {
    await initPython(loadPythonBrowser);
    return null;
  } catch (e) {
    console.warn('Python failed to start', e);
    return (e as Error).message ?? String(e);
  }
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// CAD parts need a solid kernel (WASM): the small mesh kernel loads with the first
// worksheet that has a part with features, and builds it until OpenCascade is in (with
// OpenCascade loaded first it is not needed at all)
const hasParts = (ws: Worksheet) => ws.regions.some((r) => r.kind === 'cad' && hasFeatures(designOf(r)));
const meshIfNeeded = async (ws: Worksheet) => {
  if (hasParts(ws) && !occ()) await ensureMesh();
};
// OpenCascade loaded but the part still waits for a kernel: OCCT failed outside a feature
// (out of memory) and the mesh kernel stands in
const waitsForKernel = (out: ReturnType<typeof evaluateWorksheet>) => [...out.results.values()].some((r) => r.kind === 'cad' && r.needsKernel);

// the B-rep kernel is large: it loads for the first worksheet with a CAD part, whose
// results then follow again with exact values
setKernelLoaders(loadOcc, loadKernel);
let latest = 0;
const needsBrep = (out: ReturnType<typeof evaluateWorksheet>) => [...out.results.values()].some((r) => r.kind === 'cad' && r.needsBrep);

// display data (meshes, faces, edges) follows the results it belongs to, once per design
// key: a worksheet that recalculates for other reasons sends none. Filed with the kernel
// that made it: once OpenCascade is in (or renewed) the mesh kernel's stand-ins go again.
const sent = new Map<string, BuildResult['kernel']>();
let sentBy: unknown = null;
function sendDisplays(ws: Worksheet, out: ReturnType<typeof evaluateWorksheet>, only?: string[]) {
  if (occ() !== sentBy) {
    for (const [k, by] of sent) if (by !== 'brep') sent.delete(k);
    sentBy = occ();
  }
  const display: [string, BuildResult][] = [];
  for (const r of ws.regions) {
    if (r.kind !== 'cad' || (only && !only.includes(r.id))) continue;
    const dr = (out.results.get(r.id) as CadResult | undefined)?.design;
    if (!dr?.display || sent.has(dr.display)) continue;
    const b = displayFor(designOf(r), designNumbers(dr));
    if (!b) continue;
    sent.set(dr.display, b.kernel);
    display.push([dr.display, b]);
  }
  for (const k of sent.keys()) if (sent.size > 256) sent.delete(k);
  if (!display.length) return;
  // the cache here keeps its own: the page gets a copy whose arrays move over (one copy, not two)
  const msg: DisplayMessage = { display: structuredClone(display) };
  ctx.postMessage(msg, buffersOf(msg));
}

// ------------------------------------------------------------ what this worker holds

let evaluating = 0;
let lastEval = 0;

function memoryReport(): WorkerMemory {
  const k = kernelActivity();
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
  return {
    occt: occHeapBytes(),
    occtStale: occStaleBytes(),
    manifold: !!kernel(),
    python: pythonHeapBytes(),
    cas: casReady(),
    ...(heap ? { jsHeap: heap } : {}),
    caches: kernelCacheBytes(),
    idleMs: performance.now() - Math.max(lastEval, k.last),
    busy: evaluating > 0 || k.pending > 0,
  };
}

ctx.onmessage = async (e: MessageEvent<EvalRequest>) => {
  // the UI's kernel requests (section, export …) come on a port of their own
  if (isKernelPortMessage(e.data)) return serveKernel(e.data.kernelPort);
  if (isMemoryQuery(e.data)) return ctx.postMessage({ memoryReport: e.data.memoryQuery, memory: memoryReport() } satisfies MemoryReply);
  evaluating++;
  try {
    await handle(e);
  } finally {
    evaluating--;
    lastEval = performance.now();
  }
};

async function handle(e: MessageEvent<EvalRequest>) {
  // an .xlsx export of the worksheet's values
  if (isExportRequest(e.data)) {
    const res = answerExport(e.data);
    return ctx.postMessage(res, res.bytes ? [res.bytes.buffer as ArrayBuffer] : []);
  }
  // a Mathcad or SMath file of the worksheet (the parts and Python it reads come in first)
  if (isWorksheetExportRequest(e.data)) {
    await meshIfNeeded(e.data.ws);
    const code = pythonCode(e.data.ws);
    if (code.length && pythonReady()) await preparePackages(code);
    const res = answerWorksheetExport(e.data);
    return ctx.postMessage(res, res.bytes ? [res.bytes.buffer as ArrayBuffer] : []);
  }
  const { id, ws, overrides, only, preload, shown } = e.data;
  latest = id;
  for (const k of shown ?? []) sent.set(k, 'brep');
  if (preload === 'brep' && hasParts(ws)) await ensureBrep();
  const post = (out: ReturnType<typeof evaluateWorksheet>, partial: boolean) => {
    let results = [...out.results.entries()];
    if (only) results = results.filter(([rid]) => only.includes(rid));
    const msg: EvalResponse = { id, results, errorCount: out.errorCount, millis: out.millis, partial };
    ctx.postMessage(msg);
  };
  await meshIfNeeded(ws);
  const code = pythonCode(ws);
  if (code.length && pythonReady()) await preparePackages(code);
  let out = evaluateWorksheet(ws, overrides);
  if (waitsForKernel(out) && occ()) {
    await ensureMesh();
    out = evaluateWorksheet(ws, overrides);
  }
  if (out.needsPython && !only) {
    post(out, true);
    const failed = await startPython();
    if (failed) {
      // no evaluation follows this one: CAD parts get their exact values now
      if (needsBrep(out)) await ensureBrep();
      out = evaluateWorksheet(ws, overrides);
      for (const r of out.results.values()) {
        if (r.kind === 'python' && r.loading) {
          r.loading = false;
          r.error = `Python could not start: ${failed}`;
          out.errorCount++;
        }
      }
      post(out, false);
      sendDisplays(ws, out);
      return;
    }
    await preparePackages(code);
    out = evaluateWorksheet(ws, overrides);
  }
  if (out.needsCas && !only) {
    post(out, true);
    await loadCas();
    out = evaluateWorksheet(ws, overrides);
  }
  post(out, false);
  sendDisplays(ws, out, only);
  if (!only && needsBrep(out)) {
    await ensureBrep();
    if (id !== latest) return;
    // exact values (or, if OpenCascade could not load, the mesh kernel's with a notice)
    out = evaluateWorksheet(ws, overrides);
    post(out, false);
    sendDisplays(ws, out);
  }
}
