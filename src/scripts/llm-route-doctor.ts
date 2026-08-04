import { config } from '../config.js';
import { completeJsonTextFromOpenAI, resolveOpenAISettings } from '../llm/openai-client.js';

interface Args {
  verify: boolean;
}

function parseArgs(argv: string[]): Args {
  if (argv.length === 0) return { verify: false };
  if (argv.length === 2 && argv[0] === '--verify' && (argv[1] === 'true' || argv[1] === 'false')) {
    return { verify: argv[1] === 'true' };
  }

  throw new Error('Usage: npm run llm:route:doctor [-- --verify true|false]');
}

function modelDescription(): string | undefined {
  if (config.llm.completionRoute === 'codex-session') {
    return config.llm.codexSessionModel;
  }

  try {
    return resolveOpenAISettings('LLM route doctor', 'OPENAI_MODEL').model;
  } catch {
    return undefined;
  }
}

async function verify(): Promise<void> {
  const text = await completeJsonTextFromOpenAI({
    featureName: 'LLM route doctor',
    modelEnvName: 'OPENAI_MODEL',
    instructions: 'Return only the requested JSON object. Do not use tools or external information.',
    input: 'Return {"status":"ready"}.',
    maxOutputTokens: 40,
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ready'] } },
    },
  });
  const parsed = JSON.parse(text) as { status?: unknown };
  if (parsed.status !== 'ready') {
    throw new Error('LLM route verification returned an unexpected response');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.verify) await verify();

  console.log(JSON.stringify({
    route: config.llm.completionRoute,
    model: modelDescription() ?? (config.llm.completionRoute === 'codex-session' ? 'account-default' : undefined),
    scoringRoute: config.scoring.completionRoute,
    scoringModel: config.scoring.model,
    codexSessionLifecycle: {
      handshakeTimeoutMsPerPhase: config.llm.codexSessionConnectTimeoutMs,
      activeTurnTimeout: 'none',
    },
    verified: args.verify,
    autoFallback: false,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
