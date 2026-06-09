import { buildJobKey } from '../parsers/jd-parser.js';
import { parsePlatformArg } from '../platforms/registry.js';
import { answerQuestionWithRag } from '../rag/service.js';

interface Args {
  platform: ReturnType<typeof parsePlatformArg>;
  jobKey?: string;
  keyword?: string;
  question?: string;
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
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jobKey = args.jobKey ?? (args.keyword ? buildJobKey(args.keyword, '') : undefined);

  if (!jobKey || !args.question?.trim()) {
    throw new Error('Usage: npm run rag:ask -- --platform <platform> --keyword "<keyword>" --question "<question>"');
  }

  console.log(JSON.stringify({
    platform: args.platform,
    jobKey,
    question: args.question,
    ...await answerQuestionWithRag({
      platform: args.platform,
      jobKey,
      question: args.question,
    }),
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
