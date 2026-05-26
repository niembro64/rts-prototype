import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { initSimWasm } from '../src/game/sim-wasm/init';
import { runHeadlessReplayFixture } from '../src/game/replay/HeadlessReplayRunner';
import { HEADLESS_REPLAY_FIXTURES } from './headlessReplayFixtures';

type CliOptions = {
  outPath: string | undefined;
};

function parseArgs(argv: string[]): CliOptions {
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--out requires a path');
      outPath = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { outPath };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const wasmPath = resolve(process.cwd(), 'src/game/sim-wasm/pkg/rts_sim_wasm_bg.wasm');
  const wasmBytes = await readFile(wasmPath);
  await initSimWasm(wasmBytes);

  const results = HEADLESS_REPLAY_FIXTURES.map(runHeadlessReplayFixture);
  for (const result of results) {
    const final = result.hashes[result.hashes.length - 1];
    console.log(`${result.name}: ${final.tick} ${final.hash}`);
  }

  if (options.outPath !== undefined) {
    const resolved = resolve(process.cwd(), options.outPath);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, JSON.stringify(results, null, 2) + '\n');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
