// Tests evaluate worksheets synchronously, as the worker does once the 3-D kernels have loaded.
import { initKernel } from './cad/solid';
import { initOcc } from './cad/occ/kernel';

await Promise.all([initKernel(), initOcc()]);
