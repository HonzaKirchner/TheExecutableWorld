import { getAgentBotToken, getAgentById } from "@/lib/agents";
import { deletePause, getPause, requestApprovals } from "@/lib/agent/approvals";
import type { TriggerContext } from "@/lib/agent/prompt";
import { continueAgentRun, runAgent, type ApprovalDecision, type RunOutcome } from "@/lib/agent/run";
import { getGmailEvent } from "@/lib/gmail-events";
import type { MessageSummary } from "@/lib/gmail/api";
import { appendSessionEvent, finishSession, pauseSession, startSession, unpauseSession } from "@/lib/sessions";
import type { Trigger } from "@/lib/triggers";

/**
 * Runs an agent on a Gmail event — a message arrived, or was starred.
 *
 * As with Stripe, there is nowhere to reply: the mailbox isn't a thread the
 * agent is a party to, just an inbox it was handed. So the run is the point;
 * whatever the agent does, it does through its tools, and what it says at the
 * end is only logged.
 */
export async function handleGmailEvent(trigger: Trigger, eventId: string, summary: MessageSummary | null) {
  const agent = await getAgentById(trigger.agentId);
  if (!agent) {
    console.error(`Gmail event for agent ${trigger.agentId}, which no longer exists`);
    return;
  }

  const eventName = getGmailEvent(eventId)?.name ?? eventId;
  const subject = summary?.subject ?? null;

  const sessionId = await startSession({
    agentId: trigger.agentId,
    triggerId: trigger.id,
    triggerKind: "gmail",
    title: subject ? `Gmail: ${subject}` : `Gmail ${eventName}`,
    events: [
      {
        type: "trigger",
        role: "system",
        body: `Gmail sent ${eventName}${subject ? `: ${subject}` : ""}.`,
        data: { event: eventId, messageId: summary?.id ?? null },
      },
    ],
  });

  const triggerContext: TriggerContext = {
    description: `a Gmail \`${eventId}\` event`,
    facts: [
      summary ? `The message is ${summary.id}, in thread ${summary.threadId}.` : "The message could not be fetched.",
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
          content: summary
            ? [
                `Gmail sent a \`${eventId}\` event for this message:`,
                "",
                `From: ${summary.from ?? "(unknown)"}`,
                `To: ${summary.to ?? "(unknown)"}`,
                `Subject: ${summary.subject ?? "(no subject)"}`,
                `Date: ${summary.date ?? "(unknown)"}`,
                "",
                summary.snippet ?? "",
              ].join("\n")
            : `Gmail sent a \`${eventId}\` event, but the message itself could not be fetched.`,
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
    console.error(`Agent ${agent.handle} failed on Gmail ${eventId} (${summary?.id ?? "unknown"})`, error);
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
          triggerKind: "gmail",
          triggerContext,
          replyContext: null,
        })
      : { posted: false };

    if (!posted) {
      console.error(`Agent ${agent.handle} needs approval for Gmail ${eventId} but has no audit channel`);
      await finishSession(sessionId, {
        status: "failed",
        error: "The run needs a person's approval, but no approval channel is set up.",
      });
      return;
    }
    await pauseSession(sessionId, [{ type: "note", role: "system", body: "Waiting for a person's approval." }]);
    return;
  }

  console.log(
    `Agent ${agent.handle} handled Gmail ${eventId} (${summary?.id ?? "unknown"}): ` +
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

/** Picks a paused Gmail-triggered run back up once its approvals are decided. */
export async function resumeGmailRun(sessionId: string, decisions: ApprovalDecision[]) {
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
          triggerKind: "gmail",
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

/** Stops a paused Gmail-triggered run for good — a person clicked "Stop agent". */
export async function stopGmailRun(sessionId: string, stoppedBy: string | null, note: string | null) {
  await deletePause(sessionId);
  const text = note
    ? `Stopped by ${stoppedBy ?? "a person"}: ${note}`
    : `Stopped by ${stoppedBy ?? "a person"} before finishing.`;
  await finishSession(sessionId, {
    status: "stopped",
    events: [{ type: "note", role: "system", body: text }],
  });
}
