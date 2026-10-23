// The data files a worksheet reads (READPRN("…") and the like) and the names it keeps them by;
// light enough for the page (the functions themselves are in engine/dataFiles.ts).

/** The key a file is kept under: its name without the folders, in lower case. */
export function dataFileKey(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).trim().toLowerCase();
}

/** Function names that read a file, with the file name as their first argument. */
export const DATA_FILE_FUNCTIONS = ['READPRN', 'READCSV', 'READFILE', 'READEXCEL'];

/** The data files a source reads: the file names given to these functions as string literals. */
export function dataFilesIn(source: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b(?:${DATA_FILE_FUNCTIONS.join('|')})\\s*\\(\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  for (const m of source.matchAll(re)) out.push(m[1].replace(/\\\\/g, '\\'));
  return out;
}

