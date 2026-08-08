import type { SupportedPlatform } from '../platforms/types.js';
import type { SendBossRoutedReportsSummary } from '../scripts/send-job-report-email.js';
import type { RunResult } from '../types/job.js';

export interface MainRunSummary {
  jobKey: string;
  bossJobId?: string;
  searchExecution?: RunResult['searchExecution'];
  totalCandidates: number;
  captureAttempts: number;
  capturedCandidates: number;
  newCandidates: number;
  scoredCandidates: number;
  failedCandidates: number;
  resultPath: string;
  exportPath?: string;
  exportError?: string;
  emailAttempted: boolean;
  emailDelivered: boolean;
  emailRecipient?: string;
  emailSubject?: string;
  emailError?: string;
  bossRouting?: RunResult['bossRouting'];
  postScoreRouting?: RunResult['postScoreRouting'];
  reportDeliveries?: SendBossRoutedReportsSummary['reportDeliveries'];
  rejectionEmails?: NonNullable<SendBossRoutedReportsSummary['rejectionEmails']>;
  bossSeenViewSync?: RunResult['bossSeenViewSync'];
  sampleCandidateIds: string[];
}

export interface AllPlatformsRunSummary {
  platform: SupportedPlatform;
  summary: MainRunSummary;
}

export interface BatchJobRunSummary {
  keyword: string;
  platform: SupportedPlatform;
  summary: MainRunSummary;
}

export function buildBossRoutedMainRunEmailSummary(
  reportDeliveries: SendBossRoutedReportsSummary['reportDeliveries'],
  bossRouting?: RunResult['bossRouting'],
): Pick<MainRunSummary, 'emailAttempted' | 'emailDelivered' | 'emailRecipient' | 'emailSubject' | 'emailError'> {
  const deliveries = [reportDeliveries.primary, reportDeliveries.secondary];
  const requiredDeliveries = deliveries.filter((delivery) => !delivery.skipReason);
  const representative = requiredDeliveries.length === 1
    ? requiredDeliveries[0]
    : requiredDeliveries.find((delivery) => delivery.audience === 'primary');
  const errors = requiredDeliveries.flatMap((delivery) => delivery.error
    ? [{ audience: delivery.audience, message: delivery.error }]
    : []);
  const emailError = errors.length === 1
    ? errors[0]!.message
    : errors.length > 1
      ? errors.map((error) => `${error.audience}: ${error.message}`).join('; ')
      : undefined;
  const rejectionEmailCounts = bossRouting?.rejectionEmailStatusCounts;
  const requiredRejectionEmailCount = rejectionEmailCounts
    ? Object.values(rejectionEmailCounts).reduce((total, count) => total + count, 0)
    : 0;
  const sentRejectionEmailCount = rejectionEmailCounts?.sent ?? 0;
  const rejectionEmailAttempted = bossRouting?.rejectionEmailSmtpAttemptCount === undefined
    ? Boolean(
      (rejectionEmailCounts?.sent ?? 0)
        + (rejectionEmailCounts?.sending ?? 0)
        + (rejectionEmailCounts?.uncertain ?? 0),
    )
    : bossRouting.rejectionEmailSmtpAttemptCount > 0;
  const rejectionEmailError = requiredRejectionEmailCount > sentRejectionEmailCount
    ? `rejection-email: ${requiredRejectionEmailCount - sentRejectionEmailCount} candidate email(s) are not confirmed sent`
    : undefined;
  const hasRequiredDelivery = requiredDeliveries.length > 0 || requiredRejectionEmailCount > 0;

  return {
    emailAttempted: deliveries.some((delivery) => delivery.attempted) || rejectionEmailAttempted,
    emailDelivered: hasRequiredDelivery
      && requiredDeliveries.every((delivery) => delivery.delivered)
      && requiredRejectionEmailCount === sentRejectionEmailCount,
    emailRecipient: representative?.recipient,
    emailSubject: representative?.subject,
    emailError: emailError ?? rejectionEmailError,
  };
}
