import {
  aggregateJobResults,
  renderJobResultsMarkdown,
} from '../reporting/aggregate-results.js';
import {
  buildJobReportEmailSubject,
  buildNoNewCandidatesEmailBody,
  buildNoNewCandidatesEmailSubject,
  sendJobReportEmail,
} from '../reporting/mailer.js';
import { parsePlatformArg } from '../platforms/registry.js';
import type { SupportedPlatform } from '../platforms/types.js';
import { JobStore } from '../storage/job-store.js';
import { parseEmailList, resolveReportDelivery, type CandidateScoreArtifact, type ReportDeliveryOptions, type RunResult } from '../types/job.js';
import { buildMissingArtifactsMessage, filterArtifactsForRun, getLatestRunResult } from './run-artifact-selection.js';

export const sendJobReportEmailRef = { fn: sendJobReportEmail };

export interface SendJobReportSummary {
  jobKey: string;
  recipient: string;
  subject: string;
  summary: {
    candidateCount: number;
    successCount: number;
    failureCount: number;
  };
}

function assertCurrentRunArtifactsFound(filteredArtifacts: CandidateScoreArtifact[], latestRun: RunResult): void {
  if (filteredArtifacts.length > 0) {
    return;
  }

  throw new Error(buildMissingArtifactsMessage(latestRun));
}

export async function sendJobReport(
  platform: SupportedPlatform,
  jobKey: string,
  deliveryOverrides: ReportDeliveryOptions = {},
): Promise<SendJobReportSummary> {
  const store = new JobStore();
  const [jobRecord, runResults] = await Promise.all([
    store.readJobRecord(platform, jobKey),
    store.listRunResults(platform, jobKey),
  ]);
  const delivery = resolveReportDelivery({
    recipientEmail: jobRecord.recipientEmail,
    ccEmails: jobRecord.ccEmails,
  }, deliveryOverrides);
  const recipient = delivery.recipientEmail;
  const ccEmails = delivery.ccEmails;
  if (!recipient) {
    throw new Error(`No recipient email found for job key ${jobKey}`);
  }

  const latestRun = getLatestRunResult(runResults, jobKey);

  if (latestRun.newCandidateIds.length === 0) {
    const subject = buildNoNewCandidatesEmailSubject(jobRecord.normalizedJob.title || jobKey);
    const markdown = buildNoNewCandidatesEmailBody(
      jobRecord.normalizedJob.title || jobKey,
      jobRecord.platform,
      jobKey,
      latestRun.fetchedAt,
    );
    const result = await sendJobReportEmailRef.fn({ recipient, ccEmails, subject, markdown });

    return {
      jobKey,
      recipient: result.recipient,
      subject: result.subject,
      summary: {
        candidateCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    };
  }

  const scoreArtifacts = await store.listStoredScoreArtifacts(platform, jobKey);
  if (scoreArtifacts.length === 0) {
    throw new Error(`No score artifacts found for job key ${jobKey}`);
  }

  const currentRunArtifacts = filterArtifactsForRun(scoreArtifacts, latestRun);
  assertCurrentRunArtifactsFound(currentRunArtifacts, latestRun);

  const exportData = aggregateJobResults({
    jobRecord,
    scoreArtifacts: currentRunArtifacts,
  });
  const markdown = renderJobResultsMarkdown(exportData);
  const subject = buildJobReportEmailSubject(exportData.jobTitle, exportData.summary);
  const result = await sendJobReportEmailRef.fn({
    recipient,
    ccEmails,
    subject,
    markdown,
  });

  return {
    jobKey,
    recipient: result.recipient,
    subject: result.subject,
    summary: exportData.summary,
  };
}

async function main(): Promise<void> {
  const platform = parsePlatformArg(process.argv[2]);
  const jobKey = process.argv[3];
  const recipientEmail = process.argv[4];
  const ccEmails = parseEmailList(process.argv[5]);

  if (!jobKey) {
    throw new Error('Usage: tsx src/scripts/send-job-report-email.ts <platform> <jobKey> [recipientEmail] [ccEmail1,ccEmail2]');
  }

  const result = await sendJobReport(platform, jobKey, { recipientEmail, ccEmails });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
