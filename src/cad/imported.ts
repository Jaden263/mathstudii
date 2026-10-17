// Files imported into a design (STEP, STL, OBJ, 3MF) live in the document itself, so a
// worksheet opens anywhere with its imported parts: deflated and in base64, filed under
// a hash of their bytes (importing the same file twice stores it once, and an import
// feature names the file it builds from by that hash, so a replaced file rebuilds it).
import { deflateSync, inflateSync } from 'fflate';
import type { CadDesign, ImportedFile, ImportFormat } from './design';

export type { ImportedFile, ImportFormat };

/** Above this many bytes (before compression) the import warns that the worksheet file grows by about as much. */
export const LARGE_IMPORT = 5 * 2 ** 20;

/** The format of a file by its name, or null when it is none the CAD imports. */
export function importFormatOf(name: string): ImportFormat | null {
  const ext = /\.([^.]+)$/.exec(name.toLowerCase())?.[1];
  return ext === 'step' || ext === 'stp' ? 'step' : ext === 'stl' ? 'stl' : ext === 'obj' ? 'obj' : ext === '3mf' ? '3mf' : null;
}

/** A 53-bit hash of bytes (cyrb53, as keys.ts hashes strings), 14 hex digits. */
export function hashBytes(b: Uint8Array, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 2654435761);
    h2 = Math.imul(h2 ^ b[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function toBase64(b: Uint8Array): string {
  let s = '';
  // in chunks: String.fromCharCode takes only so many arguments
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A file as the document keeps it. */
export function packFile(name: string, format: ImportFormat, bytes: Uint8Array): ImportedFile {
  return { name, format, size: bytes.length, hash: `${format}:${hashBytes(bytes)}`, data: toBase64(deflateSync(bytes, { level: 9 })) };
}

const unpacked = new Map<string, Uint8Array>();

/** The bytes of a kept file (the last few are kept unpacked). */
export function fileBytes(f: ImportedFile): Uint8Array {
  let b = unpacked.get(f.hash);
  if (!b) {
    b = inflateSync(fromBase64(f.data));
    if (b.length !== f.size) throw new Error(`the imported file ${f.name} is damaged in the document`);
    unpacked.set(f.hash, b);
    if (unpacked.size > 4) unpacked.delete(unpacked.keys().next().value!);
  }
  return b;
}

/** The file an import feature builds from. */
export function importedFile(design: CadDesign, key: string): ImportedFile {
  const f = design.files?.[key];
  if (!f) throw new Error('the imported file is missing from the document');
  return f;
}

/** The design with a file added (under its hash) and the files no import feature uses any more left out. */
export function withFiles(design: CadDesign, add: ImportedFile[] = []): CadDesign {
  const files: Record<string, ImportedFile> = { ...design.files };
  for (const f of add) files[f.hash] = f;
  const used = new Set<string>();
  for (const c of design.components) for (const i of c.items) if (i.kind === 'import') used.add(i.file);
  for (const k of Object.keys(files)) if (!used.has(k)) delete files[k];
  const out: CadDesign = { ...design };
  if (Object.keys(files).length) out.files = files;
  else delete out.files;
  return out;
}

/** Bytes in a readable size: 340 kB, 5.2 MB. */
export const sizeWords = (n: number) => (n >= 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
