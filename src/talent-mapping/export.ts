import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MappingDerivedViews,
  MappingEntityLink,
  MappingRunRecord,
  TalentMappingPlan,
} from '../types/talent-mapping.js';
import { countConfirmedMappingEntities } from './entity-links.js';

export interface TalentMappingExportResult {
  exportDir: string;
  candidatesCsvPath: string;
  companyRoleMatrixCsvPath: string;
  coverageCsvPath: string;
  changesCsvPath: string;
  changesMarkdownPath: string;
  summaryPath: string;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  const rawText = typeof value === 'number' ? String(value) : String(value);
  // Spreadsheet applications treat these prefixes as formulas even in ordinary
  // candidate fields. Keep exported values textual without changing local facts.
  const text = /^[=+\-@]/.test(rawText) ? `'${rawText}` : rawText;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function percentage(value: number | undefined): string {
  return value === undefined ? 'unknown' : `${(value * 100).toFixed(1)}%`;
}

function buildSummaryMarkdown(input: {
  plan: TalentMappingPlan;
  run: MappingRunRecord;
  views: MappingDerivedViews;
  entityLinks: readonly MappingEntityLink[];
  generatedAt: string;
}): string {
  const { plan, run, views } = input;
  const platformProfiles = views.candidates.length;
  const humanEntities = countConfirmedMappingEntities(platformProfiles, input.entityLinks);
  const enriched = views.candidates.filter((candidate) => candidate.detailStatus === 'enriched').length;
  const capped = views.coverage.filter((row) => row.coverageStatus === 'capped').length;
  const failed = views.coverage.filter((row) => row.coverageStatus === 'failed').length;
  const title = plan.enrichment.mode === 'card-only'
    ? `${plan.name}（市场扫描 / Mapping 初筛）`
    : `${plan.name}（Talent Mapping）`;
  const rows = views.coverage.map((row) => [
    row.sliceId,
    row.platform,
    row.reportedResultTotal ?? 'unknown',
    row.scannedBatches,
    row.observedCards,
    row.uniquePlatformProfiles,
    row.enrichedProfiles,
    percentage(row.detailCoverage),
    row.coverageStatus,
    row.terminationReason,
  ]);
  const changeSummary = views.changes.status === 'ready'
    ? [
      `- 变化对比：${views.changes.baseRunId} -> ${views.changes.compareRunId}`,
      `- 新观察档案：${views.changes.newProfiles.length}`,
      `- 明确字段变化档案：${views.changes.changedProfiles.length}`,
      `- 本轮未再次观察档案：${views.changes.notObservedProfiles.length}`,
    ]
    : [
      `- 变化对比状态：${views.changes.status}`,
      `- 变化对比说明：${views.changes.comparisonReasons.join('；') || '至少需要两次成功 scan/all 运行'}`,
    ];

  return [
    `# ${title}`,
    '',
    `- Mapping Key：${plan.mappingKey}`,
    `- 运行 ID：${run.runId}`,
    `- 阶段：${run.stage}`,
    `- 运行状态：${run.status}`,
    `- 生成时间：${input.generatedAt}`,
    `- 平台唯一档案数：${platformProfiles}`,
    `- 人工关联后实体数：${humanEntities}`,
    `- 已补全详情：${enriched}`,
    `- 受限切片：${capped}`,
    `- 失败切片：${failed}`,
    ...changeSummary,
    '',
    '## 覆盖情况',
    '',
    '| 切片 | 平台 | 页面结果数 | 批次 | 卡片观察 | 平台唯一档案 | 详情补全 | 详情覆盖 | 覆盖状态 | 终止原因 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    '## 口径与安全说明',
    '',
    '- 候选身份按 `platform:candidateId` 隔离；跨平台相似姓名、公司或职位不会自动合并。',
    '- “平台唯一档案数”与“人工关联后实体数”是不同口径。只有 `entity-links.json` 中的人工确认关系影响后者。',
    '- 本轮未再次出现的历史档案只表示 `not-observed-this-run`，不能解释为离职、跳槽或不再求职。',
    '- 详情打开可能产生平台“已查看”副作用；本模块不会评分、转发、联系候选人、发送邮件或写入 RAG。',
    ...(plan.enrichment.mode === 'card-only'
      ? ['- 本报告仅为卡片级市场扫描 / Mapping 初筛，不代表完整人才 Mapping。']
      : []),
    '',
  ].join('\n');
}

export async function exportTalentMapping(input: {
  plan: TalentMappingPlan;
  run: MappingRunRecord;
  views: MappingDerivedViews;
  exportDir: string;
  entityLinks?: readonly MappingEntityLink[];
  generatedAt?: string;
}): Promise<TalentMappingExportResult> {
  const exportDir = path.resolve(input.exportDir);
  await fs.mkdir(exportDir, { recursive: true });
  const candidatesCsvPath = path.join(exportDir, 'candidates.csv');
  const companyRoleMatrixCsvPath = path.join(exportDir, 'company-role-matrix.csv');
  const coverageCsvPath = path.join(exportDir, 'coverage.csv');
  const changesCsvPath = path.join(exportDir, 'changes.csv');
  const changesMarkdownPath = path.join(exportDir, 'changes.md');
  const summaryPath = path.join(exportDir, 'summary.md');

  const candidatesCsv = toCsv([
    'platform',
    'candidate_id',
    'platform_candidate_key',
    'name',
    'current_company',
    'current_title',
    'company_key',
    'role_key',
    'level',
    'location',
    'first_observed_at',
    'last_observed_at',
    'detail_status',
    'entity_id',
    'manual_classification_fields',
    'manual_classification_reviewer',
    'source_slices',
  ], input.views.candidates.map((candidate) => [
    candidate.platform,
    candidate.candidateId,
    candidate.platformCandidateKey,
    candidate.name,
    candidate.currentCompany,
    candidate.currentTitle,
    candidate.companyKey,
    candidate.roleKey,
    candidate.level,
    candidate.location,
    candidate.firstObservedAt,
    candidate.lastObservedAt,
    candidate.detailStatus,
    candidate.entityId,
    candidate.manualClassification?.fields.join('|'),
    candidate.manualClassification?.reviewedBy,
    candidate.sourceSliceIds.join('|'),
  ]));

  const companyRoleMatrixCsv = toCsv([
    'company_key',
    'company_display_name',
    'company_tier',
    'role_key',
    'role_display_name',
    'level',
    'location',
    'platform',
    'platform_profiles',
    'enriched_profiles',
    'unclassified_profiles',
  ], input.views.companies.map((row) => [
    row.companyKey,
    row.companyDisplayName,
    row.companyTier,
    row.roleKey,
    row.roleDisplayName,
    row.level,
    row.location,
    row.platform,
    row.platformProfiles,
    row.enrichedProfiles,
    row.unclassifiedProfiles,
  ]));

  const coverageCsv = toCsv([
    'slice_id',
    'platform',
    'reported_result_total',
    'reported_result_total_source',
    'scanned_batches',
    'observed_cards',
    'unique_platform_profiles',
    'eligible_for_detail',
    'enriched_profiles',
    'card_coverage',
    'detail_coverage',
    'coverage_status',
    'run_status',
    'termination_reason',
  ], input.views.coverage.map((row) => [
    row.sliceId,
    row.platform,
    row.reportedResultTotal,
    row.reportedResultTotalSource,
    row.scannedBatches,
    row.observedCards,
    row.uniquePlatformProfiles,
    row.eligibleForDetail,
    row.enrichedProfiles,
    row.cardCoverage,
    row.detailCoverage,
    row.coverageStatus,
    row.status,
    row.terminationReason,
  ]));

  const summary = buildSummaryMarkdown({
    plan: input.plan,
    run: input.run,
    views: input.views,
    entityLinks: input.entityLinks ?? [],
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });
  const changeRows = [
    ...input.views.changes.newProfiles.map((candidate) => [
      'new-profile', candidate.platformCandidateKey, '', '', '', candidate.observedAt,
    ]),
    ...input.views.changes.notObservedProfiles.map((candidate) => [
      'not-observed-this-run', candidate.platformCandidateKey, '', '', '', candidate.observedAt,
    ]),
    ...input.views.changes.changedProfiles.flatMap((candidate) => candidate.fields.map((field) => [
      'field-change',
      candidate.platformCandidateKey,
      field.field,
      field.previousValue,
      field.currentValue,
      '',
    ])),
  ];
  const changesCsv = toCsv([
    'change_type',
    'platform_candidate_key',
    'field',
    'previous_value',
    'current_value',
    'observed_at',
  ], changeRows);
  const changesMarkdown = [
    '# Talent Mapping 历次变化报告',
    '',
    `- Mapping Key：${input.plan.mappingKey}`,
    `- 状态：${input.views.changes.status}`,
    `- 基准运行：${input.views.changes.baseRunId ?? '-'}`,
    `- 对比运行：${input.views.changes.compareRunId ?? '-'}`,
    `- 基准合同：${input.views.changes.baseScanContractHash ?? '-'}`,
    `- 对比合同：${input.views.changes.compareScanContractHash ?? '-'}`,
    `- 口径说明：${input.views.changes.comparisonReasons.join('；') || '-'}`,
    `- 新观察档案：${input.views.changes.newProfiles.length}`,
    `- 明确字段变化档案：${input.views.changes.changedProfiles.length}`,
    `- 本轮未再次观察档案：${input.views.changes.notObservedProfiles.length}`,
    `- 未变化档案：${input.views.changes.unchangedProfiles}`,
    '',
    `> ${input.views.changes.caveat}`,
    '',
    '## 明确字段变化',
    '',
    ...(input.views.changes.changedProfiles.length === 0
      ? ['无。']
      : input.views.changes.changedProfiles.flatMap((candidate) => [
        `### ${candidate.platformCandidateKey}`,
        '',
        ...candidate.fields.map((field) => `- ${field.field}：${field.previousValue ?? '空'} -> ${field.currentValue ?? '空'}`),
        '',
      ])),
    '## 新观察档案',
    '',
    ...(input.views.changes.newProfiles.length === 0
      ? ['无。']
      : input.views.changes.newProfiles.map((candidate) => `- ${candidate.platformCandidateKey}`)),
    '',
    '## 本轮未再次观察档案',
    '',
    ...(input.views.changes.notObservedProfiles.length === 0
      ? ['无。']
      : input.views.changes.notObservedProfiles.map((candidate) => `- ${candidate.platformCandidateKey}`)),
    '',
  ].join('\n');

  await Promise.all([
    fs.writeFile(candidatesCsvPath, candidatesCsv, 'utf8'),
    fs.writeFile(companyRoleMatrixCsvPath, companyRoleMatrixCsv, 'utf8'),
    fs.writeFile(coverageCsvPath, coverageCsv, 'utf8'),
    fs.writeFile(changesCsvPath, changesCsv, 'utf8'),
    fs.writeFile(changesMarkdownPath, `${changesMarkdown.trimEnd()}\n`, 'utf8'),
    fs.writeFile(summaryPath, `${summary.trimEnd()}\n`, 'utf8'),
  ]);

  return {
    exportDir,
    candidatesCsvPath,
    companyRoleMatrixCsvPath,
    coverageCsvPath,
    changesCsvPath,
    changesMarkdownPath,
    summaryPath,
  };
}
