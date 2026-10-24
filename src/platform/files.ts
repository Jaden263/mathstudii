// File access across platforms:
//  - Tauri desktop/mobile builds use native dialogs + filesystem plugins
//  - Chromium browsers use the File System Access API (real "Save")
//  - everything else falls back to file input + download

export type FileHandle = string | FileSystemFileHandle | null;

export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
  handle: FileHandle;
}

export const FILE_EXT = 'mstd';
const FILTERS = [{ name: 'mathstudii worksheet', extensions: [FILE_EXT, 'json'] }];
const OPEN_FILTERS = [
  { name: 'Worksheets (mathstudii, Mathcad, SMath)', extensions: [FILE_EXT, 'json', 'mcdx', 'xmcd', 'sm', 'smz'] },
  { name: 'Mathcad Prime', extensions: ['mcdx'] },
  { name: 'Mathcad 11–15', extensions: ['xmcd'] },
  { name: 'SMath Studio', extensions: ['sm', 'smz'] },
];

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface FsWindow {
  showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle>;
}
const fsw = (typeof window !== 'undefined' ? window : {}) as unknown as FsWindow;
const pickerTypes = [{ description: 'mathstudii worksheet', accept: { 'application/json': [`.${FILE_EXT}`, '.json'] } }];
const openPickerTypes = [{
  description: 'Worksheets (mathstudii, Mathcad Prime, Mathcad 15, SMath Studio)',
  accept: { 'application/octet-stream': [`.${FILE_EXT}`, '.json', '.mcdx', '.xmcd', '.sm', '.smz'] },
}];

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Pick a worksheet (or a Mathcad / SMath file) and read its bytes. */
export async function openWorksheetFile(): Promise<OpenedFile | null> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({ multiple: false, filters: OPEN_FILTERS });
    if (!path || Array.isArray(path)) return null;
    return { name: baseName(path), bytes: await readFile(path), handle: path };
  }
  if (fsw.showOpenFilePicker) {
    try {
      const [h] = await fsw.showOpenFilePicker({ types: openPickerTypes, multiple: false });
      const f = await h.getFile();
      return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), handle: h };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      throw e;
    }
  }
  const file = await pickFile(`.${FILE_EXT},.json,.mcdx,.xmcd,.sm,.smz`);
  return file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle: null } : null;
}

/** Files opened through an importer rather than as mathstudii JSON. */
export function foreignFormat(name: string): 'mathcad' | 'smath' | null {
  if (/\.(mcdx|xmcd)$/i.test(name)) return 'mathcad';
  if (/\.smz?$/i.test(name)) return 'smath';
  return null;
}

/** Whether this platform can remember a save location (desktop app, Chromium browsers). */
export const canLinkFiles = isTauri || !!fsw.showSaveFilePicker;

/** Write a linked file without any dialog. */
export async function writeLinkedFile(handle: FileHandle, text: string): Promise<void> {
  if (!handle) throw new Error('no file');
  if (typeof handle === 'string') {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(handle, text);
    return;
  }
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

export const handleName = (h: FileHandle) => (!h ? '' : typeof h === 'string' ? baseName(h) : h.name);

/** Save to an existing handle, or ask for a location. Returns the handle used, or null if cancelled. */
export async function saveWorksheetFile(text: string, suggestedName: string, handle: FileHandle, saveAs = false): Promise<{ name: string; handle: FileHandle } | null> {
  const fileName = suggestedName.endsWith(`.${FILE_EXT}`) ? suggestedName : `${suggestedName}.${FILE_EXT}`;
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    let path = !saveAs && typeof handle === 'string' ? handle : null;
    if (!path) path = await save({ defaultPath: fileName, filters: FILTERS });
    if (!path) return null;
    await writeTextFile(path, text);
    return { name: baseName(path), handle: path };
  }
  if (fsw.showSaveFilePicker) {
    try {
      let h = !saveAs && handle && typeof handle !== 'string' ? handle : null;
      if (!h) h = await fsw.showSaveFilePicker({ suggestedName: fileName, types: pickerTypes });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return { name: h.name, handle: h };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
      throw e;
    }
  }
  downloadBlob(new Blob([text], { type: 'application/json' }), fileName);
  return { name: fileName, handle: null };
}

/** Save an exported file (DXF, STL …): a save dialog in the desktop app, a download in the browser. */
export async function exportFile(name: string, data: Uint8Array | string, mime: string): Promise<void> {
  const ext = name.split('.').pop() ?? '';
  if (isTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return;
    if (typeof data === 'string') await writeTextFile(path, data);
    else await writeFile(path, data);
    return;
  }
  const part: BlobPart = typeof data === 'string' ? data : new Uint8Array(data);
  downloadBlob(new Blob([part], { type: mime }), name);
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** CAD files to import (STEP, STL, OBJ with its MTL, 3MF): a native dialog in the desktop app, a file input in the browser. */
export async function pickImportFiles(): Promise<{ name: string; bytes: Uint8Array }[]> {
  const ext = ['step', 'stp', 'stl', 'obj', 'mtl', '3mf'];
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const picked = await open({ multiple: true, filters: [{ name: 'CAD files (STEP, STL, OBJ, 3MF)', extensions: ext }] });
    const paths = !picked ? [] : Array.isArray(picked) ? picked : [picked];
    return Promise.all(paths.map(async (p) => ({ name: baseName(p), bytes: await readFile(p) })));
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ext.map((e) => `.${e}`).join(',');
    input.onchange = () => void Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))).then(resolve);
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * A second window of the app (index.html?w=…) keeps its own autosave and open documents, so
 * two windows never write over each other.
 */
export const WINDOW_ID = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('w') : null;
/** A preference that belongs to this window (open tabs, active document). */
export const windowKey = (key: string) => (WINDOW_ID ? `${key}:${WINDOW_ID}` : key);
const AUTOSAVE_KEY = windowKey('mathstudii:autosave');

export function loadAutosave(): string | null {
  try {
    return localStorage.getItem(AUTOSAVE_KEY);
  } catch {
    return null;
  }
}

export function writeAutosave(text: string) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, text);
  } catch {
    /* storage full or unavailable (private mode): autosave is best effort */
  }
}

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`mathstudii:${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`mathstudii:${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/**
 * Another mathstudii window (desktop: a native window; browser: a new window), optionally
 * opening a document of the library: to look at one worksheet while editing another.
 */
export async function openAppWindow(docId?: string): Promise<void> {
  const w = Math.random().toString(36).slice(2, 8);
  const query = `?w=${w}${docId ? `&doc=${encodeURIComponent(docId)}` : ''}`;
  if (isTauri) {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    new WebviewWindow(`doc-${w}`, { url: `index.html${query}`, title: 'mathstudii', width: 1280, height: 860, minWidth: 600, minHeight: 400 });
    return;
  }
  window.open(`${location.pathname}${query}`, `mathstudii-${w}`, `width=${Math.min(1280, screen.availWidth)},height=${Math.min(900, screen.availHeight)}`);
}
