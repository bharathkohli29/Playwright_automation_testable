import { startSweep } from './startGate';

/** runs after the model setup (so Ollama is up): starts the sweep of left-behind branches in the background, with a visible line; never fails */
const GREEN = '[32m✔[0m'; const YELLOW = '[33m![0m';
try { const s = startSweep(); console.log(`${s.ok ? GREEN : YELLOW} left-behind branches: ${s.msg}`); } catch (e) { console.log(`${YELLOW} sweep skipped (${e instanceof Error ? e.message : String(e)})`); }
process.exit(0);
