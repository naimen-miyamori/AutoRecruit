import { isCliSearchModeId, type CliSearchModeId } from '../operation-modes.js';
import { main } from '../index.js';

export function readRequiredModeId(argv: readonly string[]): CliSearchModeId {
  const modeIdIndexes = argv
    .map((argument, index) => argument === '--mode-id' ? index : -1)
    .filter((index) => index >= 0);
  if (modeIdIndexes.length !== 1) {
    throw new Error('search:run requires exactly one --mode-id');
  }

  const modeIdValue = argv[modeIdIndexes[0] + 1];
  if (!modeIdValue || modeIdValue.startsWith('--') || !isCliSearchModeId(modeIdValue)) {
    throw new Error('operation-mode-unknown: --mode-id must identify a supported search operation');
  }
  return modeIdValue;
}

type SearchOperationMain = (argv: readonly string[]) => Promise<unknown>;

export async function runSearchOperation(
  argv: readonly string[],
  execute: SearchOperationMain = main,
): Promise<unknown> {
  readRequiredModeId(argv);
  return execute(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSearchOperation(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
