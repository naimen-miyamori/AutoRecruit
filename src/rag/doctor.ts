import type { SupportedPlatform } from '../platforms/types.js';
import { resolveRagEmbeddingModel, type RagEmbeddingProvider } from './embeddings.js';
import {
  inspectRagJob,
  type InspectRagJobOptions,
  type RagInspectDependencies,
  type RagInspectSummary,
} from './inspect.js';

export type RagDoctorSeverity = 'info' | 'warning' | 'error';

export interface RagDoctorIssue {
  code: string;
  severity: RagDoctorSeverity;
  message: string;
  recommendation?: string;
}

export interface RagDoctorSummary {
  platform: SupportedPlatform;
  jobKey: string;
  status: 'ok' | 'warning' | 'error';
  inspect: RagInspectSummary;
  issues: RagDoctorIssue[];
  recommendations: string[];
}

export interface DoctorRagJobOptions extends RagInspectDependencies {
  platform: SupportedPlatform;
  jobKey: string;
  question?: string;
  topK?: number;
  denseTopK?: number;
  keywordTopK?: number;
  embeddingModel?: string;
  embeddingProvider?: RagEmbeddingProvider;
  inspectJob?: (options: InspectRagJobOptions) => Promise<RagInspectSummary>;
  checkQdrant?: () => Promise<void>;
}

function hasEnvValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function getCurrentEmbeddingProviderName(): string {
  const rawProvider = process.env.RAG_EMBEDDING_PROVIDER?.trim()
    ?? process.env.EMBEDDING_PROVIDER?.trim()
    ?? 'local-http';
  return rawProvider;
}

function addIssue(issues: RagDoctorIssue[], issue: RagDoctorIssue): void {
  issues.push(issue);
}

function buildRecommendations(issues: RagDoctorIssue[]): string[] {
  return [...new Set(issues.map((issue) => issue.recommendation).filter((item): item is string => Boolean(item)))];
}

function summarizeStatus(issues: RagDoctorIssue[]): RagDoctorSummary['status'] {
  if (issues.some((issue) => issue.severity === 'error')) {
    return 'error';
  }

  if (issues.some((issue) => issue.severity === 'warning')) {
    return 'warning';
  }

  return 'ok';
}

function evaluateLocalState(inspect: RagInspectSummary, issues: RagDoctorIssue[]): void {
  if (!inspect.manifest) {
    addIssue(issues, {
      code: 'missing_manifest',
      severity: 'error',
      message: '缺少 rag/index-manifest.json，当前职位没有完整索引摘要。',
      recommendation: '运行 npm run rag:index -- --platform <platform> --keyword "<关键词>"，或运行 rag:rebuild 重建索引。',
    });
  }

  if (inspect.sourceCounts.total === 0) {
    addIssue(issues, {
      code: 'no_sources',
      severity: 'error',
      message: '没有本地 RAG source 记录。',
      recommendation: '先保存 JD 并运行 rag:index；历史对话可通过 rag:ingest-conversation 或 rag:ingest-conversations 导入。',
    });
  }

  if (inspect.chunkCounts.total === 0) {
    addIssue(issues, {
      code: 'no_chunks',
      severity: 'error',
      message: '没有本地 RAG chunk 记录。',
      recommendation: '运行 rag:index 或 rag:rebuild 生成 chunks 并写入向量索引。',
    });
  }

  if (inspect.activeJdSources.length === 0) {
    addIssue(issues, {
      code: 'no_active_jd',
      severity: 'warning',
      message: '没有 active JD source。仅靠历史对话可能无法完整回答岗位基础问题。',
      recommendation: '为该职位补充 JD，并运行 rag:index。',
    });
  }

  if (inspect.activeJdSources.length > 1) {
    addIssue(issues, {
      code: 'multiple_active_jd',
      severity: 'warning',
      message: `发现 ${inspect.activeJdSources.length} 个 active JD source，可能存在旧 JD 未失效。`,
      recommendation: '运行 rag:index 重新索引当前 JD，确保旧 JD source 标记为 inactive。',
    });
  }

  if (inspect.conversations.length > 0 && inspect.chunkCounts.verifiedConversation === 0) {
    addIssue(issues, {
      code: 'conversation_without_verified_facts',
      severity: 'warning',
      message: '已导入历史对话，但没有 verified=true 的招聘方事实 chunk。',
      recommendation: '确认招聘方答复已设置 role=recruiter 且 verified=true，然后重新导入对应 conversation。',
    });
  }

  if (inspect.chunkCounts.factChunks === 0) {
    addIssue(issues, {
      code: 'no_fact_chunks',
      severity: 'error',
      message: '没有可用于回答的 active 事实 chunk。',
      recommendation: '运行 rag:index 写入 JD 事实，或导入 verified=true 的招聘方历史答复。',
    });
  }
}

function evaluateManifestState(inspect: RagInspectSummary, issues: RagDoctorIssue[]): void {
  const manifest = inspect.manifest;
  if (!manifest) {
    return;
  }

  if (manifest.chunkCount !== inspect.chunkCounts.active) {
    addIssue(issues, {
      code: 'manifest_chunk_count_mismatch',
      severity: 'warning',
      message: `manifest chunkCount=${manifest.chunkCount}，但当前 active chunk 数=${inspect.chunkCounts.active}。`,
      recommendation: '运行 rag:rebuild 刷新向量索引和 manifest。',
    });
  }

  if (manifest.sourceCount !== inspect.sourceCounts.active) {
    addIssue(issues, {
      code: 'manifest_source_count_mismatch',
      severity: 'warning',
      message: `manifest sourceCount=${manifest.sourceCount}，但当前 active source 数=${inspect.sourceCounts.active}。`,
      recommendation: '运行 rag:rebuild 刷新向量索引和 manifest。',
    });
  }

  const currentEmbeddingModel = resolveRagEmbeddingModel();
  if (manifest.embeddingModel !== currentEmbeddingModel) {
    addIssue(issues, {
      code: 'embedding_model_mismatch',
      severity: 'warning',
      message: `manifest embeddingModel=${manifest.embeddingModel}，当前配置=${currentEmbeddingModel}。`,
      recommendation: '如果已切换 embedding 模型，运行 rag:rebuild 重建向量索引。',
    });
  }

  const currentProvider = getCurrentEmbeddingProviderName();
  if (manifest.embeddingProvider && manifest.embeddingProvider !== currentProvider) {
    addIssue(issues, {
      code: 'embedding_provider_mismatch',
      severity: 'warning',
      message: `manifest embeddingProvider=${manifest.embeddingProvider}，当前配置=${currentProvider}。`,
      recommendation: '如果已切换 embedding provider，运行 rag:rebuild 重建向量索引。',
    });
  }

  if (manifest.vectorStore === 'qdrant' && !hasEnvValue('QDRANT_URL')) {
    addIssue(issues, {
      code: 'missing_qdrant_url',
      severity: 'error',
      message: 'manifest 使用 Qdrant，但当前环境缺少 QDRANT_URL。',
      recommendation: '设置 QDRANT_URL，或在离线测试中使用内存向量库。',
    });
  }

  if (manifest.indexedChunkCount === 0 && inspect.chunkCounts.factChunks > 0) {
    addIssue(issues, {
      code: 'manifest_zero_indexed_chunks',
      severity: 'warning',
      message: 'manifest 显示 indexedChunkCount=0，但本地存在可回答事实 chunk。',
      recommendation: '运行 rag:rebuild 将本地事实 chunk 写回向量库。',
    });
  }
}

function resolveQdrantUrl(): string | undefined {
  return process.env.QDRANT_URL?.trim().replace(/\/+$/, '') || undefined;
}

async function checkQdrantAvailability(): Promise<void> {
  const url = resolveQdrantUrl();
  if (!url) {
    throw new Error('Missing QDRANT_URL');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${url}/collections`, {
      method: 'GET',
      headers: {
        ...(process.env.QDRANT_API_KEY?.trim() ? { 'api-key': process.env.QDRANT_API_KEY.trim() } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function evaluateQdrantState(
  inspect: RagInspectSummary,
  issues: RagDoctorIssue[],
  checkQdrant: () => Promise<void>,
): Promise<void> {
  if (inspect.manifest?.vectorStore !== 'qdrant') {
    return;
  }

  if (!resolveQdrantUrl()) {
    return;
  }

  try {
    await checkQdrant();
  } catch (error) {
    addIssue(issues, {
      code: 'qdrant_unreachable',
      severity: 'error',
      message: `Qdrant 不可连接：${error instanceof Error ? error.message : String(error)}`,
      recommendation: '确认 QDRANT_URL/QDRANT_API_KEY 配置和 Qdrant 服务状态，然后重试；必要时运行 rag:rebuild。',
    });
  }
}

function evaluateQuestionDiagnostics(inspect: RagInspectSummary, issues: RagDoctorIssue[]): void {
  const diagnostics = inspect.questionDiagnostics;
  if (!diagnostics) {
    return;
  }

  if (diagnostics.denseResults.length === 0 && inspect.manifest?.vectorStore === 'qdrant') {
    addIssue(issues, {
      code: 'dense_no_results',
      severity: 'warning',
      message: '问题诊断中 Qdrant dense 检索没有命中。',
      recommendation: '如果本地 hybrid/keyword 有命中但 dense 没命中，运行 rag:rebuild 检查 Qdrant 索引。',
    });
  }

  if (diagnostics.keywordResults.length === 0) {
    addIssue(issues, {
      code: 'keyword_no_results',
      severity: 'info',
      message: '问题诊断中关键词检索没有命中。',
      recommendation: '确认问题关键词是否出现在 JD 或 verified 历史答复中。',
    });
  }

  if (diagnostics.hybridResults.length === 0) {
    addIssue(issues, {
      code: 'hybrid_no_results',
      severity: 'warning',
      message: '问题诊断中 hybrid 最终结果为空。',
      recommendation: '检查该问题是否确实被 JD 或 verified 历史答复覆盖；如本地有事实 chunk，运行 rag:rebuild。',
    });
    return;
  }

  const topResult = diagnostics.hybridResults[0];
  if (topResult && topResult.sourceType !== 'jd' && !topResult.verified) {
    addIssue(issues, {
      code: 'top_result_unverified',
      severity: 'warning',
      message: 'hybrid 首位命中不是 JD，也不是 verified 历史答复。',
      recommendation: '检查元数据过滤是否生效，未确认内容不应参与候选人回答。',
    });
  }
}

export async function doctorRagJob(options: DoctorRagJobOptions): Promise<RagDoctorSummary> {
  const inspectJob = options.inspectJob ?? inspectRagJob;
  const inspect = await inspectJob({
    platform: options.platform,
    jobKey: options.jobKey,
    question: options.question,
    topK: options.topK,
    denseTopK: options.denseTopK,
    keywordTopK: options.keywordTopK,
    embeddingModel: options.embeddingModel,
    embeddingProvider: options.embeddingProvider,
    ragStore: options.ragStore,
    vectorStore: options.vectorStore,
  });
  const issues: RagDoctorIssue[] = [];

  evaluateLocalState(inspect, issues);
  evaluateManifestState(inspect, issues);
  await evaluateQdrantState(inspect, issues, options.checkQdrant ?? checkQdrantAvailability);
  evaluateQuestionDiagnostics(inspect, issues);

  return {
    platform: options.platform,
    jobKey: options.jobKey,
    status: summarizeStatus(issues),
    inspect,
    issues,
    recommendations: buildRecommendations(issues),
  };
}
