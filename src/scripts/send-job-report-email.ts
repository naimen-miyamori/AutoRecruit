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
import {
  parseEmailList,
  resolveReportDelivery,
  type BossCandidateRoutingArtifact,
  type CandidateScoreArtifact,
  type ReportDeliveryOptions,
  type RunResult,
} from '../types/job.js';
import {
  buildMissingArtifactsMessage,
  filterArtifactsForRun,
  getRunCandidateIds,
  getLatestRunResult,
} from './run-artifact-selection.js';

export const sendJobReportEmailRef = { fn: sendJobReportEmail };

export interface SendJobReportSummary {
  jobKey: string;
  recipient?: string;
  subject?: string;
  summary: {
    candidateCount: number;
    successCount: number;
    failureCount: number;
  };
  audience?: ReportAudience;
  attempted?: boolean;
  delivered?: boolean;
  skipReason?: string;
  error?: string;
}

export type ReportAudience = 'primary' | 'secondary';

export interface RoutedReportDeliverySummary extends SendJobReportSummary {
  audience: ReportAudience;
  attempted: boolean;
  delivered: boolean;
}

export interface SendBossRoutedReportsSummary {
  jobKey: string;
  reportDeliveries: {
    primary: RoutedReportDeliverySummary;
    secondary: RoutedReportDeliverySummary;
  };
}

export interface SendJobReportOptions {
  /**
   * Manual replay is deliberately one audience at a time. Omitting this
   * option preserves the legacy single-report behavior and defaults a
   * screening-enabled Boss job to primary only.
   */
  audience?: ReportAudience;
}

function assertCurrentRunArtifactsFound(filteredArtifacts: CandidateScoreArtifact[], latestRun: RunResult): void {
  const expectedCandidateIds = getRunCandidateIds(latestRun);
  if (expectedCandidateIds.length === 0) {
    return;
  }

  const actualCandidateIds = new Set(filteredArtifacts.map((artifact) => artifact.candidateId));
  const missingCandidateIds = expectedCandidateIds.filter((candidateId) => !actualCandidateIds.has(candidateId));
  if (missingCandidateIds.length === 0) {
    return;
  }

  throw new Error(`${buildMissingArtifactsMessage(latestRun)} Missing artifacts: ${missingCandidateIds.join(', ')}`);
}

function assertZhilianShareLinksAvailable(scoreArtifacts: CandidateScoreArtifact[]): void {
  const missingShareLink = scoreArtifacts.find((artifact) => !artifact.candidateShareUrl);
  if (!missingShareLink) {
    return;
  }

  throw new Error(`Missing Zhilian copied share link for candidate ${missingShareLink.candidateId}`);
}

function assertZhilianShareLinksUnique(scoreArtifacts: CandidateScoreArtifact[]): void {
  const candidateIdByShareLink = new Map<string, string>();

  for (const artifact of scoreArtifacts) {
    if (!artifact.candidateShareUrl) {
      continue;
    }

    const existingCandidateId = candidateIdByShareLink.get(artifact.candidateShareUrl);
    if (existingCandidateId) {
      throw new Error(`Duplicate Zhilian copied share link for candidates ${existingCandidateId} and ${artifact.candidateId}: ${artifact.candidateShareUrl}`);
    }

    candidateIdByShareLink.set(artifact.candidateShareUrl, artifact.candidateId);
  }
}

function emptySummary(): SendJobReportSummary['summary'] {
  return {
    candidateCount: 0,
    successCount: 0,
    failureCount: 0,
  };
}

function assertSameCandidateIds(
  actualIds: readonly string[],
  expectedIds: readonly string[],
  label: string,
): void {
  const actual = [...new Set(actualIds)].sort();
  const expected = [...new Set(expectedIds)].sort();
  if (actual.length !== actualIds.length || expected.length !== expectedIds.length
    || actual.length !== expected.length
    || actual.some((candidateId, index) => candidateId !== expected[index])) {
    throw new Error(`Boss routing ${label} does not match the current run; refusing to send a report`);
  }
}

interface BossRoutedReportInputs {
  latestRun: RunResult;
  primaryArtifacts: CandidateScoreArtifact[];
  secondaryArtifacts: CandidateScoreArtifact[];
  qualifiedArtifacts: CandidateScoreArtifact[];
  reviewArtifacts: CandidateScoreArtifact[];
  routingByCandidateId: Map<string, BossCandidateRoutingArtifact>;
}

async function loadBossRoutedReportInputs(
  store: JobStore,
  jobKey: string,
  latestRun: RunResult,
  scoreArtifacts: CandidateScoreArtifact[],
): Promise<BossRoutedReportInputs> {
  const routing = latestRun.bossRouting;
  if (!routing?.enabled) {
    throw new Error(`Boss routing facts are missing for the latest run of job key ${jobKey}; refusing to send a potentially unfiltered report`);
  }

  const qualifiedCandidateIds = routing.qualifiedCandidateIds;
  const reviewCandidateIds = routing.reviewCandidateIds;
  const rejectedCandidateIds = routing.rejectedCandidateIds;
  const primaryCandidateIds = [...qualifiedCandidateIds, ...reviewCandidateIds];
  const allAudienceIds = [...primaryCandidateIds, ...rejectedCandidateIds];
  assertSameCandidateIds(allAudienceIds, [...new Set(allAudienceIds)], 'candidate groups');
  const allAudienceIdSet = new Set(allAudienceIds);

  const routingArtifacts = (await store.listBossCandidateRoutingArtifacts('boss', jobKey))
    .filter((artifact) => artifact.policyHash === routing.policyHash && allAudienceIdSet.has(artifact.candidateId));
  const routingByCandidateId = new Map<string, BossCandidateRoutingArtifact>();
  for (const artifact of routingArtifacts) {
    if (routingByCandidateId.has(artifact.candidateId)) {
      throw new Error(`Multiple Boss routing facts exist for current candidate ${artifact.candidateId}; refusing to send a report`);
    }
    routingByCandidateId.set(artifact.candidateId, artifact);
  }
  assertSameCandidateIds([...routingByCandidateId.keys()], allAudienceIds, 'facts');

  const assertAudience = (
    candidateIds: readonly string[],
    audience: ReportAudience,
    classifications: readonly BossCandidateRoutingArtifact['classification'][],
  ) => {
    for (const candidateId of candidateIds) {
      const artifact = routingByCandidateId.get(candidateId);
      if (!artifact || artifact.audience !== audience || !classifications.includes(artifact.classification)) {
        throw new Error(`Boss routing fact for ${candidateId} is inconsistent with the ${audience} report; refusing to send a report`);
      }
    }
  };
  assertAudience(qualifiedCandidateIds, 'primary', ['qualified']);
  assertAudience(reviewCandidateIds, 'primary', ['review']);
  assertAudience(rejectedCandidateIds, 'secondary', ['rejected']);

  // A legacy Boss run's newCandidateIds also includes detail/parse failures
  // that never produced routing facts. Reports are defined by the immutable
  // routing index, so bind each score directly to its same-run routing fact
  // instead of requiring every attempted candidate to have a score.
  const routedScoreArtifacts = scoreArtifacts.filter((artifact) => allAudienceIdSet.has(artifact.candidateId));
  const artifactsByCandidateId = new Map(routedScoreArtifacts.map((artifact) => [artifact.candidateId, artifact]));
  assertSameCandidateIds([...artifactsByCandidateId.keys()], allAudienceIds, 'score artifacts');
  const artifactsFor = (candidateIds: readonly string[]) => candidateIds.map((candidateId) => {
    const artifact = artifactsByCandidateId.get(candidateId);
    if (!artifact) {
      throw new Error(`Missing current Boss score artifact for routed candidate ${candidateId}`);
    }
    const routingArtifact = routingByCandidateId.get(candidateId)!;
    if (!routingArtifact.scoredAt
      || artifact.scoredAt !== routingArtifact.scoredAt
      || artifact.status !== routingArtifact.scoreStatus) {
      throw new Error(`Boss routing score artifact for ${candidateId} is inconsistent with its current routing fact; refusing to send a report`);
    }
    return artifact;
  });

  return {
    latestRun,
    primaryArtifacts: artifactsFor(primaryCandidateIds),
    secondaryArtifacts: artifactsFor(rejectedCandidateIds),
    qualifiedArtifacts: artifactsFor(qualifiedCandidateIds),
    reviewArtifacts: artifactsFor(reviewCandidateIds),
    routingByCandidateId,
  };
}

function candidateSection(
  jobRecord: Awaited<ReturnType<JobStore['readJobRecord']>>,
  scoreArtifacts: CandidateScoreArtifact[],
): string {
  if (scoreArtifacts.length === 0) {
    return '本组没有候选人。';
  }
  const markdown = renderJobResultsMarkdown(aggregateJobResults({ jobRecord, scoreArtifacts }));
  const candidateSectionIndex = markdown.indexOf('## 候选人速览');
  return candidateSectionIndex >= 0 ? markdown.slice(candidateSectionIndex).trim() : markdown.trim();
}

function renderRoutingDetails(
  candidateIds: readonly string[],
  routingByCandidateId: Map<string, BossCandidateRoutingArtifact>,
  mode: 'review' | 'rejected',
): string {
  if (candidateIds.length === 0) {
    return '本组没有候选人。';
  }

  return candidateIds.map((candidateId) => {
    const artifact = routingByCandidateId.get(candidateId)!;
    const requirementIds = mode === 'review' ? artifact.unknownRequirementIds : artifact.matchedRequirementIds;
    const evidence = mode === 'rejected'
      ? artifact.requirementEvaluations
        .filter((evaluation) => evaluation.outcome === 'missing')
        .flatMap((evaluation) => evaluation.evidence)
      : [];
    return [
      `- ${candidateId}: ${artifact.reason}`,
      ...(requirementIds.length > 0 ? [`  - ${mode === 'review' ? '未确定要求' : '缺失要求'}: ${requirementIds.join('、')}`] : []),
      ...(evidence.length > 0 ? [`  - 证据: ${[...new Set(evidence)].join('；')}`] : []),
    ].join('\n');
  }).join('\n');
}

function buildBossRoutedReportMarkdown(
  audience: ReportAudience,
  jobRecord: Awaited<ReturnType<JobStore['readJobRecord']>>,
  inputs: BossRoutedReportInputs,
): string {
  const routing = inputs.latestRun.bossRouting!;
  if (audience === 'primary') {
    return [
      `# ${jobRecord.normalizedJob.title} 评分后分流报告（主受众）`,
      '',
      `- 平台来源: ${jobRecord.platform}`,
      `- 岗位标识: ${jobRecord.jobKey}`,
      `- 策略版本: ${routing.policyHash}`,
      `- 明确符合: ${routing.qualifiedCandidateIds.length}`,
      `- 需复核: ${routing.reviewCandidateIds.length}`,
      '',
      '## 明确符合',
      '',
      candidateSection(jobRecord, inputs.qualifiedArtifacts),
      '',
      '## 需复核',
      '',
      '以下候选人因证据不足、条件无法确定或评分失败而需要人工复核；他们不代表明确符合。',
      '',
      renderRoutingDetails(routing.reviewCandidateIds, inputs.routingByCandidateId, 'review'),
      '',
      candidateSection(jobRecord, inputs.reviewArtifacts),
      '',
    ].join('\n');
  }

  return [
    `# ${jobRecord.normalizedJob.title} 评分后分流报告（副受众）`,
    '',
    `- 平台来源: ${jobRecord.platform}`,
    `- 岗位标识: ${jobRecord.jobKey}`,
    `- 策略版本: ${routing.policyHash}`,
    `- 明确命中否定条件: ${routing.rejectedCandidateIds.length}`,
    '',
    '## 明确否定候选人',
    '',
    renderRoutingDetails(routing.rejectedCandidateIds, inputs.routingByCandidateId, 'rejected'),
    '',
    candidateSection(jobRecord, inputs.secondaryArtifacts),
    '',
  ].join('\n');
}

function buildBossRoutedReportSubject(
  jobTitle: string,
  summary: SendJobReportSummary['summary'],
  audience: ReportAudience,
): string {
  return `${buildJobReportEmailSubject(jobTitle, summary)}（${audience === 'primary' ? '主受众' : '副受众'}）`;
}

async function sendBossRoutedAudienceReport(input: {
  audience: ReportAudience;
  jobRecord: Awaited<ReturnType<JobStore['readJobRecord']>>;
  inputs: BossRoutedReportInputs;
  deliveryOverrides?: ReportDeliveryOptions;
}): Promise<RoutedReportDeliverySummary> {
  const { audience, jobRecord, inputs, deliveryOverrides = {} } = input;
  const artifacts = audience === 'primary' ? inputs.primaryArtifacts : inputs.secondaryArtifacts;
  const emptyReason = audience === 'primary' ? 'no-primary-audience-candidates' : 'no-rejected-candidates';
  if (artifacts.length === 0) {
    return {
      jobKey: jobRecord.jobKey,
      audience,
      attempted: false,
      delivered: false,
      skipReason: emptyReason,
      summary: emptySummary(),
    };
  }

  // Newer runs may carry an immutable report-delivery snapshot alongside the
  // routing index. Keep the structural fallback here so old run files remain
  // readable; once present, a later job-record edit cannot retarget replay.
  const routingFacts = inputs.latestRun.bossRouting as (NonNullable<RunResult['bossRouting']> & {
    reportDelivery?: Partial<Record<ReportAudience, ReportDeliveryOptions>>;
    delivery?: Partial<Record<ReportAudience, ReportDeliveryOptions>>;
  });
  const immutableDelivery = routingFacts.reportDelivery?.[audience] ?? routingFacts.delivery?.[audience];
  const storedDelivery = immutableDelivery ?? (audience === 'primary'
    ? { recipientEmail: jobRecord.recipientEmail, ccEmails: jobRecord.ccEmails }
    : jobRecord.bossScreening?.secondaryDelivery ?? {});
  const delivery = resolveReportDelivery(storedDelivery, deliveryOverrides);
  const exportData = aggregateJobResults({ jobRecord, scoreArtifacts: artifacts });
  const subject = buildBossRoutedReportSubject(exportData.jobTitle, exportData.summary, audience);
  if (!delivery.recipientEmail) {
    return {
      jobKey: jobRecord.jobKey,
      audience,
      attempted: false,
      delivered: false,
      subject,
      summary: exportData.summary,
      error: `No ${audience} report recipient email found for screening-enabled Boss job ${jobRecord.jobKey}`,
    };
  }

  try {
    const result = await sendJobReportEmailRef.fn({
      recipient: delivery.recipientEmail,
      ccEmails: delivery.ccEmails,
      subject,
      markdown: buildBossRoutedReportMarkdown(audience, jobRecord, inputs),
    });
    return {
      jobKey: jobRecord.jobKey,
      audience,
      attempted: true,
      delivered: true,
      recipient: result.recipient,
      subject: result.subject,
      summary: exportData.summary,
    };
  } catch (error) {
    return {
      jobKey: jobRecord.jobKey,
      audience,
      attempted: true,
      delivered: false,
      recipient: delivery.recipientEmail,
      subject,
      summary: exportData.summary,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Sends exactly one audience for an explicit, safe manual replay. */
export async function sendBossRoutedReportAudience(
  jobKey: string,
  audience: ReportAudience,
  deliveryOverrides: ReportDeliveryOptions = {},
): Promise<RoutedReportDeliverySummary> {
  const store = new JobStore();
  const [jobRecord, runResults, scoreArtifacts] = await Promise.all([
    store.readJobRecord('boss', jobKey),
    store.listRunResults('boss', jobKey),
    store.listStoredScoreArtifacts('boss', jobKey),
  ]);
  const latestRun = getLatestRunResult(runResults, jobKey);
  if (!latestRun.bossRouting?.enabled) {
    throw new Error(`The latest Boss run for job key ${jobKey} does not contain enabled screening facts`);
  }
  const inputs = await loadBossRoutedReportInputs(store, jobKey, latestRun, scoreArtifacts);
  return sendBossRoutedAudienceReport({ audience, jobRecord, inputs, deliveryOverrides });
}

/**
 * Sends the two mutually exclusive reports independently. A primary failure
 * never prevents an eligible secondary report, and vice versa.
 */
export async function sendBossRoutedReports(
  jobKey: string,
  primaryDeliveryOverrides: ReportDeliveryOptions = {},
  secondaryDeliveryOverrides: ReportDeliveryOptions = {},
): Promise<SendBossRoutedReportsSummary> {
  const store = new JobStore();
  const [jobRecord, runResults, scoreArtifacts] = await Promise.all([
    store.readJobRecord('boss', jobKey),
    store.listRunResults('boss', jobKey),
    store.listStoredScoreArtifacts('boss', jobKey),
  ]);
  const latestRun = getLatestRunResult(runResults, jobKey);
  if (!latestRun.bossRouting?.enabled) {
    throw new Error(`The latest Boss run for job key ${jobKey} does not contain enabled screening facts`);
  }
  const inputs = await loadBossRoutedReportInputs(store, jobKey, latestRun, scoreArtifacts);
  const [primary, secondary] = await Promise.all([
    sendBossRoutedAudienceReport({
      audience: 'primary',
      jobRecord,
      inputs,
      deliveryOverrides: primaryDeliveryOverrides,
    }),
    sendBossRoutedAudienceReport({
      audience: 'secondary',
      jobRecord,
      inputs,
      deliveryOverrides: secondaryDeliveryOverrides,
    }),
  ]);
  return { jobKey, reportDeliveries: { primary, secondary } };
}

export async function sendJobReport(
  platform: SupportedPlatform,
  jobKey: string,
  deliveryOverrides: ReportDeliveryOptions = {},
  options: SendJobReportOptions = {},
): Promise<SendJobReportSummary> {
  const store = new JobStore();
  const [jobRecord, runResults] = await Promise.all([
    store.readJobRecord(platform, jobKey),
    store.listRunResults(platform, jobKey),
  ]);

  // Resolve the latest run before reading the current job screening switch.
  // Manual replay must follow the immutable routing facts produced by that
  // run; changing the job setting after execution cannot reclassify or expose
  // rejected candidates to the primary report.
  const latestRun = getLatestRunResult(runResults, jobKey);

  if (platform === 'boss' && latestRun.bossRouting?.enabled) {
    const audience = options.audience ?? 'primary';
    return sendBossRoutedReportAudience(jobKey, audience, deliveryOverrides);
  }

  const delivery = resolveReportDelivery({
    recipientEmail: jobRecord.recipientEmail,
    ccEmails: jobRecord.ccEmails,
  }, deliveryOverrides);
  const recipient = delivery.recipientEmail;
  const ccEmails = delivery.ccEmails;
  if (!recipient) {
    throw new Error(`No recipient email found for job key ${jobKey}`);
  }

  // Read artifacts before deciding that a legacy run is empty. v1
  // `newCandidateIds` is only attempt history, but a matching score artifact
  // is still a valid report candidate even when old runs omitted
  // `scoredCandidates`.
  const scoreArtifacts = await store.listStoredScoreArtifacts(platform, jobKey);
  const currentRunArtifacts = filterArtifactsForRun(scoreArtifacts, latestRun);

  if (currentRunArtifacts.length === 0 && getRunCandidateIds(latestRun).length === 0) {
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

  if (scoreArtifacts.length === 0) {
    throw new Error(`No score artifacts found for job key ${jobKey}`);
  }

  assertCurrentRunArtifactsFound(currentRunArtifacts, latestRun);
  if (platform === 'zhilian') {
    assertZhilianShareLinksAvailable(currentRunArtifacts);
    assertZhilianShareLinksUnique(currentRunArtifacts);
  }

  const exportData = aggregateJobResults({
    jobRecord,
    scoreArtifacts: currentRunArtifacts,
  });
  const markdown = renderJobResultsMarkdown(exportData, {
    preferCandidateShareUrl: platform === 'zhilian',
  });
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
  const audienceValue = process.argv[6];
  if (audienceValue !== undefined && audienceValue !== 'primary' && audienceValue !== 'secondary') {
    throw new Error('audience must be primary or secondary when provided');
  }

  if (!jobKey) {
    throw new Error('Usage: tsx src/scripts/send-job-report-email.ts <platform> <jobKey> [recipientEmail] [ccEmail1,ccEmail2] [primary|secondary]');
  }

  const result = await sendJobReport(platform, jobKey, { recipientEmail, ccEmails }, {
    ...(audienceValue ? { audience: audienceValue } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
