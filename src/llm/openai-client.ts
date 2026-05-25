import OpenAI from 'openai';

export interface OpenAISettings {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export interface OpenAITextCompletionRequest {
  featureName: string;
  modelEnvName: string;
  input: string;
  instructions: string;
  maxOutputTokens: number;
}

let openAIClient: OpenAI | undefined;

export function resolveOpenAISettings(featureName: string, modelOverrideEnv: string): OpenAISettings {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing required environment variable: OPENAI_API_KEY');
  }

  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  const overrideModel = process.env[modelOverrideEnv]?.trim();
  const defaultModel = process.env.OPENAI_MODEL?.trim();
  const model = overrideModel || defaultModel;

  if (!model) {
    throw new Error(`Missing required environment variable: OPENAI_MODEL (for ${featureName})`);
  }

  return {
    apiKey,
    baseUrl: baseUrl || undefined,
    model,
  };
}

export function getOpenAIClient(): OpenAI {
  if (openAIClient) {
    return openAIClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing required environment variable: OPENAI_API_KEY');
  }

  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  openAIClient = new OpenAI({
    apiKey,
    baseURL: baseUrl || undefined,
  });
  return openAIClient;
}

function stringifyOpenAIError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function completeJsonTextFromOpenAI(request: OpenAITextCompletionRequest): Promise<string> {
  const settings = resolveOpenAISettings(request.featureName, request.modelEnvName);

  try {
    const response = await getOpenAIClient().responses.create({
      model: settings.model,
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: request.maxOutputTokens,
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error('OpenAI returned empty text output');
    }

    return outputText;
  } catch (error) {
    throw new Error(`${request.featureName} request failed: ${stringifyOpenAIError(error)}`);
  }
}
