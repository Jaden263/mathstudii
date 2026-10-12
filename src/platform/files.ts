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

export function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const AUTOSAVE_KEY = 'mathstudii:autosave';

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
