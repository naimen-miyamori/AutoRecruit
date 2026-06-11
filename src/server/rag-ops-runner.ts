import { buildJobKey } from '../parsers/jd-parser.js';
import { doctorRagJob } from '../rag/doctor.js';
import { rebuildRagIndex } from '../rag/service.js';
import { writeRagMetrics } from '../scripts/rag-metrics.js';
import { writeRagOpsReport } from '../scripts/rag-ops-report.js';
import { writeRagReview } from '../scripts/rag-review.js';
import type { RagOpsTaskInput, RagOpsTaskOutput, TaskRecord } from './types.js';

function resolveJobKey(input: RagOpsTaskInput): string {
  if (input.jobKey) {
    return input.jobKey;
  }

  if (input.keyword) {
    return buildJobKey(input.keyword, '');
  }

  throw new Error('jobKey or keyword is required for this RAG operation');
}

function requirePlatformAndJob(input: RagOpsTaskInput): { platform: NonNullable<RagOpsTaskInput['platform']>; jobKey: string } {
  if (!input.platform) {
    throw new Error('platform is required for this RAG operation');
  }

  return {
    platform: input.platform,
    jobKey: resolveJobKey(input),
  };
}

function requireFile(input: RagOpsTaskInput): string {
  if (!input.file) {
    throw new Error('file is required for this RAG operation');
  }

  return input.file;
}

export async function runRagOpsTask(input: RagOpsTaskInput, _task: TaskRecord): Promise<RagOpsTaskOutput> {
  if (input.action === 'doctor') {
    const { platform, jobKey } = requirePlatformAndJob(input);
    const result = await doctorRagJob({
      platform,
      jobKey,
      question: input.question,
    });
    return {
      action: input.action,
      status: result.status,
      platform,
      jobKey,
      summary: {
        issueCount: result.issues.length,
        errorCount: result.issues.filter((issue) => issue.severity === 'error').length,
        warningCount: result.issues.filter((issue) => issue.severity === 'warning').length,
        recommendationCount: result.recommendations.length,
        issueCodes: result.issues.map((issue) => issue.code),
      },
    };
  }

  if (input.action === 'review') {
    const { platform, jobKey } = requirePlatformAndJob(input);
    const result = await writeRagReview({
      platform,
      jobKey,
      format: 'markdown',
      includeReviewed: input.includeReviewed,
      limit: input.limit,
      reviewer: input.reviewer,
    });
    return {
      action: input.action,
      status: result.report.itemCount > 0 ? 'needs_review' : 'ok',
      platform,
      jobKey,
      outputPath: result.outputPath,
      summary: {
        totalLogCount: result.report.totalLogCount,
        itemCount: result.report.itemCount,
        unreviewed: result.report.counts.unreviewed,
        noAnswer: result.report.counts.noAnswer,
        lowConfidence: result.report.counts.lowConfidence,
        missingSources: result.report.counts.missingSources,
        missingErrorType: result.report.counts.missingErrorType,
      },
    };
  }

  if (input.action === 'metrics') {
    const file = requireFile(input);
    const result = await writeRagMetrics({
      filePath: file,
      format: 'markdown',
      policyPath: input.policyFile,
    });
    return {
      action: input.action,
      status: result.report.failedJobCount > 0 || result.report.thresholdViolations.length > 0 ? 'warning' : 'ok',
      file,
      outputPath: result.outputPath,
      summary: {
        jobCount: result.report.jobCount,
        failedJobCount: result.report.failedJobCount,
        totalAnswers: result.report.overall.totalAnswers,
        reviewedCount: result.report.overall.reviewedCount,
        correctRate: result.report.overall.rates.correctRate,
        noAnswerRate: result.report.overall.rates.noAnswerRate,
        missingSourcesRate: result.report.overall.rates.missingSourcesRate,
        thresholdViolationCount: result.report.thresholdViolations.length,
      },
    };
  }

  if (input.action === 'ops') {
    const file = requireFile(input);
    const result = await writeRagOpsReport({
      filePath: file,
      format: 'markdown',
      question: input.question,
      includeReviewed: input.includeReviewed,
      limit: input.limit,
      reviewer: input.reviewer,
      policyPath: input.policyFile,
    });
    if (input.failOnIssue === true && result.report.status !== 'ok') {
      throw new Error(`RAG ops report status is ${result.report.status}`);
    }

    return {
      action: input.action,
      status: result.report.status,
      file,
      outputPath: result.outputPath,
      summary: {
        recommendationCount: result.report.recommendations.length,
        doctorStatus: result.report.doctor.status,
        reviewStatus: result.report.review.status,
        totalAnswers: result.report.metrics.overall.totalAnswers,
        reviewItems: result.report.review.totals.reviewItemCount,
        thresholdViolationCount: result.report.metrics.thresholdViolations.length,
      },
    };
  }

  if (input.action === 'rebuild') {
    const { platform, jobKey } = requirePlatformAndJob(input);
    const result = await rebuildRagIndex({
      platform,
      jobKey,
    });
    return {
      action: input.action,
      status: 'succeeded',
      platform,
      jobKey,
      summary: {
        sourceCount: result.sourceCount,
        chunkCount: result.chunkCount,
        indexedChunkCount: result.indexedChunkCount,
        embeddingProvider: result.embeddingProvider,
        embeddingModel: result.embeddingModel,
        vectorStore: result.vectorStore,
        manifestPath: result.manifestPath,
      },
    };
  }

  throw new Error(`Unsupported RAG operation: ${input.action satisfies never}`);
}
