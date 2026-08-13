// Entry point. Its only job is to kick off startup after the whole module
// graph has finished evaluating, so no module body observes a half-initialized
// binding from one of the import cycles.
import { startReader } from './startup.js';

startReader();
