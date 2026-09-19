/**
 * The providers an agent can run on. Adding one is three steps: install its
 * `@ai-sdk/*` package, register the factory in src/lib/agent/providers.ts,
 * and add its models below. Nothing else in the app knows about providers —
 * an agent stores a model id and the registry resolves it.
 */
export const PROVIDERS = [
  { id: "openai", label: "OpenAI", apiKeyEnv: "OPENAI_API_KEY" },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

/**
 * The models an agent can run on. A short list on purpose, for now.
 *
 * Ids are unique across providers — they are what an agent row stores, and
 * what the registry looks up as `provider:id`.
 */
export const MODELS = [
  { id: "gpt-5", label: "GPT-5", provider: "openai" },
  { id: "gpt-5-mini", label: "GPT-5 mini", provider: "openai" },
  { id: "gpt-4.1", label: "GPT-4.1", provider: "openai" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
] as const satisfies readonly { id: string; label: string; provider: ProviderId }[];

export const DEFAULT_MODEL = MODELS[0].id;

export type ModelId = (typeof MODELS)[number]["id"];

export type Model = (typeof MODELS)[number];

export function isModelId(value: string): value is ModelId {
  return MODELS.some((model) => model.id === value);
}

export function getModel(id: string): Model | null {
  return MODELS.find((model) => model.id === id) ?? null;
}

export function getProvider(id: string) {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}
