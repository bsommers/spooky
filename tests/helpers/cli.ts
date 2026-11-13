// In-process CLI runner: captures stdout / stderr / exit code and feeds stdin from a string.
import { Readable } from 'node:stream';
import { main } from '../../src/cli/main.js';
import type { CliDeps } from '../../src/cli/main.js';

export interface CliRun {
  code: number;
  out: string;
  err: string;
}

export async function runCli(
  argv: string[],
  opts: { stdin?: string | Buffer; tty?: boolean; env?: Record<string, string | undefined> } = {},
  deps: CliDeps = {},
): Promise<CliRun> {
  let out = '';
  let err = '';
  const code = await main(
    argv,
    {
      stdout: (t) => void (out += t),
      stderr: (t) => void (err += t),
      stdin: Readable.from(opts.stdin === undefined ? [] : [opts.stdin]),
      stdinIsTTY: opts.tty === true,
      env: opts.env ?? {},
    },
    deps,
  );
  return { code, out, err };
}
