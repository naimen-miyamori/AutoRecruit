import { pathToFileURL } from 'node:url';
import {
  applyBossSearchConditionSetWorkflow,
  BossSearchConditionSetApplyError,
  type BossRecentViewedPolicy,
} from '../platforms/boss/search-condition-set-apply.js';
import type { SearchConditionSetReference } from '../search/search-condition-sets.js';

export interface ApplyBossSearchConditionSetCliInput {
  reference: SearchConditionSetReference;
  keyword?: string;
  recentViewedPolicy: BossRecentViewedPolicy;
}

function parseReference(value: string | undefined): SearchConditionSetReference {
  const matched = value?.trim().match(/^(scs-[a-z0-9](?:[a-z0-9-]{2,126}))@(\d+)$/);
  if (!matched || matched[1]!.includes('--') || Number(matched[2]) < 1) {
    throw new Error('--condition-set must be a fixed Boss condition-set reference such as scs-abc@1.');
  }
  return {
    conditionSetId: matched[1]!,
    platform: 'boss',
    revision: Number(matched[2]),
  };
}

function parseRecentViewedPolicy(value: string | undefined): BossRecentViewedPolicy {
  if (value === undefined || value === 'exclude') return 'exclude';
  if (value === 'include' || value === 'condition-set') return value;
  throw new Error('--recent-viewed-policy must be exclude, include, or condition-set.');
}

export function parseArgs(argv: readonly string[]): ApplyBossSearchConditionSetCliInput {
  const values = new Map<string, string>();
  const allowed = new Set(['condition-set', 'keyword', 'recent-viewed-policy']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (!allowed.has(key)) {
      throw new Error(`Unsupported Boss apply-only argument: --${key}`);
    }
    if (values.has(key)) {
      throw new Error(`Argument --${key} may be provided only once.`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for argument --${key}`);
    }
    values.set(key, value);
    index += 1;
  }

  const keyword = values.get('keyword')?.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (values.has('keyword') && !keyword) {
    throw new Error('--keyword must be non-empty when provided.');
  }
  return {
    reference: parseReference(values.get('condition-set')),
    keyword: keyword || undefined,
    recentViewedPolicy: parseRecentViewedPolicy(values.get('recent-viewed-policy')),
  };
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof BossSearchConditionSetApplyError) {
    return {
      status: 'failed',
      platform: 'boss',
      phase: error.phase,
      message: error.message,
      recoveredBaseline: error.recoveredBaseline,
      partialStatePossible: error.partialStatePossible,
    };
  }
  return {
    status: 'failed',
    platform: 'boss',
    phase: 'cli',
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const input = parseArgs(argv);
  const controller = new AbortController();
  const abort = (signal: NodeJS.Signals) => {
    controller.abort(new Error(`Boss search condition-set application cancelled by ${signal}.`));
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const summary = await applyBossSearchConditionSetWorkflow({
      ...input,
      signal: controller.signal,
    });
    // The normal path writes a single final record. Progress is deliberately
    // kept out of stdout so a caller can reliably wait for process exit.
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(errorPayload(error))}\n`);
    process.exitCode = 1;
  });
}
