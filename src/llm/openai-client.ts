import OpenAI from 'openai';

export interface OpenAISettings {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export interface OpenAISettingsOverride {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface OpenAITextCompletionRequest {
  featureName: string;
  modelEnvName: string;
  input: string;
  instructions: string;
  maxOutputTokens: number;
  settings?: OpenAISettingsOverride;
}

let openAIClient: OpenAI | undefined;

export function resolveOpenAISettings(
  featureName: string,
  modelOverrideEnv: string,
  overrides: OpenAISettingsOverride = {},
): OpenAISettings {
  const apiKey = overrides.apiKey?.trim() || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing required environment variable: OPENAI_API_KEY');
  }

  const baseUrl = overrides.baseUrl?.trim() || process.env.OPENAI_BASE_URL?.trim();
  const requestModel = overrides.model?.trim();
  const overrideModel = process.env[modelOverrideEnv]?.trim();
  const defaultModel = process.env.OPENAI_MODEL?.trim();
  const model = requestModel || overrideModel || defaultModel;

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

function getOpenAIErrorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }

  return undefined;
}

function shouldFallbackToChatCompletions(error: unknown): boolean {
  return getOpenAIErrorStatus(error) === 403 || /\b403\b/.test(stringifyOpenAIError(error));
}

function extractChatCompletionText(response: unknown): string {
  const choices = (response as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  }).choices ?? [];
  const content = choices[0]?.message?.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }

      return '';
    }).join('').trim();
  }

  return '';
}

async function completeJsonTextFromResponsesApi(
  client: OpenAI,
  settings: OpenAISettings,
  request: OpenAITextCompletionRequest,
): Promise<string> {
  const response = await client.responses.create({
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
}

function getOpenAIBaseUrl(settings: OpenAISettings): string {
  return (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
}

function parseOpenAIErrorBody(rawBody: string): string | undefined {
  try {
    const payload = JSON.parse(rawBody) as {
      error?: {
        message?: unknown;
      } | string;
      message?: unknown;
    };

    if (typeof payload.error === 'string') {
      return payload.error;
    }

    if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
      return payload.error.message;
    }

    if (typeof payload.message === 'string') {
      return payload.message;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function completeJsonTextFromChatCompletions(
  settings: OpenAISettings,
  request: OpenAITextCompletionRequest,
): Promise<string> {
  const response = await fetch(`${getOpenAIBaseUrl(settings)}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: request.instructions },
        { role: 'user', content: request.input },
      ],
      max_tokens: request.maxOutputTokens,
    }),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${parseOpenAIErrorBody(rawBody) ?? response.statusText}`);
  }

  const payload = JSON.parse(rawBody) as unknown;
  const outputText = extractChatCompletionText(payload);
  if (!outputText) {
    throw new Error('OpenAI returned empty chat completion text output');
  }

  return outputText;
}

export async function completeJsonTextFromOpenAI(request: OpenAITextCompletionRequest): Promise<string> {
  const settings = resolveOpenAISettings(request.featureName, request.modelEnvName, request.settings);
  const client = request.settings && (request.settings.apiKey || request.settings.baseUrl)
    ? new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
    })
    : getOpenAIClient();

  try {
    return await completeJsonTextFromResponsesApi(client, settings, request);
  } catch (error) {
    if (!shouldFallbackToChatCompletions(error)) {
      throw new Error(`${request.featureName} request failed: ${stringifyOpenAIError(error)}`);
    }

    try {
      return await completeJsonTextFromChatCompletions(settings, request);
    } catch (fallbackError) {
      throw new Error(`${request.featureName} request failed: ${stringifyOpenAIError(error)}; chat.completions fallback failed: ${stringifyOpenAIError(fallbackError)}`);
    }
  }
}
