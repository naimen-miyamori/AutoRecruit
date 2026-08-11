import { pathToFileURL } from 'node:url';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import {
  inspectAllPlatformRuntimeStatuses,
  inspectPlatformRuntimeStatus,
  recoverPlatformRuntime,
  stopPlatformRuntime,
} from '../browser/platform-runtime.js';

type RuntimeCommand = 'status' | 'stop' | 'recover';

function parseArgs(argv: string[]): {
  command: RuntimeCommand;
  platform?: SupportedPlatform;
  confirmed: boolean;
  generation?: string;
} {
  const [commandValue, ...args] = argv;
  if (commandValue !== 'status' && commandValue !== 'stop' && commandValue !== 'recover') {
    throw new Error('Usage: runtime:browser -- status [--platform <platform>] | stop|recover --platform <platform> --generation <uuid> --confirmed true');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  return {
    command: commandValue,
    ...(values.has('platform') ? { platform: parsePlatformArg(values.get('platform')) } : {}),
    confirmed: values.get('confirmed') === 'true',
    generation: values.get('generation')?.trim() || undefined,
  };
}

export async function runBrowserRuntimeMaintenance(argv = process.argv.slice(2)): Promise<unknown> {
  const parsed = parseArgs(argv);
  if (parsed.command === 'status') {
    const result = parsed.platform
      ? await inspectPlatformRuntimeStatus(parsed.platform)
      : await inspectAllPlatformRuntimeStatuses();
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (!parsed.platform || !parsed.confirmed || !parsed.generation) {
    throw new Error(`${parsed.command} requires --platform, --generation, and --confirmed true.`);
  }
  const confirmation = { confirmed: true as const, observedGenerationId: parsed.generation };
  if (parsed.command === 'stop') await stopPlatformRuntime(parsed.platform, confirmation);
  else await recoverPlatformRuntime(parsed.platform, confirmation);
  const result = await inspectPlatformRuntimeStatus(parsed.platform);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entrypointUrl) {
  runBrowserRuntimeMaintenance().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
