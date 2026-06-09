import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import { doctorRagJob } from '../rag/doctor.js';

interface Args {
  platform: ReturnType<typeof parsePlatformArg>;
  jobKey?: string;
  keyword?: string;
  question?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  failOnIssue: boolean;
}

function parseOptionalPositiveInteger(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, flagName: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${flagName} must be true or false`);
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    values.set(arg.slice(2), value);
    index += 1;
  }

  return {
    platform: parsePlatformArg(values.get('platform')),
    jobKey: values.get('job-key'),
    keyword: values.get('keyword'),
    question: values.get('question'),
    topK: parseOptionalPositiveInteger(values.get('top-k'), '--top-k'),
    denseTopK: parseOptionalPositiveInteger(values.get('dense-top-k'), '--dense-top-k'),
    keywordTopK: parseOptionalPositiveInteger(values.get('keyword-top-k'), '--keyword-top-k'),
    failOnIssue: parseBoolean(values.get('fail-on-issue'), '--fail-on-issue', false),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jobKey = args.jobKey ?? (args.keyword ? buildJobKey(args.keyword, '') : undefined);

  if (!jobKey) {
    throw new Error('Usage: npm run rag:doctor -- --platform <platform> --keyword "<keyword>" [--question "<question>"]');
  }

  const summary = await doctorRagJob({
    platform: args.platform,
    jobKey,
    question: args.question,
    topK: args.topK,
    denseTopK: args.denseTopK,
    keywordTopK: args.keywordTopK,
  });
  console.log(JSON.stringify(summary, null, 2));

  if (args.failOnIssue && summary.status !== 'ok') {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
