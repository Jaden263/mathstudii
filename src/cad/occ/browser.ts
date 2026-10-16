// The B-rep kernel's WASM file as a bundled asset (23 MB, fetched only when a CAD part
// needs it), for the evaluation worker and, later, the UI.
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { initOcc } from './kernel';

export const loadOcc = () => initOcc(wasmUrl);
