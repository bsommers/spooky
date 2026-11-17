// "Is this build output older than the sources it was built from?" Shared by the global setups that build for the tests.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The newest modification time (ms) of any file under `paths` (files or directories), skipping `node_modules`, `dist` and dotfiles. 0 when none exist. */
export function newestMtime(paths: readonly string[]): number {
  let newest = 0;
  const visit = (p: string): void => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        visit(join(p, e.name));
      }
    } else if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const p of paths) visit(p);
  return newest;
}

/** True when `output` is missing, or any file under `inputs` is newer than it. */
export function isStale(output: string, inputs: readonly string[]): boolean {
  if (!existsSync(output)) return true;
  return newestMtime(inputs) > statSync(output).mtimeMs;
}
