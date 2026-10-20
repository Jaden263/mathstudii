import { useCallback, useEffect, useRef, useState } from 'react';
import type { Worksheet } from '../model/types';
import type { RegionResult } from '../engine/evaluator';
import type { EvalRequest, EvalResponse } from '../engine/worker';
import { isMemoryReply, type MemoryQuery, type WorkerMemory } from '../engine/memoryProtocol';
import { isDisplayMessage, type DisplayMessage } from '../cad/kernel/protocol';
import { kernelHostStopped, receiveDisplay, setKernelHost, shownKeys } from './cad/kernelClient';
import { isExportResponse, type ExportRequest, type ExportResponse } from '../sheet/exportWorker';
import { isWorksheetExportResponse, type WorksheetExportRequest, type WorksheetExportResponse } from '../exporters/exportWorker';
import type { Format, Picture } from '../exporters';
import { sameForEvaluation } from '../model/protect';
import { IDLE_RELEASE_MS, needsOf, nextCheck, releaseReason } from './idleRelease';

export interface EvaluationState {
  results: Map<string, RegionResult>;
  busy: boolean;
  /** Calculation has been running long enough to offer an interrupt. */
  slow: boolean;
  errorCount: number;
  millis: number;
  interrupted: boolean;
}

const SLOW_MS = 1200;

function createWorker() {
  return new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
}

/** What the worker evaluates: pictures without their data (nothing calculates with them, and each would be copied every time). */
const forEvaluation = (ws: Worksheet): Worksheet => (ws.regions.some((r) => r.kind === 'image' && r.src)
  ? { ...ws, regions: ws.regions.map((r) => (r.kind === 'image' ? { ...r, src: '' } : r)) }
  : ws);

/** The worksheet's parts had exact (OpenCascade) values: a new worker loads it before it evaluates. */
const hadBrep = (results: Map<string, RegionResult>) => [...results.values()].some((r) => r.kind === 'cad' && !!r.design?.brep);

/**
 * Evaluates the worksheet in a Web Worker whenever it changes (debounced). The worker is
 * stopped once it has been idle for a while and holds what the worksheet does not need
 * (see idleRelease.ts), and started again by the next calculation or kernel request.
 * `onRestart` hears about every worker that was stopped (CAD windows using it ask again).
 */
export function useEvaluation(ws: Worksheet, auto: boolean, onRestart?: () => void) {
  const [state, setState] = useState<EvaluationState>({
    results: new Map(), busy: false, slow: false, errorCount: 0, millis: 0, interrupted: false,
  });
  const workerRef = useRef<Worker | null>(null);
  const reqId = useRef(0);
  const slowTimer = useRef<number | undefined>(undefined);
  const latest = useRef(ws);
  latest.current = ws;
  const results = useRef(state.results);
  results.current = state.results;
  const restarted = useRef(onRestart);
  restarted.current = onRestart;
  const exports = useRef(new Map<number, (r: ExportResponse) => void>());
  const wsExports = useRef(new Map<number, (r: WorksheetExportResponse) => void>());
  const queries = useRef(new Map<number, (m: WorkerMemory | null) => void>());
  const nextQuery = useRef(0);
  /** The worker has not been asked to evaluate yet (it was just started). */
  const fresh = useRef(true);
  const idleTimer = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  busy.current = state.busy;
  // set below, used by the worker's message handler
  const armIdle = useRef(() => {});
  const restartNow = useRef(() => {});

  const attach = useCallback((w: Worker) => {
    w.onmessage = (e: MessageEvent<EvalResponse | DisplayMessage | ExportResponse>) => {
      // CAD display data follows the results it belongs to
      if (isDisplayMessage(e.data)) return receiveDisplay(e.data);
      if (isMemoryReply(e.data)) {
        queries.current.get(e.data.memoryReport)?.(e.data.memory);
        queries.current.delete(e.data.memoryReport);
        return;
      }
      if (isExportResponse(e.data)) {
        exports.current.get(e.data.xlsxExport)?.(e.data);
        exports.current.delete(e.data.xlsxExport);
        return;
      }
      if (isWorksheetExportResponse(e.data)) {
        wsExports.current.get(e.data.worksheetExport)?.(e.data);
        wsExports.current.delete(e.data.worksheetExport);
        return;
      }
      const msg = e.data;
      if (msg.id !== reqId.current) return;
      busy.current = msg.partial;
      if (!msg.partial) {
        window.clearTimeout(slowTimer.current);
        armIdle.current();
        // the B-rep heap is past its limit: a fresh worker gives it all back at once
        if (msg.restart) window.setTimeout(() => restartNow.current(), 0);
      }
      setState({
        results: new Map(msg.results),
        busy: msg.partial,
        slow: false,
        errorCount: msg.errorCount,
        millis: msg.millis,
        interrupted: false,
      });
    };
    w.onerror = (err) => {
      console.error('Evaluation worker error', err);
      // the CAD views' kernel requests it was answering fail now instead of waiting forever
      kernelHostStopped('the calculation failed — try again');
      setState((s) => ({ ...s, busy: false, slow: false }));
    };
  }, []);

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      workerRef.current = createWorker();
      fresh.current = true;
      attach(workerRef.current);
      armIdle.current();
    }
    return workerRef.current;
  }, [attach]);

  /** Stop the worker; whatever it was asked fails. */
  const stop = useCallback((why: string) => {
    const w = workerRef.current;
    if (!w) return;
    w.terminate();
    workerRef.current = null;
    window.clearTimeout(idleTimer.current);
    for (const done of exports.current.values()) done({ xlsxExport: 0, error: `The calculation was ${why}` });
    exports.current.clear();
    for (const done of wsExports.current.values()) done({ worksheetExport: 0, error: `The calculation was ${why}` });
    wsExports.current.clear();
    for (const q of queries.current.values()) q(null);
    queries.current.clear();
    kernelHostStopped(`the calculation was ${why} — try again`);
    restarted.current?.();
  }, []);

  /** What the worker holds now (null: there is none, or it did not answer). */
  const queryMemory = useCallback((): Promise<WorkerMemory | null> => {
    const w = workerRef.current;
    if (!w) return Promise.resolve(null);
    const id = ++nextQuery.current;
    return new Promise((resolve) => {
      queries.current.set(id, resolve);
      w.postMessage({ memoryQuery: id } satisfies MemoryQuery);
      window.setTimeout(() => {
        if (queries.current.delete(id)) resolve(null);
      }, 5000);
    });
  }, []);

  /**
   * Stop the worker if nothing is running in it and the worksheet does not need what it
   * holds (`force`: whatever it holds, the "Free memory" action). True when it was stopped.
   */
  const release = useCallback(async (force = false): Promise<boolean> => {
    const m = await queryMemory();
    if (!m || !workerRef.current) return false;
    const needs = needsOf(latest.current);
    const pending = exports.current.size > 0 || wsExports.current.size > 0 || busy.current || m.busy;
    if (!pending && (force || releaseReason(m, needs))) {
      stop('restarted to free memory');
      return true;
    }
    // look again when something could be let go (nothing at all while it is not used)
    const next = pending ? IDLE_RELEASE_MS : nextCheck(m, needs);
    window.clearTimeout(idleTimer.current);
    if (next !== null) idleTimer.current = window.setTimeout(() => void release(), next);
    return false;
  }, [queryMemory, stop]);

  armIdle.current = () => {
    window.clearTimeout(idleTimer.current);
    if (workerRef.current) idleTimer.current = window.setTimeout(() => void release(), IDLE_RELEASE_MS);
  };

  const calculate = useCallback(() => {
    const id = ++reqId.current;
    const w = getWorker();
    const req: EvalRequest = { id, ws: forEvaluation(latest.current) };
    // a restarted worker: exact values from the start, and no display data the views still have
    if (fresh.current) {
      if (hadBrep(results.current)) req.preload = 'brep';
      const keys = shownKeys();
      if (keys.length) req.shown = keys;
    }
    fresh.current = false;
    busy.current = true;
    w.postMessage(req);
    window.clearTimeout(idleTimer.current);
    setState((s) => ({ ...s, busy: true }));
    window.clearTimeout(slowTimer.current);
    slowTimer.current = window.setTimeout(() => {
      if (reqId.current === id) setState((s) => (s.busy ? { ...s, slow: true } : s));
    }, SLOW_MS);
  }, [getWorker]);

  // (between calculations; with auto calculation the fresh worker evaluates the worksheet
  // again at once, so the next edit does not wait for OpenCascade to load)
  restartNow.current = () => {
    if (!workerRef.current || busy.current || exports.current.size || wsExports.current.size) return;
    stop('restarted to free memory');
    if (auto) calculate();
  };

  const interrupt = useCallback(() => {
    stop('interrupted');
    reqId.current++;
    window.clearTimeout(slowTimer.current);
    setState((s) => ({ ...s, busy: false, slow: false, interrupted: true }));
  }, [stop]);

  // only what evaluates counts: turning a 3-D view or zooming a sketch calculates nothing
  const content = useRef(ws);
  if (ws !== content.current && !sameForEvaluation(content.current, ws)) content.current = ws;
  const evalWs = content.current;
  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(calculate, 120);
    return () => window.clearTimeout(t);
  }, [evalWs, auto, calculate]);

  /** The worksheet's values as an .xlsx file, made by the calculation worker. */
  const exportXlsx = useCallback((doc: Worksheet) => new Promise<Uint8Array>((resolve, reject) => {
    const id = Date.now() + Math.random();
    exports.current.set(id, (r) => (r.bytes ? resolve(r.bytes) : reject(new Error(r.error ?? 'Export failed'))));
    getWorker().postMessage({ xlsxExport: id, ws: doc } satisfies ExportRequest);
  }), [getWorker]);

  /** The worksheet as a Mathcad or SMath file, with the pictures of the regions those programs do not have. */
  const exportWorksheet = useCallback((doc: Worksheet, format: Format, pictures: Map<string, Picture>) => new Promise<{ bytes: Uint8Array; warnings: string[] }>((resolve, reject) => {
    const id = Date.now() + Math.random();
    wsExports.current.set(id, (r) => (r.bytes ? resolve({ bytes: r.bytes, warnings: r.warnings ?? [] }) : reject(new Error(r.error ?? 'Export failed'))));
    getWorker().postMessage({ worksheetExport: id, ws: doc, format, pictures: [...pictures] } satisfies WorksheetExportRequest);
  }), [getWorker]);

  /** Hand a port for kernel requests to the worker (a CAD window of this worksheet asked for one). */
  const connectKernel = useCallback((port: MessagePort) => {
    getWorker().postMessage({ kernelPort: port }, [port]);
  }, [getWorker]);

  useEffect(() => () => {
    window.clearTimeout(idleTimer.current);
    workerRef.current?.terminate();
  }, []);
  // the calculation worker also answers the CAD views' kernel requests (set while rendering:
  // the views below ask in their effects, which run before this hook's)
  setKernelHost(getWorker);

  return { ...state, calculate, interrupt, exportXlsx, exportWorksheet, connectKernel, queryMemory, release };
}
