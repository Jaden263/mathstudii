// .xlsx files for tables and spreadsheet components: picking one, and keeping a link to it so
// it can be read again when it changes. The desktop app links by path (and watches its
// modification time); Chromium browsers keep a File System Access handle in this browser's
// storage, which survives reloads but needs a click to read again after one; other browsers
// cannot link at all, so the file is imported again by hand.
import { baseName, isTauri, pickFile } from './files';
import { getLink, putLink } from './library';
import type { SheetLink } from '../sheet/model';

export interface PickedXlsx {
  name: string;
  bytes: Uint8Array;
  path?: string;
  handle?: FileSystemFileHandle;
  modified?: number;
}

const ACCEPT = '.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FILTERS = [{ name: 'Excel workbook', extensions: ['xlsx', 'xlsm'] }];

type PermHandle = FileSystemFileHandle & {
  queryPermission?: (o: { mode: 'read' }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: 'read' }) => Promise<PermissionState>;
};
interface FsWindow {
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
}
const fsw = (typeof window !== 'undefined' ? window : {}) as unknown as FsWindow;

/** Can a component keep a link to a file here? */
export const canLinkXlsx = isTauri || !!fsw.showOpenFilePicker;

/** Pick a workbook; with `link`, one the app can read again later (a path or a file handle). */
export async function pickXlsx(link = false): Promise<PickedXlsx | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile, stat } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, filters: FILTERS });
    if (!path || Array.isArray(path)) return null;
    const info = await stat(path).catch(() => null);
    return { name: baseName(path), bytes: await readFile(path), path, modified: info?.mtime?.getTime() };
  }
  if (link && fsw.showOpenFilePicker) {
    try {
      const [h] = await fsw.showOpenFilePicker({ types: [{ description: 'Excel workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xlsm'] } }], multiple: false });
      const f = await h.getFile();
      return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), handle: h, modified: f.lastModified };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      throw e;
    }
  }
  const f = await pickFile(ACCEPT);
  return f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), modified: f.lastModified } : null;
}

/** The link to keep in the worksheet for a picked file (null when this platform cannot keep one). */
export async function linkOf(p: PickedXlsx): Promise<SheetLink | null> {
  if (p.path) return { file: p.name, path: p.path, modified: p.modified, watch: true };
  if (p.handle) {
    const key = `xlsx:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    handles.set(key, p.handle as PermHandle);
    await putLink(key, p.handle);
    return { file: p.name, handle: key, modified: p.modified, watch: true };
  }
  return null;
}

export type LinkState =
  | { ok: true; modified: number }
  /** The browser wants a click before the page may read the file again. */
  | { ok: false; why: 'permission' | 'missing' | 'error'; message: string };

/** Handles of this visit (the browser's storage keeps them for the next one). */
const handles = new Map<string, PermHandle>();

async function handleOf(link: SheetLink): Promise<PermHandle | null> {
  if (!link.handle) return null;
  const known = handles.get(link.handle);
  if (known) return known;
  const h = await getLink(link.handle);
  if (!h || typeof h === 'string') return null;
  handles.set(link.handle, h as PermHandle);
  return h as PermHandle;
}

/** When the linked file last changed, without reading it. `ask` may show the browser's prompt (needs a click). */
export async function linkModified(link: SheetLink, ask = false): Promise<LinkState> {
  try {
    if (link.path) {
      if (!isTauri) return { ok: false, why: 'missing', message: `${link.file} is linked in the desktop app; here it can only be imported again` };
      const { stat } = await import('@tauri-apps/plugin-fs');
      const info = await stat(link.path);
      return { ok: true, modified: info.mtime?.getTime() ?? 0 };
    }
    const h = await handleOf(link);
    if (!h) return { ok: false, why: 'missing', message: `The link to ${link.file} was made in another browser or on another computer: link the file again` };
    if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted') {
      if (!ask || !h.requestPermission || (await h.requestPermission({ mode: 'read' })) !== 'granted') {
        return { ok: false, why: 'permission', message: `Click Reconnect to read ${link.file} again (the browser asks once per visit)` };
      }
    }
    return { ok: true, modified: (await h.getFile()).lastModified };
  } catch (e) {
    return { ok: false, why: 'error', message: `${link.file} cannot be read: ${(e as Error).message}` };
  }
}

/** Read the linked file. */
export async function readLinked(link: SheetLink, ask = false): Promise<{ bytes: Uint8Array; modified: number } | Exclude<LinkState, { ok: true }>> {
  const st = await linkModified(link, ask);
  if (!st.ok) return st;
  try {
    if (link.path) {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      return { bytes: await readFile(link.path), modified: st.modified };
    }
    const f = await (await handleOf(link))!.getFile();
    return { bytes: new Uint8Array(await f.arrayBuffer()), modified: f.lastModified };
  } catch (e) {
    return { ok: false, why: 'error', message: `${link.file} cannot be read: ${(e as Error).message}` };
  }
}
