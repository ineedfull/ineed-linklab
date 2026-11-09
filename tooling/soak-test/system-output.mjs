import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Resource helpers share the controller process with the independent SDK.
export async function readSystemOutput(command, args = []) {
  const { stdout } = await run(command, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
