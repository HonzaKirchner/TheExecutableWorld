import { generateText, stepCountIs, type ModelMessage } from "ai";

import type { Agent } from "@/lib/agents";
import { buildInstructions, type TriggerContext } from "@/lib/agent/prompt";
import { MissingApiKeyError, resolveModel } from "@/lib/agent/providers";
import { loadAgentTools, type ToolLabel } from "@/lib/agent/tools";
import { debugScope, preview } from "@/lib/log";

const log = debugScope("agent.run");

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
 * One thing worth telling a person watching the run live: a tool was called,
 * or it came back. Nothing about the model's own thinking is reported — there
 * is nothing to say between tool calls beyond "it's composing a reply", which
 * a caller can show on its own without a callback for each step.
 */
export type RunProgress =
  | { type: "tool-start"; callId: string; label: string }
  | { type: "tool-end"; callId: string; label: string; ok: boolean };

/**
 * One step of the run, in a shape a caller can hand straight to a session's
 * transcript without this module knowing that transcripts exist. Kept
 * separate from `AgentRun` because it's reported as it happens, not once at
 * the end.
 */
export type AgentRunEvent = {
  type: "tool_call" | "tool_result";
  body: string;
  data?: Record<string, unknown>;
};

/** A human name for a tool call — the server it belongs to, not its arguments. */
function labelFor(labels: Record<string, ToolLabel>, toolName: string) {
  const label = labels[toolName];
  if (!label) return toolName;
  return `${label.serverName}: ${label.title ?? label.toolName}`;
}

/**
 * Runs the agent once and returns what it wants to say.
 *
 * This is the whole harness: every trigger builds `messages`, calls this, and
 * decides what to do with the answer. Nothing in here knows about Slack or
 * Stripe, and nothing here writes anywhere — delivery is the caller's job.
 *
 * Two independent, optional callbacks report the same tool calls as they
 * happen, to two different kinds of caller: `onProgress` is for showing the
 * run live somewhere transient (a Slack message that updates in place),
 * `onEvent` is for writing it down somewhere durable (a session's
 * transcript). Neither knows the other exists. Both are best-effort — a throw
 * from either must not take the run down, since by then the model has
 * already made the call.
 */
export async function runAgent(input: {
  agent: Agent;
  trigger: TriggerContext;
  messages: ModelMessage[];
  /** Called as tools are used, so a caller can show the run happening live. */
  onProgress?: (event: RunProgress) => void;
  onEvent?: (event: AgentRunEvent) => void;
}): Promise<AgentRun> {
  const model = resolveModel(input.agent.model);
  const tools = await loadAgentTools(input.agent.id);

  log("starting", {
    agent: input.agent.handle,
    model: input.agent.model,
    trigger: input.trigger.description,
    messages: input.messages.length,
    tools: Object.keys(tools.toolSet).join(",") || "none",
    // A tool the agent expected to have and doesn't is a common reason for an
    // answer that says less than it should.
    withheld: tools.withheld.map((tool) => tool.name).join(",") || "none",
    unreachable:
      tools.unreachable.map((server) => `${server.serverName}(${server.error})`).join(",") ||
      "none",
  });

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
      onToolExecutionStart: ({ callId, toolCall }) => {
        log("tool call", { tool: toolCall.toolName, input: preview(JSON.stringify(toolCall.input)) });
        notify(input.onProgress, {
          type: "tool-start",
          callId,
          label: labelFor(tools.labels, toolCall.toolName),
        });
        notify(input.onEvent, {
          type: "tool_call",
          body: toolCall.toolName,
          data: { arguments: safeJson(toolCall.input) },
        });
      },
      onToolExecutionEnd: ({ callId, toolCall, toolOutput, toolExecutionMs }) => {
        // A tool that throws doesn't fail the run — the model sees the error
        // and works around it — so this is the only place it shows up.
        const failed = toolOutput.type === "tool-error";
        log(failed ? "tool failed" : "tool returned", {
          tool: toolCall.toolName,
          ms: toolExecutionMs,
          ...(failed
            ? { error: preview(String(toolOutput.error)) }
            : { output: preview(JSON.stringify(toolOutput.output)) }),
        });
        notify(input.onProgress, {
          type: "tool-end",
          callId,
          label: labelFor(tools.labels, toolCall.toolName),
          ok: !failed,
        });
        notify(input.onEvent, {
          type: "tool_result",
          body: failed ? `${toolCall.toolName} failed` : `${toolCall.toolName} returned`,
          data: failed
            ? { error: preview(String(toolOutput.error), 500) }
            : { output: safeJson(toolOutput.output) },
        });
      },
      onStepEnd: (step) => {
        log("step", {
          finishReason: step.finishReason,
          toolCalls: step.toolCalls.map((call) => call.toolName).join(",") || "none",
          inputTokens: step.usage.inputTokens,
          outputTokens: step.usage.outputTokens,
          text: preview(step.text, 80),
        });
      },
    });

    log("finished", {
      agent: input.agent.handle,
      steps: result.steps.length,
      finishReason: result.finishReason,
      totalTokens: result.usage.totalTokens,
      // `length` or `tool-calls` here means the model was cut off — by
      // MAX_STEPS or the provider — rather than deciding it was done.
      chars: result.text.trim().length,
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
  } catch (error) {
    log("failed", { agent: input.agent.handle, error });
    throw error;
  } finally {
    await tools.close();
  }
}

/**
 * Hands one event to a caller's sink, if it gave one. A sink is someone
 * else's write path (a live progress view, a session's transcript) — a throw
 * from it is their bug, not a reason to lose the model's tool call.
 */
function notify<E>(onEvent: ((event: E) => void) | undefined, event: E) {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch (error) {
    log("a progress callback threw", { error });
  }
}

/**
 * A tool's input or output, kept small and always representable as JSON —
 * this ends up in a session's transcript, which unlike the debug log has no
 * length budget of its own to protect it.
 */
function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(preview(JSON.stringify(value) ?? "null", 500));
  } catch {
    return preview(String(value), 500);
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
