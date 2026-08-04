import { createHash } from 'node:crypto';
import type {
  BossCandidateRoutingArtifact,
  BossModelRequirement,
  CandidateResume,
} from '../types/job.js';

export interface BossRejectionEmailPayload {
  subject: string;
  markdown: string;
  contentHash: string;
}

function formatOptionalRange(start?: string, end?: string): string | undefined {
  return start && end ? `${start}-${end}` : start ?? end;
}

/**
 * Renders the complete structured Boss resume without the compact report
 * limits. This is deliberately plain text so the rejection message remains
 * useful even when an SMTP client does not render Markdown.
 */
export function formatBossCandidateResume(resume: CandidateResume): string {
  const lines: string[] = [
    `候选人ID：${resume.candidateId}`,
    resume.name ? `姓名：${resume.name}` : '',
    resume.age !== undefined ? `年龄：${resume.age}` : '',
    resume.nativePlace ? `籍贯：${resume.nativePlace}` : '',
    resume.education ? `学历：${resume.education}` : '',
    resume.regions.length > 0 ? `地区：${resume.regions.join('、')}` : '',
    resume.resumeUrl ? `简历链接：${resume.resumeUrl}` : '',
    resume.candidateShareUrl ? `候选人链接：${resume.candidateShareUrl}` : '',
  ].filter(Boolean);

  if (resume.pr.length > 0) {
    lines.push('', '个人优势', ...resume.pr);
  }

  if (resume.workExperiences.length > 0) {
    lines.push('', '工作经历');
    for (const work of resume.workExperiences) {
      lines.push([
        formatOptionalRange(work.start, work.end),
        work.company,
        work.title,
        work.industry,
        work.duration,
      ].filter(Boolean).join(' | '));
      lines.push(...work.details);
    }
  }

  if (resume.projectExperiences.length > 0) {
    lines.push('', '项目经历');
    for (const project of resume.projectExperiences) {
      lines.push([
        formatOptionalRange(project.start, project.end),
        project.company,
        project.name,
        project.duration,
      ].filter(Boolean).join(' | '));
      lines.push(...project.details);
    }
  }

  if (resume.educationExperiences.length > 0) {
    lines.push('', '教育经历');
    for (const education of resume.educationExperiences) {
      lines.push([
        formatOptionalRange(education.start, education.end),
        education.school,
        education.degree,
        education.major,
      ].filter(Boolean).join(' | '));
      lines.push(...education.details);
    }
  }

  if (resume.skill.length > 0) {
    lines.push('', '语言/技能');
    for (const skill of resume.skill) {
      lines.push(...Object.entries(skill).map(([key, value]) => `${key}：${value}`));
    }
  }

  if (resume.certificates.length > 0) {
    lines.push('', '证书');
    lines.push(...resume.certificates);
  }

  return `${lines.filter((line, index, values) => line || values[index - 1]).join('\n')}\n`;
}

function formatMissingRequirements(
  artifact: BossCandidateRoutingArtifact,
  requirements: readonly BossModelRequirement[] = [],
): string {
  const missing = artifact.requirementEvaluations.filter((evaluation) => evaluation.outcome === 'missing');
  if (missing.length === 0) {
    return '未找到结构化的 missing 评估，拒绝邮件不允许外发。';
  }

  const requirementsById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  return missing.map((evaluation, index) => {
    const requirement = requirementsById.get(evaluation.requirementId);
    return [
    `${index + 1}. 要求：${requirement?.label ?? evaluation.requirementId}`,
    requirement?.requirement ? `要求说明：${requirement.requirement}` : '',
    requirement?.criteria.length ? `判定标准：${requirement.criteria.join('；')}` : '',
    `原因：${evaluation.reason}`,
    evaluation.missingCriteria.length > 0
      ? `缺失条件：${evaluation.missingCriteria.join('；')}`
      : '',
    evaluation.evidence.length > 0
      ? `已核验但不足的简历信息：${evaluation.evidence.join('；')}`
      : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

export function buildBossRejectionEmailSubject(jobTitle: string, resume: CandidateResume): string {
  return `【BOSS】【明确否定】${jobTitle} - ${resume.name ?? resume.candidateId}`;
}

export function buildBossRejectionEmailPayload(input: {
  jobKey: string;
  jobTitle: string;
  decidedAt: string;
  artifact: BossCandidateRoutingArtifact;
  resume: CandidateResume;
  requirements?: readonly BossModelRequirement[];
}): BossRejectionEmailPayload {
  if (input.artifact.candidateId !== input.resume.candidateId) {
    throw new Error(`Boss rejection email resume identity ${input.resume.candidateId} does not match routing candidate ${input.artifact.candidateId}`);
  }
  if (input.artifact.classification !== 'rejected' || input.artifact.audience !== 'secondary') {
    throw new Error(`Boss rejection email requires a rejected/secondary routing fact for ${input.artifact.candidateId}`);
  }

  const missing = input.artifact.requirementEvaluations.filter((evaluation) => evaluation.outcome === 'missing');
  if (missing.length === 0) {
    throw new Error(`Boss rejection email requires at least one missing requirement for ${input.artifact.candidateId}`);
  }

  const subject = buildBossRejectionEmailSubject(input.jobTitle, input.resume);
  const markdown = [
    `# ${subject}`,
    '',
    `- 平台来源：BOSS`,
    `- jobKey：${input.jobKey}`,
    `- 候选人ID：${input.resume.candidateId}`,
    `- 路由决定ID：${input.artifact.routingDecisionId ?? '未提供'}`,
    `- 决定时间：${input.decidedAt}`,
    '',
    '## 否定结论',
    '',
    input.artifact.reason,
    '',
    '## 明确缺失的模型要求',
    '',
    formatMissingRequirements(input.artifact, input.requirements),
    '',
    '## 完整简历',
    '',
    formatBossCandidateResume(input.resume),
  ].join('\n');

  return {
    subject,
    markdown,
    contentHash: createHash('sha256').update(markdown).digest('hex'),
  };
}

export function buildBossRejectionEmailMessageId(deliveryId: string): string {
  return `<autorecruit-boss-rejection-${deliveryId}@autorecruit.local>`;
}
