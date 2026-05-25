import type {
  CandidateScoreArtifact,
  JobRecord,
  JobResultsMarkdownCandidate,
  JobResultsMarkdownExport,
} from '../types/job.js';

interface AggregateJobResultsParams {
  jobRecord: JobRecord;
  scoreArtifacts: CandidateScoreArtifact[];
  generatedAt?: string;
}

interface RenderJobResultsMarkdownOptions {
  preferCandidateShareUrl?: boolean;
}

function selectNewestArtifactsByCandidateId(scoreArtifacts: CandidateScoreArtifact[]): CandidateScoreArtifact[] {
  const artifactsByCandidateId = new Map<string, CandidateScoreArtifact>();

  for (const artifact of scoreArtifacts) {
    const existingArtifact = artifactsByCandidateId.get(artifact.candidateId);

    if (!existingArtifact || artifact.scoredAt > existingArtifact.scoredAt) {
      artifactsByCandidateId.set(artifact.candidateId, artifact);
    }
  }

  return [...artifactsByCandidateId.values()];
}

function compareCandidates(left: JobResultsMarkdownCandidate, right: JobResultsMarkdownCandidate): number {
  if (left.status === 'success' && right.status === 'success') {
    return (right.totalScore ?? Number.NEGATIVE_INFINITY) - (left.totalScore ?? Number.NEGATIVE_INFINITY);
  }

  if (left.status === 'success') {
    return -1;
  }

  if (right.status === 'success') {
    return 1;
  }

  if (left.scoredAt !== right.scoredAt) {
    return left.scoredAt.localeCompare(right.scoredAt);
  }

  return left.candidateId.localeCompare(right.candidateId);
}

export function aggregateJobResults({
  jobRecord,
  scoreArtifacts,
  generatedAt = new Date().toISOString(),
}: AggregateJobResultsParams): JobResultsMarkdownExport {
  const candidates = selectNewestArtifactsByCandidateId(scoreArtifacts)
    .map<JobResultsMarkdownCandidate>((artifact) => {
      if (artifact.status === 'success') {
        return {
          candidateId: artifact.candidateId,
          ...(artifact.candidateShareUrl ? { candidateShareUrl: artifact.candidateShareUrl } : {}),
          status: artifact.status,
          model: artifact.model,
          scoredAt: artifact.scoredAt,
          totalScore: artifact.score.totalScore,
          dimensionScores: artifact.score.dimensionScores,
          summary: artifact.score.summary,
          risks: artifact.score.risks,
        };
      }

      return {
        candidateId: artifact.candidateId,
        ...(artifact.candidateShareUrl ? { candidateShareUrl: artifact.candidateShareUrl } : {}),
        status: artifact.status,
        model: artifact.model,
        scoredAt: artifact.scoredAt,
        error: artifact.error,
      };
    })
    .sort(compareCandidates);

  return {
    jobKey: jobRecord.jobKey,
    platform: jobRecord.platform,
    jobTitle: jobRecord.normalizedJob.title,
    searchKeyword: jobRecord.searchKeyword,
    generatedAt,
    summary: {
      candidateCount: candidates.length,
      successCount: candidates.filter((candidate) => candidate.status === 'success').length,
      failureCount: candidates.filter((candidate) => candidate.status === 'failed').length,
    },
    candidates,
  };
}

function renderCandidateDisplayId(
  candidate: JobResultsMarkdownCandidate,
  options: RenderJobResultsMarkdownOptions = {},
): string {
  return options.preferCandidateShareUrl && candidate.candidateShareUrl
    ? candidate.candidateShareUrl
    : candidate.candidateId;
}

function renderSuccessCandidateOverview(
  candidate: JobResultsMarkdownCandidate,
  rank: number,
  options: RenderJobResultsMarkdownOptions = {},
): string {
  if (candidate.totalScore === undefined) {
    throw new Error(`Missing total score for successful candidate ${candidate.candidateId}`);
  }

  const displayId = renderCandidateDisplayId(candidate, options);
  return [
    `- ${rank}. ${displayId} — ${candidate.totalScore}`,
    `  - 摘要: ${candidate.summary || '无'}`,
  ].join('\n');
}

function renderSuccessCandidate(
  candidate: JobResultsMarkdownCandidate,
  options: RenderJobResultsMarkdownOptions = {},
): string {
  const dimensions = candidate.dimensionScores;
  if (!dimensions || candidate.totalScore === undefined) {
    throw new Error(`Missing score details for successful candidate ${candidate.candidateId}`);
  }

  const risks = candidate.risks && candidate.risks.length > 0
    ? candidate.risks.map((risk) => `  - ${risk}`).join('\n')
    : '  - 无';
  const displayId = renderCandidateDisplayId(candidate, options);

  return [
    `### ${displayId} — ${candidate.totalScore}`,
    '',
    `- 评分时间: ${candidate.scoredAt}`,
    `- 摘要: ${candidate.summary || '无'}`,
    '- 维度评分:',
    `  - 教育背景: ${dimensions.education.score} — ${dimensions.education.reason}`,
    `  - 语言能力: ${dimensions.language.score} — ${dimensions.language.reason}`,
    `  - 工作经验: ${dimensions.experience.score} — ${dimensions.experience.reason}`,
    `  - 行业匹配: ${dimensions.industryMatch.score} — ${dimensions.industryMatch.reason}`,
    `  - 区域匹配: ${dimensions.regionMatch.score} — ${dimensions.regionMatch.reason}`,
    `  - 职责匹配: ${dimensions.responsibilityMatch.score} — ${dimensions.responsibilityMatch.reason}`,
    '- 风险提示:',
    risks,
  ].join('\n');
}

function renderFailedCandidate(
  candidate: JobResultsMarkdownCandidate,
  options: RenderJobResultsMarkdownOptions = {},
): string {
  const displayId = renderCandidateDisplayId(candidate, options);
  return [
    `### ${displayId}`,
    '',
    `- 模型: ${candidate.model}`,
    `- 评分时间: ${candidate.scoredAt}`,
    `- 失败原因: ${candidate.error ?? '未知评分失败'}`,
  ].join('\n');
}

export function renderJobResultsMarkdown(
  exportData: JobResultsMarkdownExport,
  options: RenderJobResultsMarkdownOptions = {},
): string {
  const successCandidates = exportData.candidates.filter((candidate) => candidate.status === 'success');
  const failedCandidates = exportData.candidates.filter((candidate) => candidate.status === 'failed');

  const sections: string[] = [
    `# ${exportData.jobTitle} 评分结果`,
    '',
    `- 平台来源: ${exportData.platform}`,
    `- 岗位标识: ${exportData.jobKey}`,
    `- 搜索关键词: ${exportData.searchKeyword}`,
    `- 生成时间: ${exportData.generatedAt}`,
    '',
    '## 汇总',
    '',
    `- 候选人数: ${exportData.summary.candidateCount}`,
    `- 评分成功: ${exportData.summary.successCount}`,
    `- 评分失败: ${exportData.summary.failureCount}`,
    '',
    '## 候选人速览',
    '',
  ];

  if (successCandidates.length === 0) {
    sections.push('暂无成功评分结果。');
  } else {
    sections.push(successCandidates.map((candidate, index) => renderSuccessCandidateOverview(candidate, index + 1, options)).join('\n'));
  }

  sections.push('', '## 排名结果', '');

  if (successCandidates.length === 0) {
    sections.push('暂无成功评分结果。');
  } else {
    sections.push(successCandidates.map((candidate) => renderSuccessCandidate(candidate, options)).join('\n\n'));
  }

  if (failedCandidates.length > 0) {
    sections.push('', '## 评分失败', '');
    sections.push(failedCandidates.map((candidate) => renderFailedCandidate(candidate, options)).join('\n\n'));
  }

  return `${sections.join('\n').trim()}\n`;
}
