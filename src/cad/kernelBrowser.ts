// The kernel's WASM file as a bundled asset, for the worker and the UI.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initKernel } from './solid';

export const loadKernel = () => initKernel(wasmUrl);
