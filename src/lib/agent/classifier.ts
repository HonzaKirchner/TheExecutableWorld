import { debugScope, preview } from "@/lib/log";

const log = debugScope("agent.classifier");

/** Jev's "system one" endpoint — see https://docs.typesafe.ai. */
const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export type ClassifierConfig = {
  systemPrompt: string | null;
  autoApproveWhen: string | null;
  escalateWhen: string | null;
};

export function hasClassifier(config: ClassifierConfig) {
  return Boolean(
    config.systemPrompt?.trim() || config.autoApproveWhen?.trim() || config.escalateWhen?.trim(),
  );
}

export type ClassifierVerdict = {
  decision: "auto_approve" | "escalate";
  reason: string;
};

type JevAnswer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: string; [key: string]: unknown };

type JevResponse = {
  answers?: { decision?: JevAnswer };
};

/**
 * Asks Jev whether a gated tool call is obviously fine or worth a person's
 * attention. Never throws: anything that goes wrong — no key, a network
 * error, a reply that doesn't parse — comes back as `escalate`, since a
 * misbehaving classifier should make the run pause more often, not less.
 */
export async function classifyToolCall(input: {
  config: ClassifierConfig;
  serverName: string;
  toolName: string;
  args: unknown;
}): Promise<ClassifierVerdict> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    return { decision: "escalate", reason: "TYPESAFE_API_KEY is not set." };
  }

  const instructions = [
    input.config.systemPrompt?.trim(),
    input.config.autoApproveWhen?.trim()
      ? `Auto-approve when: ${input.config.autoApproveWhen!.trim()}`
      : null,
    input.config.escalateWhen?.trim()
      ? `Escalate to a person when: ${input.config.escalateWhen!.trim()}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  let response: Response;
  try {
    response = await fetch(JEV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: {
          tool: `${input.serverName}: ${input.toolName}`,
          arguments: input.args,
        },
        model: "jev-latest",
        questions: {
          decision: {
            type: "choice",
            instructions:
              instructions ||
              "Decide whether this tool call is safe to run without a person's review, or should be sent to one.",
            criteria: {
              auto_approve: "Safe to run without a person reviewing it first.",
              escalate: "A person should review this before it runs.",
            },
          },
        },
      }),
    });
  } catch (error) {
    log("request failed", { tool: input.toolName, error });
    return { decision: "escalate", reason: `Could not reach the classifier: ${describe(error)}` };
  }

  if (!response.ok) {
    log("non-ok response", { tool: input.toolName, status: response.status });
    return { decision: "escalate", reason: `The classifier failed (HTTP ${response.status}).` };
  }

  const payload = (await response.json().catch(() => null)) as JevResponse | null;
  const answer = payload?.answers?.decision;
  if (answer?.type !== "choice" || (answer.choice !== "auto_approve" && answer.choice !== "escalate")) {
    log("unreadable response", { tool: input.toolName, body: preview(JSON.stringify(payload)) });
    return { decision: "escalate", reason: "The classifier's answer could not be understood." };
  }

  const confidence = typeof answer.confidence === "number" ? Math.round(answer.confidence * 100) : null;
  return {
    decision: answer.choice,
    reason: confidence != null ? `Jev: ${answer.choice} (${confidence}% confidence)` : `Jev: ${answer.choice}`,
  };
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
