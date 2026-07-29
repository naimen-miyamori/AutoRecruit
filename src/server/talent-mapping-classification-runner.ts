import {
  completeJsonTextFromOpenAI,
  resolveOpenAISettings,
  type OpenAITextCompletionRequest,
} from '../llm/openai-client.js';
import {
  buildMappingClassificationPromptCandidates,
  createMappingClassificationSuggestion,
  validateMappingClassificationResponse,
} from '../talent-mapping/classification.js';
import { TalentMappingStore } from '../talent-mapping/store.js';
import type { TalentMappingClassificationRunSummary } from '../types/talent-mapping.js';
import type { TalentMappingClassificationTaskInput } from './types.js';

export type TalentMappingClassificationCompletion = (request: OpenAITextCompletionRequest) => Promise<string>;

export interface TalentMappingClassificationRunnerOptions {
  dataDir?: string;
  store?: TalentMappingStore;
  completeJsonText?: TalentMappingClassificationCompletion;
  model?: string;
  now?: () => Date;
}

function compact(value: string | undefined): string | undefined {
  return value?.trim().slice(0, 240) || undefined;
}

export async function runTalentMappingClassificationTask(
  input: TalentMappingClassificationTaskInput,
  options: TalentMappingClassificationRunnerOptions = {},
): Promise<TalentMappingClassificationRunSummary> {
  const store = options.store ?? new TalentMappingStore({ dataDir: options.dataDir });
  const project = await store.readProject(input.mappingKey);
  if (!project) throw new Error(`Talent Mapping project not found: ${input.mappingKey}`);
  const [observations, candidates] = await Promise.all([
    store.readCandidateObservations(input.mappingKey),
    store.readCandidateView(input.mappingKey),
  ]);
  const promptCandidates = buildMappingClassificationPromptCandidates({
    candidates,
    observations,
    limit: input.limit ?? 25,
  });
  const configuredModel = options.model
    ?? process.env.TALENT_MAPPING_MODEL?.trim()
    ?? process.env.OPENAI_MODEL?.trim();
  if (promptCandidates.length === 0) {
    return {
      mode: 'talent-mapping-classification',
      mappingKey: input.mappingKey,
      model: configuredModel || 'not-called',
      consideredCandidates: 0,
      generatedSuggestions: 0,
      skippedCandidates: 0,
      suggestionIds: [],
    };
  }

  const model = configuredModel
    ?? resolveOpenAISettings('Talent Mapping classification', 'TALENT_MAPPING_MODEL').model;
  const taxonomy = {
    companies: project.taxonomy.targetCompanies.map((company) => ({
      companyKey: company.companyKey,
      displayName: company.displayName,
      aliases: company.aliases,
    })),
    roles: project.taxonomy.roleFamilies.map((role) => ({
      roleKey: role.roleKey,
      displayName: role.displayName,
      aliases: role.titleAliases,
    })),
    levels: project.taxonomy.levels,
    locations: project.objective.locations,
  };
  const modelInput = {
    taxonomy,
    candidates: promptCandidates.map((candidate) => ({
      ref: candidate.ref,
      currentCompany: compact(candidate.promptItem.currentCompany),
      currentTitle: compact(candidate.promptItem.currentTitle),
      location: compact(candidate.promptItem.location),
    })),
  };
  const complete = options.completeJsonText ?? completeJsonTextFromOpenAI;
  const rawText = await complete({
    featureName: 'Talent Mapping classification',
    modelEnvName: 'TALENT_MAPPING_MODEL',
    instructions: [
      '你只生成待人工复核的分类建议，不得把建议描述为事实。',
      '只能使用输入 taxonomy 中存在的 companyKey、roleKey、level、location；没有明确证据的字段省略。',
      '候选输入已经去除姓名、平台 ID、卡片全文和简历，不得推测身份、联系方式、组织关系或跨平台同一人关系。',
      '输出严格 JSON：{"suggestions":[{"ref":"item-1","companyKey":"可选","roleKey":"可选","level":"可选","location":"可选","rationale":"简短理由","evidenceFields":["currentCompany"|"currentTitle"|"location"]}]}。',
    ].join('\n'),
    input: JSON.stringify(modelInput),
    maxOutputTokens: 4000,
    ...(options.model ? { settings: { model: options.model } } : {}),
  });
  const validated = validateMappingClassificationResponse({
    rawText,
    plan: project,
    candidates: promptCandidates,
  });
  const promptByRef = new Map(promptCandidates.map((candidate) => [candidate.ref, candidate]));
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const suggestionIds: string[] = [];
  let generatedSuggestions = 0;
  for (const modelSuggestion of validated) {
    const promptCandidate = promptByRef.get(modelSuggestion.ref)!;
    const suggestion = createMappingClassificationSuggestion({
      mappingKey: input.mappingKey,
      promptCandidate,
      modelSuggestion,
      model,
      createdAt,
    });
    suggestionIds.push(suggestion.suggestionId);
    if (await store.appendClassificationSuggestion(suggestion)) {
      generatedSuggestions += 1;
    }
  }

  return {
    mode: 'talent-mapping-classification',
    mappingKey: input.mappingKey,
    model,
    consideredCandidates: promptCandidates.length,
    generatedSuggestions,
    skippedCandidates: promptCandidates.length - validated.length,
    suggestionIds,
  };
}
