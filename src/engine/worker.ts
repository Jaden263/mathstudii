/// <reference lib="webworker" />
// Runs worksheet evaluation off the UI thread so long calculations (or
// accidental infinite loops) never freeze the interface.
import { evaluateWorksheet, type RegionResult } from './evaluator';
import { loadCas } from './symbolic';
import type { Worksheet } from '../model/types';
import { loadKernel } from '../cad/kernelBrowser';
import { loadOcc } from '../cad/occ/browser';
import { displayFor, ensureBrep, serveKernel, setKernelLoaders } from '../cad/kernel/service';
import { isKernelPortMessage, type DisplayMessage } from '../cad/kernel/protocol';
import type { BuildResult } from '../cad/buildResult';
import { designOf } from '../cad/design';
import { designNumbers, type CadResult } from '../cad/evaluate';
import { initPython, preparePackages, pythonReady } from '../python/runtime';
import { loadPythonBrowser } from '../python/browser';

export interface EvalRequest {
  id: number;
  ws: Worksheet;
  /** variable → expression replacing its definition (animation frames) */
  overrides?: Record<string, string>;
  /** Only return results for these regions (keeps animation frames small). */
  only?: string[];
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

// CAD parts need the solid kernel (WASM); it loads once, alongside the first evaluation
const kernelReady = loadKernel().catch((e) => console.warn('3-D kernel failed to load', e));

// the B-rep kernel is large: it loads for the first worksheet with a CAD part, whose
// results then follow again with exact values
setKernelLoaders(loadOcc, loadKernel);
let latest = 0;
const needsBrep = (out: ReturnType<typeof evaluateWorksheet>) => [...out.results.values()].some((r) => r.kind === 'cad' && r.needsBrep);

// display data (meshes, faces, edges) follows the results it belongs to, once per design
// key: a worksheet that recalculates for other reasons sends none
const sent = new Set<string>();
function sendDisplays(ws: Worksheet, out: ReturnType<typeof evaluateWorksheet>, only?: string[]) {
  const display: [string, BuildResult][] = [];
  for (const r of ws.regions) {
    if (r.kind !== 'cad' || (only && !only.includes(r.id))) continue;
    const dr = (out.results.get(r.id) as CadResult | undefined)?.design;
    if (!dr?.display || sent.has(dr.display)) continue;
    const b = displayFor(designOf(r), designNumbers(dr));
    if (!b) continue;
    sent.add(dr.display);
    display.push([dr.display, b]);
  }
  for (const k of sent) if (sent.size > 256) sent.delete(k);
  if (display.length) ctx.postMessage({ display } satisfies DisplayMessage);
}

ctx.onmessage = async (e: MessageEvent<EvalRequest>) => {
  // the UI's kernel requests (section, export …) come on a port of their own
  if (isKernelPortMessage(e.data)) return serveKernel(e.data.kernelPort);
  const { id, ws, overrides, only } = e.data;
  latest = id;
  const post = (out: ReturnType<typeof evaluateWorksheet>, partial: boolean) => {
    let results = [...out.results.entries()];
    if (only) results = results.filter(([rid]) => only.includes(rid));
    const msg: EvalResponse = { id, results, errorCount: out.errorCount, millis: out.millis, partial };
    ctx.postMessage(msg);
  };
  await kernelReady;
  const code = pythonCode(ws);
  if (code.length && pythonReady()) await preparePackages(code);
  let out = evaluateWorksheet(ws, overrides);
  if (out.needsPython && !only) {
    post(out, true);
    const failed = await startPython();
    if (failed) {
      out = evaluateWorksheet(ws, overrides);
      for (const r of out.results.values()) {
        if (r.kind === 'python' && r.loading) {
          r.loading = false;
          r.error = `Python could not start: ${failed}`;
          out.errorCount++;
        }
      }
      post(out, false);
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
};
