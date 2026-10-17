// What the UI asks of a kernel worker and what comes back: plain data, posted over a
// MessagePort (typed arrays travel as transferables). In the worksheet window the
// calculation worker answers, so the solids it built for the worksheet serve the
// requests too; a separate CAD window starts a kernel worker of its own.
import type { BuildResult } from '../buildResult';
import type { CadDesign, DesignNumbers } from '../design';
import type { Distance, EntityRef, SectionPlane } from '../inspect';
import type { CadUnit } from '../model';
import type { Vec2 } from '../profile';
import type { Frame } from '../solid';
import type { ExportScope } from '../occ/exchange';
import type { Interference, SectionBody } from '../occ/query';
import type { DrawView, DrawViewRequest } from '../drawing2d';

export type { Distance, EntityRef, ExportScope, Interference, SectionBody, SectionPlane };

interface Built {
  design: CadDesign;
  numbers: DesignNumbers;
}

export type KernelRequest =
  /** Load the kernels now (the CAD workspace opened). */
  | { op: 'warm' }
  | ({ op: 'display' } & Built)
  | ({ op: 'section'; plane: SectionPlane } & Built)
  | ({ op: 'outline'; component: string; frame: Frame } & Built)
  | ({ op: 'export'; format: 'step' | 'stl'; scope: ExportScope; unit: CadUnit; name: string } & Built)
  | ({ op: 'distance'; a: EntityRef; b: EntityRef } & Built)
  | ({ op: 'interference' } & Built)
  /** Drawing views of the visible bodies: exact: hidden-line removal on the B-rep (the display mesh's without OpenCascade). */
  | ({ op: 'drawing'; views: DrawViewRequest[] } & Built);

/** What a request that needs a kernel fails with when neither could load. */
export const NO_KERNEL = 'the 3-D kernel could not load';

/** What a view says when neither kernel could load (the worksheet's results and a CAD window's own worker alike). */
export const NO_KERNEL_NOTICE = 'No 3-D kernel: neither OpenCascade nor the mesh kernel could load, so the part cannot be built or shown';

/** What each request answers. */
export interface KernelValues {
  /** Which kernels loaded. */
  warm: { brep: boolean; mesh: boolean };
  display: BuildResult | null;
  section: SectionBody[];
  outline: Vec2[][];
  export: Uint8Array;
  distance: Distance | null;
  interference: Interference[];
  /** Null while there is nothing built to draw. */
  drawing: Record<string, DrawView> | null;
}

export type KernelOp = KernelRequest['op'];

export interface KernelCall {
  rid: number;
  req: KernelRequest;
}

export type KernelReply =
  | { rid: number; ok: true; value: unknown; kernel: 'brep' | 'mesh' | 'none' }
  | { rid: number; ok: false; error: string };

/** The calculation worker's message that hands a MessagePort over for kernel requests. */
export interface KernelPortMessage {
  kernelPort: MessagePort;
}

export const isKernelPortMessage = (m: unknown): m is KernelPortMessage => !!m && typeof m === 'object' && 'kernelPort' in m;

/** Display data the calculation worker sends after the results it belongs to (design key → result). */
export interface DisplayMessage {
  display: [string, BuildResult][];
}

export const isDisplayMessage = (m: unknown): m is DisplayMessage => !!m && typeof m === 'object' && 'display' in m;

/** The typed arrays of a BuildResult (or anything holding them), for a transfer list. */
export function buffersOf(v: unknown, out: Set<ArrayBuffer> = new Set()): ArrayBuffer[] {
  const walk = (x: unknown) => {
    if (!x || typeof x !== 'object') return;
    if (ArrayBuffer.isView(x)) {
      if (x.buffer instanceof ArrayBuffer) out.add(x.buffer);
      return;
    }
    for (const y of Array.isArray(x) ? x : Object.values(x)) walk(y);
  };
  walk(v);
  return [...out];
}
