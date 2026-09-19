/** The models an agent can run on. A short list on purpose, for now. */
export const MODELS = [
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4o", label: "GPT-4o" },
] as const;

export const DEFAULT_MODEL = MODELS[0].id;

export type ModelId = (typeof MODELS)[number]["id"];

export function isModelId(value: string): value is ModelId {
  return MODELS.some((model) => model.id === value);
}
