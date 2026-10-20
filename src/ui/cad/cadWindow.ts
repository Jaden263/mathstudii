// The CAD window: a separate browser or desktop window that edits one CAD part of the
// worksheet. The worksheet stays the single source of truth (undo history, evaluation);
// the window sends edits and receives the part and its results.
//
// Transport: Tauri events between desktop windows, BroadcastChannel in the browser.
// Every message carries the opening worksheet's session id, so two open worksheets
// never talk to each other's windows.
import { createContext, useContext } from 'react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import { isTauri } from '../../platform/files';

export type CadMsg =
  /** window → worksheet, also the heartbeat (`have`: the window has the part already, answer with 'alive' unless it changed) */
  | { t: 'hello'; s: string; id: string; seq: number; have?: boolean }
  | { t: 'patch'; s: string; id: string; seq: number; patch: Partial<CadRegion>; coalesce?: string; history?: false }
  | { t: 'bye'; s: string; id: string }
  /** worksheet → window: the part and its result, sent when they change (or the window has none) */
  | { t: 'state'; s: string; id: string; ack: number; region: CadRegion; result?: CadResult }
  /** worksheet → window: the answer to a heartbeat when nothing changed */
  | { t: 'alive'; s: string; id: string }
  | { t: 'gone'; s: string; id: string }
  /** worksheet → every window: its calculation worker was restarted (a kernel port to it is dead) */
  | { t: 'kernel'; s: string };

export interface CadChannel {
  post(m: CadMsg): void;
  close(): void;
}

const NAME = 'mathstudii-cad';

export function openChannel(onMsg: (m: CadMsg) => void): CadChannel {
  if (isTauri) {
    let unlisten: (() => void) | null = null;
    let closed = false;
    const ready = import('@tauri-apps/api/event').then(async (ev) => {
      const u = await ev.listen<CadMsg>(NAME, (e) => onMsg(e.payload));
      if (closed) u();
      else unlisten = u;
      return ev;
    });
    return {
      post: (m) => void ready.then((ev) => ev.emit(NAME, m)).catch(() => {}),
      close: () => {
        closed = true;
        unlisten?.();
      },
    };
  }
  if (typeof BroadcastChannel === 'undefined') return { post: () => {}, close: () => {} };
  const bc = new BroadcastChannel(NAME);
  bc.onmessage = (e) => onMsg(e.data as CadMsg);
  return { post: (m) => bc.postMessage(m), close: () => bc.close() };
}

/** This worksheet window's session id (a fresh one per page load). */
export const SESSION = Math.random().toString(36).slice(2, 10);

/** Phones and small tablets have no separate windows: the workspace opens inside the page. */
export function prefersOverlay(): boolean {
  if (typeof window === 'undefined') return true;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  return window.innerWidth < 900 || (!!coarse && window.innerWidth < 1200);
}

/** Open (or focus) the CAD window for a part. Resolves false when no window could be opened. */
export async function openCadWindow(id: string, title: string): Promise<boolean> {
  if (prefersOverlay()) return false;
  const hash = `cad=${encodeURIComponent(id)}&s=${SESSION}`;
  if (isTauri) {
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const label = `cad-${id.replace(/[^\w-]/g, '')}`;
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return true;
      }
      const w = new WebviewWindow(label, { url: `index.html#${hash}`, title, width: 1360, height: 860, minWidth: 720, minHeight: 480 });
      return await new Promise<boolean>((resolve) => {
        void w.once('tauri://created', () => resolve(true));
        void w.once('tauri://error', () => resolve(false));
      });
    } catch {
      return false;
    }
  }
  const url = `${location.pathname}${location.search}#${hash}`;
  const w = window.open(url, `mathstudii-cad-${id}`, 'popup=yes,width=1360,height=860');
  if (!w) return false;
  w.focus();
  return true;
}

// ------------------------------------------------------------ one kernel for both windows

/**
 * A browser CAD window asks the worksheet window that opened it for a port to the
 * worksheet's calculation worker, so both use one OpenCascade (and the window finds the
 * solids the worksheet built). Desktop windows are processes of their own: no opener.
 */
const KERNEL_ASK = 'mathstudii:kernel-port';

interface KernelAsk {
  t: typeof KERNEL_ASK;
  s: string;
  nonce: string;
}

const isKernelAsk = (m: unknown): m is KernelAsk => !!m && typeof m === 'object' && (m as KernelAsk).t === KERNEL_ASK;

/** In a CAD window: a port to the worksheet's kernel, or null (no worksheet window answered). */
export function askKernelPort(session: string, timeout = 3000): Promise<MessagePort | null> {
  const opener = typeof window !== 'undefined' ? (window.opener as Window | null) : null;
  if (isTauri || !opener || opener.closed) return Promise.resolve(null);
  const nonce = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (p: MessagePort | null) => {
      window.removeEventListener('message', onMsg);
      clearTimeout(t);
      resolve(p);
    };
    const onMsg = (e: MessageEvent) => {
      if (e.source !== opener || e.origin !== location.origin || !isKernelAsk(e.data) || e.data.nonce !== nonce) return;
      done(e.ports[0] ?? null);
    };
    const t = setTimeout(() => done(null), timeout);
    window.addEventListener('message', onMsg);
    try {
      opener.postMessage({ t: KERNEL_ASK, s: session, nonce } satisfies KernelAsk, location.origin);
    } catch {
      done(null);
    }
  });
}

/** In the worksheet window: hand each of its CAD windows that asks a port made by `connect`. */
export function answerKernelPorts(connect: (port: MessagePort) => void): () => void {
  const onMsg = (e: MessageEvent) => {
    if (e.origin !== location.origin || !isKernelAsk(e.data) || e.data.s !== SESSION || !e.source) return;
    const ch = new MessageChannel();
    connect(ch.port2);
    (e.source as Window).postMessage({ t: KERNEL_ASK, s: SESSION, nonce: e.data.nonce } satisfies KernelAsk, location.origin, [ch.port1]);
  };
  window.addEventListener('message', onMsg);
  return () => window.removeEventListener('message', onMsg);
}

/** Close this CAD window (Tauri windows need their own API). */
export async function closeThisWindow(): Promise<void> {
  if (isTauri) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
      return;
    } catch {
      /* fall through */
    }
  }
  window.close();
}

/** Lets a CAD region on the page open its editor. */
export const CadOpenContext = createContext<(id: string) => void>(() => {});
export const useOpenCad = () => useContext(CadOpenContext);

/** Parameters of a CAD window URL, or null on the worksheet page. */
export function cadWindowParams(): { id: string; session: string } | null {
  if (typeof location === 'undefined' || !location.hash.startsWith('#cad=')) return null;
  const q = new URLSearchParams(location.hash.slice(1));
  const id = q.get('cad'), session = q.get('s');
  return id && session ? { id, session } : null;
}
