import { createOpenAI } from "@ai-sdk/openai";
import { createProviderRegistry, type LanguageModel } from "ai";

import { getModel, getProvider, PROVIDERS, type ProviderId } from "@/lib/models";

/**
 * How to build each provider's client. The catalog in src/lib/models.ts says
 * which providers exist and which environment variable holds the key; this is
 * the one place that imports an `@ai-sdk/*` package.
 *
 * To add Anthropic: `pnpm add @ai-sdk/anthropic`, add the entry to `PROVIDERS`
 * and its models to `MODELS`, then add
 * `anthropic: (apiKey) => createAnthropic({ apiKey })` here.
 */
const FACTORIES = {
  openai: (apiKey: string) => createOpenAI({ apiKey }),
} satisfies Record<ProviderId, (apiKey: string) => unknown>;

type ProviderClient = ReturnType<(typeof FACTORIES)[ProviderId]>;

export class MissingApiKeyError extends Error {
  readonly provider: string;
  readonly variable: string;

  constructor(provider: string, variable: string) {
    super(`${provider} is not configured: ${variable} is not set`);
    this.name = "MissingApiKeyError";
    this.provider = provider;
    this.variable = variable;
  }
}

/**
 * The registry over every provider whose key is configured. Built once per
 * server process — the keys come from the environment and don't change while
 * it runs.
 */
let registry: ReturnType<typeof createRegistry> | null = null;

function createRegistry() {
  const providers: Record<string, ProviderClient> = {};
  for (const provider of PROVIDERS) {
    const apiKey = process.env[provider.apiKeyEnv];
    if (apiKey) providers[provider.id] = FACTORIES[provider.id](apiKey);
  }
  return createProviderRegistry(providers);
}

/**
 * The language model an agent's `model` column names.
 *
 * Throws rather than falling back to another model: an agent configured for
 * one model quietly answering as another is worse than not answering.
 */
export function resolveModel(modelId: string): LanguageModel {
  const model = getModel(modelId);
  if (!model) {
    throw new Error(`Unknown model "${modelId}"`);
  }

  const provider = getProvider(model.provider);
  if (!provider) {
    throw new Error(`Model "${modelId}" names an unknown provider`);
  }
  if (!process.env[provider.apiKeyEnv]) {
    throw new MissingApiKeyError(provider.label, provider.apiKeyEnv);
  }

  registry ??= createRegistry();
  return registry.languageModel(`${model.provider}:${model.id}`);
}

/** Which providers can actually be used right now. For diagnostics. */
export function configuredProviders() {
  return PROVIDERS.filter((provider) => Boolean(process.env[provider.apiKeyEnv]));
}
