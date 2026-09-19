import type { ModelMessage } from "ai";

import { getAgentById } from "@/lib/agents";
import { createProgressTracker, renderProgress } from "@/lib/agent/progress";
import { isSilence } from "@/lib/agent/prompt";
import { describeRunFailure, runAgent } from "@/lib/agent/run";
import { debugScope, preview } from "@/lib/log";
import { appendSessionEvent, finishSession, startSession } from "@/lib/sessions";
import {
  fetchThread,
  mentionsUser,
  replyInThread,
  updateReply,
  type SlackMessageEvent,
} from "@/lib/slack-events";
import type { SlackTriggerContext } from "@/lib/triggers";

const log = debugScope("slack.answer");

/** How much of a thread to hand the model. Oldest messages are dropped first. */
const THREAD_LIMIT = 50;

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
 * Only an addressed run gets a live progress message, updated as tools are
 * called and replaced with the final answer when it's done. A run the agent
 * might stay silent on gets no placeholder — nothing appears in Slack until
 * it's known there is something to say, so overhearing a thread never looks
 * like the agent butting in to think out loud. Its session (see below) still
 * records that it looked and passed — that's a private, linkable audit trail,
 * not something the channel sees.
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

  // One session per run, with a transcript anyone holding the link can read
  // at /s/<id> — no sign-in, so only what a stranger reading over the
  // person's shoulder could already see goes in: the message and the reply,
  // never tokens or ids. `onEvent` below appends to it live, so someone
  // watching sees tool calls arrive as the run makes them, not just at the end.
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
      { type: "message", role: "user", body: event.text ?? "" },
    ],
  });

  // Posted before the run starts, so the person sees something is happening
  // rather than watching a mention sit unanswered while it works. Only for an
  // addressed message — see the doc comment above.
  let progressTs: string | undefined;
  let progress: ReturnType<typeof createProgressTracker> | undefined;
  if (addressed) {
    try {
      progressTs = await replyInThread({
        botToken: context.botToken,
        channel: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        text: renderProgress([]),
      });
    } catch (error) {
      log("could not post the progress placeholder, continuing without live updates", {
        agent: agent.handle,
        error,
      });
    }
    if (progressTs) {
      const placeholderTs = progressTs;
      progress = createProgressTracker((text) =>
        updateReply({
          botToken: context.botToken,
          channel: event.channel,
          ts: placeholderTs,
          text,
        }).catch((error) => {
          log("progress update failed", { agent: agent.handle, error });
        }),
      );
    }
  }

  let text: string;
  // Whether the run itself came back with an answer — kept separate from
  // whether Slack accepted the reply, since a session is `failed` if either
  // step didn't, even though `text` (the apology) still gets a post attempt.
  let runFailed = false;
  try {
    const run = await runAgent({
      agent,
      trigger: {
        description: describeTrigger(event, addressed),
        facts: [
          `The person who wrote to you is <@${event.user ?? "unknown"}>.`,
          "Your answer is posted in the thread, so keep it to what fits in a chat message.",
        ],
        mayStaySilent: !addressed,
      },
      messages: buildMessages(context, event, thread),
      onProgress: progress?.handle,
      onEvent: (runEvent) => {
        appendSessionEvent(sessionId, {
          type: runEvent.type,
          role: runEvent.type === "tool_call" ? "agent" : "system",
          body: runEvent.body,
          data: runEvent.data,
        }).catch((error) => log("failed to append a session event", { error }));
      },
    });

    console.log(
      `Agent ${agent.handle} answered in ${event.channel}: ${run.steps} step(s), ` +
        `${run.toolCalls.length} tool call(s)`,
    );
    log("run finished", {
      agent: agent.handle,
      ms: Date.now() - startedAt,
      steps: run.steps,
      toolCalls: run.toolCalls.map((call) => `${call.name}${call.ok ? "" : "!"}`).join(","),
      chars: run.text.length,
      // The empty case is the one worth seeing: the model called tools and
      // then said nothing, so the thread gets a bare "Done."
      text: preview(run.text),
    });

    // Only offered when the agent wasn't spoken to, so a mention can never end
    // in silence — see `mayStaySilent`.
    if (!addressed && isSilence(run.text)) {
      log("stayed out: the agent judged the message wasn't for it", {
        agent: agent.handle,
        channel: event.channel,
        threadTs,
      });
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

    // A run that only called tools and said nothing still owes the thread a
    // word, or the message looks unanswered.
    text = run.text || "Done.";
  } catch (error) {
    console.error(`Agent ${agent.handle} failed to answer`, error);
    log("run failed", { agent: agent.handle, ms: Date.now() - startedAt, error });
    text = describeRunFailure(error);
    runFailed = true;
    // Still worth trying to post `text` below — it's the same apology the
    // person would otherwise get in silence.
  }

  // Every progress update handed to `publish` above is fire-and-forget, so
  // one from late in the run could otherwise land after this final write and
  // overwrite it with a stale "still working" state.
  await progress?.settle();

  try {
    if (progressTs) {
      // Replaces the progress message with the answer, rather than leaving
      // the tool trail behind it — the trail was for watching the run happen,
      // not a record anyone needs once it's done. The full trail still lives
      // in the session's transcript for whoever wants it.
      await updateReply({
        botToken: context.botToken,
        channel: event.channel,
        ts: progressTs,
        text: toMrkdwn(text),
      });
    } else {
      await replyInThread({
        botToken: context.botToken,
        channel: event.channel,
        ts: event.ts,
        threadTs: event.thread_ts,
        text: toMrkdwn(text),
      });
    }
    await finishSession(sessionId, {
      status: runFailed ? "failed" : "done",
      error: runFailed ? "The run failed before it could answer." : null,
      events: [{ type: "reply", role: "agent", body: text }],
    });
  } catch (error) {
    // The last place a message can vanish: the run worked, the answer exists,
    // and Slack refused to post it — a missing `chat:write`, or a channel the
    // app was never added to.
    console.error(`Agent ${agent.handle} could not post its reply`, error);
    log("reply failed", { agent: agent.handle, channel: event.channel, error });
    await finishSession(sessionId, {
      status: "failed",
      error: runFailed
        ? "The run failed, and the reply couldn't be posted to Slack either."
        : "The reply couldn't be posted to Slack.",
      events: [{ type: "error", role: "system", body: "The reply couldn't be posted to Slack." }],
    });
  }
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
