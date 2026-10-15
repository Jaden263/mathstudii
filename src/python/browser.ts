// Loads Pyodide in the browser (inside the evaluation worker). The core files are
// served next to the app (dist/pyodide/), so Python itself works offline; packages
// such as numpy, scipy and sympy are fetched from the Pyodide CDN the first time
// worksheet code imports them.
import type { PyodideAPI } from 'pyodide';

// a variable keeps Vite from trying to bundle the folder as an asset
const DIR = '../pyodide/';

export async function loadPythonBrowser(): Promise<PyodideAPI> {
  const indexURL = new URL(DIR, import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ indexURL + 'pyodide.mjs')) as typeof import('pyodide');
  return mod.loadPyodide({
    indexURL,
    packageBaseUrl: `https://cdn.jsdelivr.net/pyodide/v${mod.version}/full/`,
  });
}
