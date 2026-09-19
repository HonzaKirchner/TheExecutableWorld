import type { ModelMessage } from "ai";

import { getAgentBotToken, getAgentById } from "@/lib/agents";
import { deletePause, getPause, requestApprovals } from "@/lib/agent/approvals";
import { buildListBlocks, createProgressTracker, renderProgress } from "@/lib/agent/progress";
import { isSilence, type TriggerContext } from "@/lib/agent/prompt";
import { continueAgentRun, describeRunFailure, runAgent, type ApprovalDecision, type RunOutcome } from "@/lib/agent/run";
import { debugScope, preview } from "@/lib/log";
import {
  appendSessionEvent,
  finishSession,
  pauseSession,
  sessionUrl,
  startSession,
  unpauseSession,
} from "@/lib/sessions";
import {
  fetchThread,
  mentionsUser,
  replyInThread,
  updateReply,
  type SlackBlock,
  type SlackMessageEvent,
} from "@/lib/slack-events";
import type { SlackTriggerContext } from "@/lib/triggers";

const log = debugScope("slack.answer");

/** How much of a thread to hand the model. Oldest messages are dropped first. */
const THREAD_LIMIT = 50;

/**
 * What `answerSlackMessage` needs to finish the job once a paused run picks
 * back up — stored on the pause row as opaque JSON and read back only here.
 */
type SlackReplyContext = {
  channel: string;
  eventTs: string;
  threadTs?: string;
  addressed: boolean;
};

/**
 * Answers a Slack message as the agent.
 *
 * Called after the webhook has already replied 200 to Slack — a run takes
 * far longer than the three seconds Slack allows — so nothing here can change
 * the HTTP response, and every failure has to end in something said in the
 * thread. A person who @mentions an agent and gets silence has no way to tell
 * a crash from being ignored.
 *
 * `addressed` says whether the message named the agent. When it didn't, two
 * things stand between it and a reply: the thread must have been started by
 * someone calling on the agent, which is decided here from the thread's root
 * message, and the agent itself must judge the message worth answering.
 *
 * An addressed run gets a live progress message right away, since someone is
 * waiting on it. A run the agent might stay silent on (an unaddressed
 * follow-up in a thread it was called into earlier) gets no placeholder up
 * front — nothing appears until the first tool call shows it has actually
 * decided to engage, so overhearing a thread never looks like the agent
 * butting in to think out loud before it's said a word. If it never calls a
 * tool and answers straight away, or stays silent, no progress message is
 * posted at all. Its session (see below) still records that it looked and
 * passed — that's a private, linkable audit trail, not something the channel
 * sees.
 *
 * While it runs, each tool call is its own top-level line — nothing tucked
 * behind a disclosure a person has to open to see what's happening. Once
 * there's nothing left to report, it collapses into one checklist (see
 * `createProgressTracker`'s `finish`) and stays there as a record of what the
 * agent did; the final answer is always posted as its own new reply in the
 * thread rather than overwriting it.
 */
export async function answerSlackMessage(
  context: SlackTriggerContext & { botToken: string },
  event: SlackMessageEvent & { channel: string; ts: string },
  addressed: boolean,
) {
  const threadTs = event.thread_ts ?? event.ts;
  const startedAt = Date.now();
  log("started", {
    agent: context.agentHandle,
    channel: event.channel,
    ts: event.ts,
    threadTs,
    user: event.user,
    addressed,
  });

  const agent = await getAgentById(context.agentId);
  if (!agent) {
    console.error(`Slack event for agent ${context.agentId}, which no longer exists`);
    return;
  }

  const thread = await fetchThread({
    botToken: context.botToken,
    channel: event.channel,
    threadTs,
    limit: THREAD_LIMIT,
  });

  // A message that didn't name the agent is only its business if the thread
  // was opened by someone calling on it. The root message settles that, and
  // nothing about the decision is left to the model.
  //
  // A thread we can't read counts as one we weren't invited to: the fallback
  // to the single delivered message is fine for answering a mention, but it
  // can't show how the thread began, and guessing would have the agent join
  // conversations it was never called into.
  //
  // Nothing is recorded for a drop here — see `routeMessage`, which already
  // filters most channel chatter before this function is even called. A
  // session is a run; a message the agent never looked twice at isn't one.
  if (!addressed) {
    const root = thread?.[0];
    if (!root || !mentionsUser(root.text, context.botUserId)) {
      log("ignored: the thread was not started by a mention of the agent", {
        agent: agent.handle,
        channel: event.channel,
        threadTs,
        threadReadable: thread != null,
      });
      return;
    }
  }

  // Built once, up front, so the same turns go both to the model and into the
  // transcript below — nothing here is more sensitive than the thread itself,
  // which everyone in it can already read in Slack.
  const messages = buildMessages(context, event, thread);

  // One session per run, with a transcript anyone holding the link can read
  // at /s/<id> — no sign-in, so only what a stranger reading over the
  // person's shoulder could already see goes in: the message and the reply,
  // never tokens or ids. `onEvent` below appends to it live, so someone
  // watching sees tool calls arrive as the run makes them, not just at the end.
  //
  // The triggering message carries the full thread the model actually saw as
  // its `data`, behind the transcript's existing "Show details" disclosure —
  // otherwise a reply that clearly used earlier thread context looks like it
  // came out of nowhere.
  const sessionId = await startSession({
    agentId: context.agentId,
    triggerId: context.triggerId,
    triggerKind: "slack",
    title: sessionTitle(event, addressed),
    events: [
      {
        type: "trigger",
        role: "system",
        body: `Slack delivered ${event.type}.`,
        data: { event: event.type, channelType: event.channel_type ?? null, addressed },
      },
      {
        type: "message",
        role: "user",
        body: event.text ?? "",
        data: messages.length > 1 ? { thread: messages } : null,
      },
    ],
  });

  // Linked from the checklist while it's live, so whoever's watching can jump
  // to the full transcript without waiting for the run to finish.
  const transcriptUrl = sessionUrl(sessionId);

  // The message the checklist lives in — created lazily the first time it's
  // published to. An addressed message publishes immediately, below, so the
  // person sees something is happening rather than watching a mention sit
  // unanswered. An unaddressed one waits for the first tool call, the
  // earliest point it's clear the agent decided to engage rather than stay
  // out of it — see the doc comment above.
  let progressMessageTs: string | undefined;
  const publishProgress = async ({ text, blocks }: { text: string; blocks: SlackBlock[] }) => {
    try {
      if (progressMessageTs) {
        await updateReply({
          botToken: context.botToken,
          channel: event.channel,
          ts: progressMessageTs,
          text,
          blocks,
          unfurlLinks: false,
        });
      } else {
        progressMessageTs = await replyInThread({
          botToken: context.botToken,
          channel: event.channel,
          ts: event.ts,
          threadTs: event.thread_ts,
          text,
          blocks,
          unfurlLinks: false,
        });
      }
    } catch (error) {
      log("progress update failed", { agent: agent.handle, error });
    }
  };

  const progress = createProgressTracker(publishProgress, { sessionUrl: transcriptUrl });
  if (addressed) {
    await publishProgress({ text: renderProgress([]), blocks: buildListBlocks([], transcriptUrl) });
  }

  const trigger = buildTrigger(event, addressed);
  const reply: SlackReplyContext = {
    channel: event.channel,
    eventTs: event.ts,
    threadTs: event.thread_ts,
    addressed,
  };

  let outcome: RunOutcome;
  try {
    outcome = await runAgent({
      agent,
      trigger,
      messages: buildMessages(context, event, thread),
      onProgress: progress.handle,
      onEvent: (runEvent) =>
        appendSessionEvent(sessionId, {
          type: runEvent.type,
          role: runEvent.type === "tool_call" ? "agent" : "system",
          body: runEvent.body,
          data: runEvent.data,
        }).catch((error) => log("failed to append a session event", { error })),
    });
  } catch (error) {
    console.error(`Agent ${agent.handle} failed to answer`, error);
    log("run failed", { agent: agent.handle, ms: Date.now() - startedAt, error });
    await progress.finish();
    await finishRun(sessionId, context.botToken, reply, describeRunFailure(error), true);
    return;
  }

  if (outcome.status === "paused") {
    log("paused", { agent: agent.handle, ms: Date.now() - startedAt, approvals: outcome.approvals.length });
    await progress.finish();
    const { posted } = await requestApprovals({
      agent,
      botToken: context.botToken,
      sessionId,
      approvals: outcome.approvals,
      resumeMessages: outcome.resumeMessages,
      triggerKind: "slack",
      triggerContext: trigger,
      replyContext: reply,
    });
    if (!posted) {
      await finishRun(
        sessionId,
        context.botToken,
        reply,
        "I can't do that without a person's sign-off, and no approval channel is set up for me yet — ask whoever manages me to set one.",
        true,
      );
      return;
    }
    await pauseSession(sessionId, [
      { type: "note", role: "system", body: "Waiting for a person's approval." },
    ]);
    return;
  }

  console.log(
    `Agent ${agent.handle} answered in ${event.channel}: ${outcome.steps} step(s), ` +
      `${outcome.toolCalls.length} tool call(s)`,
  );
  log("run finished", {
    agent: agent.handle,
    ms: Date.now() - startedAt,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls.map((call) => `${call.name}${call.ok ? "" : "!"}`).join(","),
    chars: outcome.text.length,
    text: preview(outcome.text),
  });

  // Only offered when the agent wasn't spoken to, so a mention can never end
  // in silence — see `mayStaySilent`.
  if (!addressed && isSilence(outcome.text)) {
    log("stayed out: the agent judged the message wasn't for it", {
      agent: agent.handle,
      channel: event.channel,
      threadTs,
    });
    await progress.finish();
    await finishSession(sessionId, {
      status: "done",
      events: [
        {
          type: "note",
          role: "agent",
          body: "Looked at the message and stayed out — it wasn't addressed to me.",
        },
      ],
    });
    return;
  }

  await progress.finish();
  // A run that only called tools and said nothing still owes the thread a
  // word, or the message looks unanswered.
  await finishRun(sessionId, context.botToken, reply, outcome.text || "Done.", false);
}

/**
 * Picks a paused Slack run back up once every gated call it was waiting on
 * has a decision. Called by the interactions route, never directly by a
 * webhook — the pause is what remembers everything a webhook once knew.
 */
export async function resumeSlackRun(sessionId: string, decisions: ApprovalDecision[]) {
  const pause = await getPause(sessionId);
  if (!pause) {
    log("resume: no pause row, giving up", { sessionId });
    return;
  }
  const reply = pause.replyContext as SlackReplyContext;

  const agent = await getAgentById(pause.agentId);
  const botToken = agent ? await getAgentBotToken(agent.id) : null;
  if (!agent || !botToken) {
    console.error(`Cannot resume session ${sessionId}: agent or bot token missing`);
    await finishSession(sessionId, { status: "failed", error: "The agent or its Slack install is gone." });
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
    await finishRun(sessionId, botToken, reply, describeRunFailure(error), true);
    return;
  }

  if (outcome.status === "paused") {
    // Reached another gated tool call further down the line — same dance,
    // one level deeper. The pause row is simply overwritten.
    await deletePause(sessionId);
    const { posted } = await requestApprovals({
      agent,
      botToken,
      sessionId,
      approvals: outcome.approvals,
      resumeMessages: outcome.resumeMessages,
      triggerKind: "slack",
      triggerContext: pause.triggerContext,
      replyContext: reply,
    });
    if (!posted) {
      await finishRun(
        sessionId,
        botToken,
        reply,
        "I can't do that without a person's sign-off, and no approval channel is set up for me yet.",
        true,
      );
      return;
    }
    await pauseSession(sessionId, [
      { type: "note", role: "system", body: "Waiting for a person's approval." },
    ]);
    return;
  }

  await deletePause(sessionId);
  await finishRun(sessionId, botToken, reply, outcome.text || "Done.", false);
}

/** Stops a paused Slack run for good — a person clicked "Stop agent". */
export async function stopSlackRun(sessionId: string, stoppedBy: string | null, note: string | null) {
  const pause = await getPause(sessionId);
  await deletePause(sessionId);
  const reply = pause?.replyContext as SlackReplyContext | undefined;
  const agent = pause ? await getAgentById(pause.agentId) : null;
  const botToken = agent ? await getAgentBotToken(agent.id) : null;

  const text = note
    ? `Stopped by ${stoppedBy ?? "a person"}: ${note}`
    : `Stopped by ${stoppedBy ?? "a person"} before finishing.`;

  if (reply && botToken) {
    await finishRun(sessionId, botToken, reply, text, false, "stopped");
  } else {
    await finishSession(sessionId, {
      status: "stopped",
      events: [{ type: "note", role: "system", body: text }],
    });
  }
}

/** What woke the agent up, kept so a resumed run can rebuild the same prompt. */
function buildTrigger(event: SlackMessageEvent, addressed: boolean): TriggerContext {
  return {
    description: describeTrigger(event, addressed),
    facts: [
      `The person who wrote to you is <@${event.user ?? "unknown"}>.`,
      "Your answer is posted in the thread, so keep it to what fits in a chat message.",
    ],
    mayStaySilent: !addressed,
  };
}

/** One line for the prompt about what woke the agent up. */
function describeTrigger(event: SlackMessageEvent, addressed: boolean) {
  if (event.channel_type === "im") return "a direct message in Slack";
  if (addressed) return "an @mention in a Slack channel";
  return "a new message in a Slack thread you were called into earlier";
}

/** One line for the session list, in the same three cases as `describeTrigger`. */
function sessionTitle(event: SlackMessageEvent, addressed: boolean) {
  if (event.channel_type === "im") return "Direct message";
  if (addressed) return "Mentioned in a channel";
  return "Followed up in a thread";
}

/**
 * Posts the thread's reply and closes out the session. Shared by a run that
 * finished outright and one that's coming back from a pause — both end the
 * same way, one message and a closed session.
 *
 * Always a new message, even when a progress checklist is sitting in the
 * thread — that checklist is left alone as the record of what the run did,
 * not swapped out for the answer.
 */
async function finishRun(
  sessionId: string,
  botToken: string,
  reply: SlackReplyContext,
  text: string,
  runFailed: boolean,
  status: "done" | "failed" | "stopped" = runFailed ? "failed" : "done",
) {
  try {
    await replyInThread({
      botToken,
      channel: reply.channel,
      ts: reply.eventTs,
      threadTs: reply.threadTs,
      text: toMrkdwn(text),
    });
    await finishSession(sessionId, {
      status,
      error: runFailed ? "The run failed before it could answer." : null,
      events: [{ type: "reply", role: "agent", body: text }],
    });
  } catch (error) {
    // The last place a message can vanish: the run worked, the answer exists,
    // and Slack refused to post it — a missing `chat:write`, or a channel the
    // app was never added to.
    console.error("Could not post the reply to Slack", error);
    log("reply failed", { channel: reply.channel, error });
    await finishSession(sessionId, {
      status: "failed",
      error: runFailed
        ? "The run failed, and the reply couldn't be posted to Slack either."
        : "The reply couldn't be posted to Slack.",
      events: [{ type: "error", role: "system", body: "The reply couldn't be posted to Slack." }],
    });
  }
}

/**
 * The conversation as the model should see it: the thread so far, with the
 * agent's own messages as its own turns. Falls back to the single message
 * Slack delivered when the thread couldn't be read (see `fetchThread`).
 */
function buildMessages(
  context: SlackTriggerContext & { botToken: string },
  event: SlackMessageEvent & { channel: string; ts: string },
  thread: SlackMessageEvent[] | null,
): ModelMessage[] {
  const messages = thread ?? [event];
  const turns: ModelMessage[] = [];

  for (const message of messages) {
    const body = message.text?.trim();
    if (!body) continue;

    const isOwn =
      Boolean(message.bot_id) ||
      (context.botUserId != null && message.user === context.botUserId);

    turns.push(
      isOwn
        ? { role: "assistant", content: body }
        : // Several people can be in one thread, so each turn says who wrote
          // it. Slack's own `<@U…>` form, which the model already sees inside
          // the message text when someone is mentioned.
          { role: "user", content: `<@${message.user ?? "unknown"}>: ${body}` },
    );
  }

  log("messages built", {
    agent: context.agentHandle,
    source: thread ? "thread" : "single event",
    fetched: messages.length,
    turns: turns.length,
    ownTurns: turns.filter((turn) => turn.role === "assistant").length,
  });

  // An empty thread would be rejected by every provider, and can happen when
  // the only message is a file with no text.
  return turns.length > 0
    ? turns
    : [{ role: "user", content: `<@${event.user ?? "unknown"}> sent a message with no text.` }];
}

/**
 * Markdown to Slack's mrkdwn, for the two differences that actually show up
 * in an answer. Slack renders anything it doesn't know literally, so `**bold**`
 * would reach the reader with the asterisks still in it.
 */
function toMrkdwn(text: string) {
  return text
    .replace(/\*\*([\s\S]+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
}
