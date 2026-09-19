import { generateText, stepCountIs, type ModelMessage } from "ai";

import type { Agent } from "@/lib/agents";
import { buildInstructions, type TriggerContext } from "@/lib/agent/prompt";
import { MissingApiKeyError, resolveModel } from "@/lib/agent/providers";
import { loadAgentTools } from "@/lib/agent/tools";

/**
 * How many times the model may call tools and look at the results before it
 * has to answer. High enough for a few lookups in a row, low enough that a
 * confused agent stops costing money quickly.
 */
const MAX_STEPS = 12;

/** The whole run has to fit inside the route's `maxDuration`. */
const TIMEOUT_MS = 2 * 60 * 1000;

export type AgentRun = {
  /** What the agent wants to say. Empty if it only used tools. */
  text: string;
  /** How many model calls it took. */
  steps: number;
  toolCalls: { name: string; ok: boolean }[];
};

/**
 * Runs the agent once and returns what it wants to say.
 *
 * This is the whole harness: every trigger builds `messages`, calls this, and
 * decides what to do with the answer. Nothing in here knows about Slack or
 * Stripe, and nothing here writes anywhere — delivery is the caller's job.
 */
export async function runAgent(input: {
  agent: Agent;
  trigger: TriggerContext;
  messages: ModelMessage[];
}): Promise<AgentRun> {
  const model = resolveModel(input.agent.model);
  const tools = await loadAgentTools(input.agent.id);

  try {
    const result = await generateText({
      model,
      instructions: buildInstructions({
        agent: input.agent,
        trigger: input.trigger,
        tools,
      }),
      messages: input.messages,
      tools: tools.toolSet,
      stopWhen: stepCountIs(MAX_STEPS),
      timeout: TIMEOUT_MS,
    });

    return {
      text: result.text.trim(),
      steps: result.steps.length,
      toolCalls: result.steps.flatMap((step) => {
        // A tool that threw doesn't reject the run — it comes back as a
        // `tool-error` part, which the model sees and can work around.
        const failed = new Set(
          step.content
            .filter((part) => part.type === "tool-error")
            .map((part) => part.toolCallId),
        );
        return step.toolCalls.map((call) => ({
          name: call.toolName,
          ok: !failed.has(call.toolCallId),
        }));
      }),
    };
  } finally {
    await tools.close();
  }
}

/**
 * What to say to a person when a run fails. Deliberately short and specific
 * about the cause the person can do something about — a missing API key is a
 * setup problem, everything else is ours.
 */
export function describeRunFailure(error: unknown) {
  if (error instanceof MissingApiKeyError) {
    return `I can't answer — ${error.provider} isn't configured for this deployment (${error.variable} is not set).`;
  }
  return "Something went wrong while I was working on that. The error is in the logs.";
}
