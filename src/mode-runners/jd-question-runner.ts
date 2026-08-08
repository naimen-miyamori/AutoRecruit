import type { JobStore } from '../storage/job-store.js';
import type { JdRagSource } from '../rag/jd-question-answering.js';
import type { NormalizedJob } from '../types/job.js';
import type { SupportedPlatform } from '../platforms/types.js';
import type { JdQuestionCliInput } from './types.js';

export interface JdQuestionRunSummary {
  platform: SupportedPlatform;
  jobKey?: string;
  question: string;
  answer: string;
  sources: JdRagSource[];
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
}

interface JdQuestionAnswer {
  answer: string;
  sources: JdRagSource[];
  answered?: boolean;
  confidence?: number;
  noAnswerReason?: string;
}

export interface JdQuestionRunnerDependencies {
  createStore: () => JobStore;
  listPlatforms: (selection: JdQuestionCliInput['platform']) => SupportedPlatform[];
  buildJobKey: (keyword: string, suffix: string) => string;
  readTextFile: (filePath: string) => Promise<string>;
  answerStored: (input: { platform: SupportedPlatform; jobKey: string; question: string }) => Promise<JdQuestionAnswer>;
  answerTemporary: (input: { rawJdText: string; normalizedJob?: NormalizedJob; question: string }) => Promise<JdQuestionAnswer>;
  report: (result: JdQuestionRunSummary | JdQuestionRunSummary[] | undefined) => void;
}

async function resolveJdQuestionContext(
  platform: SupportedPlatform,
  input: JdQuestionCliInput,
  store: JobStore,
  dependencies: JdQuestionRunnerDependencies,
): Promise<{ jobKey?: string; rawText: string; normalizedJob?: NormalizedJob; stored: boolean }> {
  const keyword = input.keyword?.trim();
  const jobKey = keyword ? dependencies.buildJobKey(keyword, '') : undefined;
  const existingJobRecord = jobKey ? await store.readJobRecordIfExists(platform, jobKey) : undefined;

  if (existingJobRecord) {
    return {
      jobKey,
      rawText: existingJobRecord.rawText,
      normalizedJob: existingJobRecord.normalizedJob,
      stored: true,
    };
  }

  if (!input.jobDescriptionText && !input.jobDescriptionFilePath) {
    throw new Error(`Missing stored JD for ${platform}${jobKey ? ` job key ${jobKey}` : ''}; provide --jd or --jd-file`);
  }

  return {
    jobKey,
    rawText: input.jobDescriptionText ?? await dependencies.readTextFile(input.jobDescriptionFilePath!),
    stored: false,
  };
}

export async function runJdQuestionMode(
  input: JdQuestionCliInput,
  dependencies: JdQuestionRunnerDependencies,
): Promise<JdQuestionRunSummary | JdQuestionRunSummary[]> {
  const store = dependencies.createStore();
  const summaries: JdQuestionRunSummary[] = [];

  for (const platform of dependencies.listPlatforms(input.platform)) {
    const context = await resolveJdQuestionContext(platform, input, store, dependencies);
    const answer = context.stored && context.jobKey
      ? await dependencies.answerStored({ platform, jobKey: context.jobKey, question: input.question })
      : await dependencies.answerTemporary({
        rawJdText: context.rawText,
        normalizedJob: context.normalizedJob,
        question: input.question,
      });

    summaries.push({
      platform,
      jobKey: context.jobKey,
      question: input.question,
      answer: answer.answer,
      sources: answer.sources,
      answered: answer.answered,
      confidence: answer.confidence,
      noAnswerReason: answer.noAnswerReason,
    });
  }

  const result = input.platform === 'all' ? summaries : summaries[0];
  dependencies.report(result);
  return result;
}
