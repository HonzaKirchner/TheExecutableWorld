import { getAgentBotToken, getAgentById } from "@/lib/agents";
import { deletePause, getPause, requestApprovals } from "@/lib/agent/approvals";
import type { TriggerContext } from "@/lib/agent/prompt";
import { continueAgentRun, runAgent, type ApprovalDecision, type RunOutcome } from "@/lib/agent/run";
import { appendSessionEvent, finishSession, pauseSession, startSession, unpauseSession } from "@/lib/sessions";
import type { StripeEvent } from "@/lib/stripe";
import type { Trigger } from "@/lib/triggers";

/**
 * How much of the event object to show the model. Stripe objects are large
 * and mostly nulls; this keeps a runaway payload from eating the context.
 */
const MAX_PAYLOAD_CHARS = 8000;

/**
 * Runs an agent on a Stripe event.
 *
 * Unlike Slack there is nowhere to reply: a webhook from Stripe has no thread
 * and no person waiting. So the run is the point — whatever the agent does,
 * it does through its tools — and what it says at the end is logged. A gated
 * tool still pauses and posts to the agent's audit channel the same as any
 * other trigger; there's just no thread to also apologise in if it can't.
 */
export async function handleStripeEvent(trigger: Trigger, event: StripeEvent) {
  const agent = await getAgentById(trigger.agentId);
  if (!agent) {
    console.error(`Stripe event for agent ${trigger.agentId}, which no longer exists`);
    return;
  }

  // As with Slack, one session per run — but only the event's type and id go
  // into it. The event object itself (handed to the model below) can carry
  // customer names, emails and amounts, and this transcript is public at
  // /s/<id> with no sign-in.
  const sessionId = await startSession({
    agentId: trigger.agentId,
    triggerId: trigger.id,
    triggerKind: "stripe",
    title: `Stripe ${event.type}`,
    events: [
      {
        type: "trigger",
        role: "system",
        body: `Stripe sent ${event.type}.`,
        data: { event: event.type, id: event.id, livemode: event.livemode ?? null },
      },
    ],
  });

  const triggerContext: TriggerContext = {
    description: `a Stripe \`${event.type}\` event`,
    facts: [
      `The event is ${event.id}, from connected account ${event.account}.`,
      event.livemode ? "This is live mode — it is real money." : "This is test mode.",
      "No one is waiting on an answer, so do the work with your tools. Anything you write is only recorded in the logs.",
    ],
  };

  let outcome: RunOutcome;
  try {
    outcome = await runAgent({
      agent,
      trigger: triggerContext,
      messages: [
        {
          role: "user",
          content: [
            `Stripe sent a \`${event.type}\` event. Here is what it is about:`,
            "",
            "```json",
            summarise(event.data?.object),
            "```",
          ].join("\n"),
        },
      ],
      onEvent: (runEvent) => {
        appendSessionEvent(sessionId, {
          type: runEvent.type,
          role: runEvent.type === "tool_call" ? "agent" : "system",
          body: runEvent.body,
          data: runEvent.data,
        }).catch(() => {});
      },
    });
  } catch (error) {
    console.error(`Agent ${agent.handle} failed on Stripe ${event.type} (${event.id})`, error);
    await finishSession(sessionId, {
      status: "failed",
      error: "The run failed.",
      events: [{ type: "error", role: "system", body: "The run failed." }],
    });
    return;
  }

  if (outcome.status === "paused") {
    const botToken = await getAgentBotToken(agent.id);
    const { posted } = botToken
      ? await requestApprovals({
          agent,
          botToken,
          sessionId,
          approvals: outcome.approvals,
          resumeMessages: outcome.resumeMessages,
          triggerKind: "stripe",
          triggerContext,
          replyContext: null,
        })
      : { posted: false };

    await finishOrPause(sessionId, agent.handle, event, posted);
    return;
  }

  console.log(
    `Agent ${agent.handle} handled Stripe ${event.type} (${event.id}): ` +
      `${outcome.steps} step(s), ${outcome.toolCalls.length} tool call(s)` +
      (outcome.text ? ` — ${outcome.text}` : ""),
  );
  await finishSession(sessionId, {
    status: "done",
    events: [
      {
        type: "note",
        role: "agent",
        body: outcome.text || "Done — no message, only tool calls.",
      },
    ],
  });
}

/** Picks a paused Stripe-triggered run back up once its approvals are decided. */
export async function resumeStripeRun(sessionId: string, decisions: ApprovalDecision[]) {
  const pause = await getPause(sessionId);
  if (!pause) return;

  const agent = await getAgentById(pause.agentId);
  if (!agent) {
    await finishSession(sessionId, { status: "failed", error: "The agent is gone." });
    await deletePause(sessionId);
    return;
  }

  await unpauseSession(sessionId);

  let outcome: RunOutcome;
  try {
    outcome = await continueAgentRun({
      agent,
      trigger: pause.triggerContext,
      messages: pause.resumeMessages,
      decisions,
      onEvent: (runEvent) =>
        appendSessionEvent(sessionId, {
          type: runEvent.type,
          role: runEvent.type === "tool_call" ? "agent" : "system",
          body: runEvent.body,
          data: runEvent.data,
        }).catch(() => {}),
    });
  } catch (error) {
    console.error(`Agent ${agent.handle} failed to resume`, error);
    await deletePause(sessionId);
    await finishSession(sessionId, { status: "failed", error: "The run failed after resuming." });
    return;
  }

  if (outcome.status === "paused") {
    await deletePause(sessionId);
    const botToken = await getAgentBotToken(agent.id);
    const { posted } = botToken
      ? await requestApprovals({
          agent,
          botToken,
          sessionId,
          approvals: outcome.approvals,
          resumeMessages: outcome.resumeMessages,
          triggerKind: "stripe",
          triggerContext: pause.triggerContext,
          replyContext: null,
        })
      : { posted: false };
    if (!posted) {
      await finishSession(sessionId, { status: "failed", error: "No approval channel is set up." });
      return;
    }
    await pauseSession(sessionId, [{ type: "note", role: "system", body: "Waiting for a person's approval." }]);
    return;
  }

  await deletePause(sessionId);
  await finishSession(sessionId, {
    status: "done",
    events: [{ type: "note", role: "agent", body: outcome.text || "Done — no message, only tool calls." }],
  });
}

/** Stops a paused Stripe-triggered run for good — a person clicked "Stop agent". */
export async function stopStripeRun(sessionId: string, stoppedBy: string | null, note: string | null) {
  await deletePause(sessionId);
  const text = note
    ? `Stopped by ${stoppedBy ?? "a person"}: ${note}`
    : `Stopped by ${stoppedBy ?? "a person"} before finishing.`;
  await finishSession(sessionId, {
    status: "stopped",
    events: [{ type: "note", role: "system", body: text }],
  });
}

async function finishOrPause(
  sessionId: string,
  agentHandle: string,
  event: StripeEvent,
  posted: boolean,
) {
  if (!posted) {
    console.error(`Agent ${agentHandle} needs approval for Stripe ${event.type} but has no audit channel`);
    await finishSession(sessionId, {
      status: "failed",
      error: "The run needs a person's approval, but no approval channel is set up.",
    });
    return;
  }
  await pauseSession(sessionId, [{ type: "note", role: "system", body: "Waiting for a person's approval." }]);
}

function summarise(object: unknown) {
  const json = JSON.stringify(object ?? {}, null, 2);
  return json.length > MAX_PAYLOAD_CHARS
    ? `${json.slice(0, MAX_PAYLOAD_CHARS)}\n… truncated`
    : json;
}
