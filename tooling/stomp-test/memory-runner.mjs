// Diagnostic-only Cargo runner; never used by development or release packages.
import assert from 'node:assert/strict';
import path from 'node:path';
import { prepareTauriExecutable } from '../../scripts/tauri-app-runner.mjs';

assert.equal(process.platform, 'darwin');
const library = process.env.LINKLAB_MEMORY_PROBE_LIBRARY;
assert(library && path.isAbsolute(library) && library.endsWith('.dylib'), 'Absolute diagnostic library required');
assert(process.env.LINKLAB_MEMORY_PROBE_DIR, 'Isolated probe directory required');
const config = JSON.parse(process.env.TAURI_CONFIG || '{}');
assert(config.identifier?.startsWith('com.ineedfull.linklab.stompduel'), 'Only isolated diagnostic hosts may load the probe');
const [binary, ...args] = process.argv.slice(2);
assert(binary, 'Cargo executable required');
const executable = await prepareTauriExecutable(binary);
// Carry a normal variable through Cargo/system launchers, then inject only at
// the final native exec. macOS removes DYLD_* across protected system programs.
process.execve(executable, [executable, ...args], { ...process.env, DYLD_INSERT_LIBRARIES: library });
