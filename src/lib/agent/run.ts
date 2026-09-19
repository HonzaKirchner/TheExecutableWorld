import { generateText, stepCountIs, type ModelMessage, type ToolApprovalStatus } from "ai";

import type { Agent } from "@/lib/agents";
import { classifyToolCall, hasClassifier } from "@/lib/agent/classifier";
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

/** A gated tool call the model made that a person now has to decide on. */
export type PendingApproval = {
  approvalId: string;
  toolCallId: string;
  /** Qualified name — `serverId__toolName`, as the model sees it. */
  toolName: string;
  serverName: string;
  title?: string;
  args: unknown;
  /** The classifier's note, if a classifier looked at this call first. */
  reason?: string;
};

/**
 * What a run comes back with: either it's done, same as always, or it
 * stopped at a gated tool call and is waiting on a person. `resumeMessages`
 * is the whole conversation so far, in the shape the model needs back —
 * opaque to every caller but `continueAgentRun`, which is the only thing
 * that ever reads it again.
 */
export type RunOutcome =
  | ({ status: "done" } & AgentRun)
  | { status: "paused"; approvals: PendingApproval[]; resumeMessages: ModelMessage[] };

/** A person's decision on one gated tool call, ready to hand back to the model. */
export type ApprovalDecision = {
  approvalId: string;
  approved: boolean;
  /** Why — shown to the model when denied, so it can explain itself. */
  reason?: string;
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
  type: "tool_call" | "tool_result" | "note";
  body: string;
  data?: Record<string, unknown>;
};

type RunCallbacks = {
  onProgress?: (event: RunProgress) => void;
  onEvent?: (event: AgentRunEvent) => void;
};

/** A human name for a tool call — the server it belongs to, not its arguments. */
function labelFor(labels: Record<string, ToolLabel>, toolName: string) {
  const label = labels[toolName];
  if (!label) return toolName;
  return `${label.serverName}: ${label.title ?? label.toolName}`;
}

/**
 * Runs the agent once and returns what it wants to say — or, if it called a
 * gated tool, hands back what a caller needs to ask a person and pick the run
 * back up later with `continueAgentRun`.
 *
 * This is the whole harness: every trigger builds `messages`, calls this, and
 * decides what to do with the answer. Nothing in here knows about Slack or
 * Stripe, and nothing here writes anywhere — delivery is the caller's job.
 */
export async function runAgent(input: {
  agent: Agent;
  trigger: TriggerContext;
  messages: ModelMessage[];
  onProgress?: RunCallbacks["onProgress"];
  onEvent?: RunCallbacks["onEvent"];
}): Promise<RunOutcome> {
  const tools = await loadAgentTools(input.agent.id);
  try {
    return await execute({
      agent: input.agent,
      trigger: input.trigger,
      tools,
      messages: input.messages,
      onProgress: input.onProgress,
      onEvent: input.onEvent,
    });
  } finally {
    await tools.close();
  }
}

/**
 * Picks a paused run back up: `messages` is the pause's `resumeMessages` with
 * the person's decisions appended as a `tool-approval-response` message,
 * which the AI SDK matches back to the pending request by `approvalId`.
 *
 * Loads tools fresh rather than reusing whatever set the original call built
 * — access may have changed while the run was waiting, and the new decision
 * should see the current configuration, not a stale one held open across an
 * approval that could take hours.
 */
export async function continueAgentRun(input: {
  agent: Agent;
  trigger: TriggerContext;
  messages: ModelMessage[];
  decisions: ApprovalDecision[];
  onProgress?: RunCallbacks["onProgress"];
  onEvent?: RunCallbacks["onEvent"];
}): Promise<RunOutcome> {
  const tools = await loadAgentTools(input.agent.id);
  try {
    const messages: ModelMessage[] = [
      ...input.messages,
      {
        role: "tool",
        content: input.decisions.map((decision) => ({
          type: "tool-approval-response" as const,
          approvalId: decision.approvalId,
          approved: decision.approved,
          reason: decision.reason,
        })),
      },
    ];
    return await execute({
      agent: input.agent,
      trigger: input.trigger,
      tools,
      messages,
      onProgress: input.onProgress,
      onEvent: input.onEvent,
    });
  } finally {
    await tools.close();
  }
}

/**
 * The one place that calls the model. Shared by a fresh run and a resumed
 * one — both are "call the model with this conversation and see what it
 * does", and a resumed run can pause again just as easily as the first call
 * did, if it reaches for another gated tool further down the line.
 */
async function execute(input: {
  agent: Agent;
  trigger: TriggerContext;
  tools: Awaited<ReturnType<typeof loadAgentTools>>;
  messages: ModelMessage[];
  onProgress?: RunCallbacks["onProgress"];
  onEvent?: RunCallbacks["onEvent"];
}): Promise<RunOutcome> {
  const model = resolveModel(input.agent.model);
  const { tools } = input;

  log("starting", {
    agent: input.agent.handle,
    model: input.agent.model,
    trigger: input.trigger.description,
    messages: input.messages.length,
    tools: Object.keys(tools.toolSet).join(",") || "none",
    unreachable:
      tools.unreachable.map((server) => `${server.serverName}(${server.error})`).join(",") ||
      "none",
  });

  // Jev's verdict on a gated call is known here, in `toolApproval` — well
  // before `onToolExecutionStart` fires for it — so it's stashed by call id
  // and picked back up there, to show up right on the tool call itself
  // rather than as a separate note once the whole run is done.
  const autoApprovedBy = new Map<string, string>();

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
      toolApproval: async ({ toolCall }): Promise<ToolApprovalStatus> => {
        const gate = tools.approvals[toolCall.toolName];
        if (!gate) return { type: "not-applicable" };
        if (!gate.classifierEnabled || !hasClassifier(gate.classifier)) {
          return { type: "user-approval" };
        }
        const verdict = await classifyToolCall({
          config: gate.classifier,
          serverName: gate.serverName,
          toolName: gate.toolName,
          args: toolCall.input,
        });
        if (verdict.decision === "auto_approve") {
          autoApprovedBy.set(toolCall.toolCallId, "Jev");
        }
        return verdict.decision === "auto_approve"
          ? { type: "approved", reason: verdict.reason }
          : { type: "user-approval", reason: verdict.reason };
      },
      stopWhen: stepCountIs(MAX_STEPS),
      timeout: TIMEOUT_MS,
      onToolExecutionStart: ({ callId, toolCall }) => {
        log("tool call", { tool: toolCall.toolName, input: preview(JSON.stringify(toolCall.input)) });
        notify(input.onProgress, {
          type: "tool-start",
          callId,
          label: labelFor(tools.labels, toolCall.toolName),
        });
        const approvedBy = autoApprovedBy.get(toolCall.toolCallId);
        notify(input.onEvent, {
          type: "tool_call",
          body: approvedBy ? `${toolCall.toolName} (auto-approved by ${approvedBy})` : toolCall.toolName,
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

    const pending = pendingApprovals(result.steps, tools.labels);
    if (pending.length > 0) {
      log("paused", {
        agent: input.agent.handle,
        approvals: pending.map((approval) => approval.toolName).join(","),
      });
      notify(input.onEvent, {
        type: "note",
        body: pending.length === 1
          ? `Paused: ${labelFor(tools.labels, pending[0].toolName)} needs a person's approval.`
          : `Paused: ${pending.length} tool calls need a person's approval.`,
        data: { approvals: pending.map((approval) => approval.toolName) },
      });
      return {
        status: "paused",
        approvals: pending,
        resumeMessages: [...input.messages, ...result.response.messages],
      };
    }

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
      status: "done",
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
  }
}

/**
 * The gated tool calls this call's last step is waiting on — the loop stops
 * itself the moment one comes up, so there is never more than one step's
 * worth to look at.
 */
function pendingApprovals(
  steps: readonly { content: readonly { type: string }[] }[],
  labels: Record<string, ToolLabel>,
): PendingApproval[] {
  const lastStep = steps.at(-1);
  if (!lastStep) return [];

  const approvals: PendingApproval[] = [];
  for (const raw of lastStep.content) {
    // Not part of the discriminated `ContentPart` union in every SDK version
    // this file has to compile against, so read it structurally instead.
    const part = raw as {
      type: string;
      isAutomatic?: boolean;
      approvalId?: string;
      reason?: string;
      toolCall?: { toolCallId: string; toolName: string; input: unknown };
    };
    if (part.type !== "tool-approval-request" || part.isAutomatic || !part.toolCall || !part.approvalId) {
      continue;
    }
    approvals.push({
      approvalId: part.approvalId,
      toolCallId: part.toolCall.toolCallId,
      toolName: part.toolCall.toolName,
      serverName: labels[part.toolCall.toolName]?.serverName ?? part.toolCall.toolName,
      title: labels[part.toolCall.toolName]?.title,
      args: part.toolCall.input,
      reason: part.reason,
    });
  }
  return approvals;
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
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    // Circular references and the like — nothing to serialise, but at least
    // say what kind of thing it was rather than showing nothing.
    return preview(String(value), 500);
  }
  // Short enough to keep whole — the common case, and the only one where
  // reparsing gives back a real object instead of a truncated, unparsable
  // fragment of one.
  if (json.length <= 500) return JSON.parse(json);
  // Too long to keep as an object: shown as the truncated JSON text itself,
  // not `String(value)`, which for anything but a primitive is just
  // "[object Object]" and throws away everything worth seeing.
  return preview(json, 500);
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
