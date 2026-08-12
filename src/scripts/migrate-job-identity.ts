import fs from 'node:fs/promises';

import {
  JobIdentityMigrationService,
  type JobIdentityMigrationTarget,
} from '../storage/job-identity-migration.js';

interface CliOptions {
  phase: 'preview' | 'prepare' | 'commit';
  mappingPath?: string;
  manifestId?: string;
  confirmationHash?: string;
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function parseOptions(argv: readonly string[]): CliOptions {
  const phase = readOption(argv, '--phase');
  if (phase !== 'preview' && phase !== 'prepare' && phase !== 'commit') {
    throw new Error('--phase must be preview, prepare, or commit.');
  }
  const allowed = new Set(['--phase', '--mapping', '--manifest-id', '--confirm-plan-hash']);
  for (let index = 0; index < argv.length; index += 2) {
    if (!allowed.has(argv[index]!)) throw new Error(`Unknown option ${argv[index]}.`);
  }
  const mappingPath = readOption(argv, '--mapping');
  const manifestId = readOption(argv, '--manifest-id');
  const confirmationHash = readOption(argv, '--confirm-plan-hash');
  return {
    phase,
    ...(mappingPath ? { mappingPath } : {}),
    ...(manifestId ? { manifestId } : {}),
    ...(confirmationHash ? { confirmationHash } : {}),
  };
}

async function loadTargets(mappingPath: string | undefined): Promise<JobIdentityMigrationTarget[]> {
  if (!mappingPath) throw new Error('--mapping is required for preview and prepare.');
  const raw = JSON.parse(await fs.readFile(mappingPath, 'utf8')) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Identity mapping must be a non-empty JSON array.');
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Identity mapping item ${index} must be an object.`);
    }
    const value = item as Record<string, unknown>;
    const allowedKeys = new Set(['platform', 'jobKey', 'expectedJobName', 'nameAuthority', 'nativePositionId']);
    const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) throw new Error(`Identity mapping item ${index} contains unknown fields: ${unknownKeys.join(', ')}.`);
    if (value.platform !== '51job' && value.platform !== 'liepin'
      && value.platform !== 'zhilian' && value.platform !== 'boss') {
      throw new Error(`Identity mapping item ${index} platform is invalid.`);
    }
    if (typeof value.jobKey !== 'string' || typeof value.expectedJobName !== 'string'
      || (value.nameAuthority !== 'user-confirmed' && value.nameAuthority !== 'platform-sync')) {
      throw new Error(`Identity mapping item ${index} has invalid required fields.`);
    }
    return {
      platform: value.platform,
      jobKey: value.jobKey,
      expectedJobName: value.expectedJobName,
      nameAuthority: value.nameAuthority,
      ...(typeof value.nativePositionId === 'string' ? { nativePositionId: value.nativePositionId } : {}),
    };
  });
}

export async function runJobIdentityMigrationCli(
  argv: readonly string[],
  service = new JobIdentityMigrationService(),
): Promise<unknown> {
  const options = parseOptions(argv);
  if (options.phase === 'preview') {
    return service.preview(await loadTargets(options.mappingPath));
  }
  if (options.phase === 'prepare') {
    if (!options.confirmationHash) throw new Error('prepare requires --confirm-plan-hash from the current preview.');
    return service.prepare(await loadTargets(options.mappingPath), options.confirmationHash);
  }
  if (!options.manifestId || !options.confirmationHash) {
    throw new Error('commit requires --manifest-id and --confirm-plan-hash.');
  }
  if (options.mappingPath) throw new Error('commit consumes only the prepared manifest; do not pass --mapping.');
  return service.commit(options.manifestId, options.confirmationHash);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runJobIdentityMigrationCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
