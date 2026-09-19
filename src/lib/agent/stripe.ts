import { getAgentById } from "@/lib/agents";
import { runAgent } from "@/lib/agent/run";
import { appendSessionEvent, finishSession, startSession } from "@/lib/sessions";
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
 * it does through its tools — and what it says at the end is logged. Giving
 * an agent somewhere to report (a Slack channel, an email) is a setting that
 * doesn't exist yet; when it does, it plugs in here.
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

  try {
    const run = await runAgent({
      agent,
      trigger: {
        description: `a Stripe \`${event.type}\` event`,
        facts: [
          `The event is ${event.id}, from connected account ${event.account}.`,
          event.livemode ? "This is live mode — it is real money." : "This is test mode.",
          "No one is waiting on an answer, so do the work with your tools. Anything you write is only recorded in the logs.",
        ],
      },
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

    console.log(
      `Agent ${agent.handle} handled Stripe ${event.type} (${event.id}): ` +
        `${run.steps} step(s), ${run.toolCalls.length} tool call(s)` +
        (run.text ? ` — ${run.text}` : ""),
    );
    await finishSession(sessionId, {
      status: "done",
      events: [
        {
          type: "note",
          role: "agent",
          body: run.text || "Done — no message, only tool calls.",
        },
      ],
    });
  } catch (error) {
    console.error(`Agent ${agent.handle} failed on Stripe ${event.type} (${event.id})`, error);
    await finishSession(sessionId, {
      status: "failed",
      error: "The run failed.",
      events: [{ type: "error", role: "system", body: "The run failed." }],
    });
  }
}

function summarise(object: unknown) {
  const json = JSON.stringify(object ?? {}, null, 2);
  return json.length > MAX_PAYLOAD_CHARS
    ? `${json.slice(0, MAX_PAYLOAD_CHARS)}\n… truncated`
    : json;
}
