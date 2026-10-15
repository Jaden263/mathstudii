// Tests evaluate worksheets synchronously, as the worker does once the 3-D kernel has loaded.
import { initKernel } from './cad/solid';

await initKernel();
