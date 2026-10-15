// The document library: every worksheet is kept in the browser (IndexedDB) and saved
// there continuously, so closing the tab never loses work. A document can also be
// linked to a file on disk (a File System Access handle in Chromium browsers, a path in
// the desktop app); the link is remembered, so Save writes there without asking again.
import type { FileHandle } from './files';

export interface LibraryEntry {
  id: string;
  title: string;
  /** Last change, ms since epoch. */
  updated: number;
  /** Name of the linked file, if any. */
  file?: string;
  size: number;
}

interface StoredDoc extends LibraryEntry {
  text: string;
}

const DB = 'mathstudii';
const DOCS = 'docs';
const LINKS = 'links';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(DOCS)) d.createObjectStore(DOCS, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(LINKS)) d.createObjectStore(LINKS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return db().then((d) => new Promise<T | undefined>((resolve) => {
    if (!d) return resolve(undefined);
    try {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export function newDocId(): string {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Store a worksheet (JSON text) under its id. Resolves false when storage is unavailable or full. */
export async function putDoc(id: string, title: string, text: string, file?: string): Promise<boolean> {
  const doc: StoredDoc = { id, title: title || 'Untitled', updated: Date.now(), text, size: text.length, ...(file ? { file } : {}) };
  const r = await run(DOCS, 'readwrite', (s) => s.put(doc));
  return r !== undefined;
}

export async function getDoc(id: string): Promise<string | null> {
  const d = await run<StoredDoc>(DOCS, 'readonly', (s) => s.get(id));
  return d?.text ?? null;
}

export async function listDocs(): Promise<LibraryEntry[]> {
  const all = (await run<StoredDoc[]>(DOCS, 'readonly', (s) => s.getAll())) ?? [];
  return all.map(({ text: _text, ...e }) => e).sort((a, b) => b.updated - a.updated);
}

export async function deleteDoc(id: string): Promise<void> {
  await run(DOCS, 'readwrite', (s) => s.delete(id));
  await run(LINKS, 'readwrite', (s) => s.delete(id));
}

/** Remember (or forget) the file a document is linked to. Handles are stored as they are. */
export async function putLink(id: string, handle: FileHandle): Promise<void> {
  if (handle) await run(LINKS, 'readwrite', (s) => s.put(handle, id));
  else await run(LINKS, 'readwrite', (s) => s.delete(id));
}

export async function getLink(id: string): Promise<FileHandle> {
  return ((await run<FileHandle>(LINKS, 'readonly', (s) => s.get(id))) ?? null) as FileHandle;
}

type PermHandle = FileSystemFileHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
};

/**
 * Can we write the linked file now? Paths (desktop) always; browser handles once the
 * user has allowed it in this session. `ask` may show the browser's prompt (needs a click).
 */
export async function canWrite(handle: FileHandle, ask: boolean): Promise<boolean> {
  if (!handle) return false;
  if (typeof handle === 'string') return true;
  const h = handle as PermHandle;
  try {
    if (!h.queryPermission) return true;
    if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    if (ask && h.requestPermission) return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    /* treat as not writable */
  }
  return false;
}

/** The library document already linked to this file, if any (so reopening a file reuses it). */
export async function findLinked(handle: FileHandle): Promise<string | null> {
  if (!handle) return null;
  const d = await db();
  if (!d) return null;
  const pairs = await new Promise<[string, FileHandle][]>((resolve) => {
    const out: [string, FileHandle][] = [];
    try {
      const req = d.transaction(LINKS, 'readonly').objectStore(LINKS).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push([String(c.key), c.value as FileHandle]);
        c.continue();
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
  for (const [id, h] of pairs) {
    if (typeof handle === 'string' ? h === handle : h && typeof h !== 'string' && (await handle.isSameEntry(h).catch(() => false))) return id;
  }
  return null;
}
