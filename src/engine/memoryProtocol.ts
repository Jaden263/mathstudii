// What the page asks a calculation worker about the memory it holds, and the answer (the
// memory readout, and the idle release in idleRelease.ts).

/** What the page asks to see what a worker holds (the memory readout, idle release). */
export interface MemoryQuery {
  memoryQuery: number;
}

/** What a calculation worker holds. */
export interface WorkerMemory {
  /** Heap of the B-rep kernel (bytes; 0: not loaded). */
  occt: number;
  /** Heaps of replaced B-rep kernels not collected yet (bytes). */
  occtStale: number;
  /** The mesh kernel is loaded (its heap size is not exposed). */
  manifold: boolean;
  /** Heap of Python (bytes; 0: not started). */
  python: number;
  /** The symbolic engine is loaded. */
  cas: boolean;
  /** JavaScript heap in use (bytes), where the browser tells. */
  jsHeap?: number;
  /** Display data and drawing views kept for the CAD views (bytes, included in jsHeap). */
  caches: number;
  /** Milliseconds since the worker last calculated or answered a kernel request. */
  idleMs: number;
  /** Something is running or waiting. */
  busy: boolean;
}

export interface MemoryReply {
  memoryReport: number;
  memory: WorkerMemory;
}

export const isMemoryQuery = (m: unknown): m is MemoryQuery => !!m && typeof m === 'object' && 'memoryQuery' in m;
export const isMemoryReply = (m: unknown): m is MemoryReply => !!m && typeof m === 'object' && 'memoryReport' in m;
