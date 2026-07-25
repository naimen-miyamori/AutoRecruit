import type { ModelConfig } from './contracts';

const MODEL_CONFIG_STORAGE_KEY = 'autorecruit.modelConfig';
const MODEL_CONFIG_SESSION_KEY = 'autorecruit.modelConfig.session';

export function loadModelConfig(): ModelConfig {
  try {
    const persisted = JSON.parse(window.localStorage.getItem(MODEL_CONFIG_STORAGE_KEY) ?? '{}') as ModelConfig;
    const session = JSON.parse(window.sessionStorage.getItem(MODEL_CONFIG_SESSION_KEY) ?? '{}') as ModelConfig;
    return {
      baseUrl: typeof persisted.baseUrl === 'string' ? persisted.baseUrl : '',
      model: typeof persisted.model === 'string' ? persisted.model : '',
      apiKey: typeof session.apiKey === 'string' ? session.apiKey : '',
    };
  } catch {
    return {};
  }
}

export function saveModelConfig(settings: ModelConfig): void {
  window.localStorage.setItem(MODEL_CONFIG_STORAGE_KEY, JSON.stringify({
    baseUrl: settings.baseUrl?.trim() || '',
    model: settings.model?.trim() || '',
  }));
  if (settings.apiKey?.trim()) {
    window.sessionStorage.setItem(MODEL_CONFIG_SESSION_KEY, JSON.stringify({ apiKey: settings.apiKey.trim() }));
  } else {
    window.sessionStorage.removeItem(MODEL_CONFIG_SESSION_KEY);
  }
}

export function modelConfigForRequest(): ModelConfig | undefined {
  const settings = loadModelConfig();
  const config: ModelConfig = {};
  if (settings.baseUrl?.trim()) config.baseUrl = settings.baseUrl.trim();
  if (settings.model?.trim()) config.model = settings.model.trim();
  if (settings.apiKey?.trim()) config.apiKey = settings.apiKey.trim();
  return Object.keys(config).length ? config : undefined;
}
