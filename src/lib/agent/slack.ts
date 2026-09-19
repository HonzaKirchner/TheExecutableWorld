import type { ModelMessage } from "ai";

import { getAgentById } from "@/lib/agents";
import { isSilence } from "@/lib/agent/prompt";
import { describeRunFailure, runAgent } from "@/lib/agent/run";
import { debugScope, preview } from "@/lib/log";
import {
  fetchThread,
  mentionsUser,
  replyInThread,
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

  let text: string;
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
      return;
    }

    // A run that only called tools and said nothing still owes the thread a
    // word, or the message looks unanswered.
    text = run.text || "Done.";
  } catch (error) {
    console.error(`Agent ${agent.handle} failed to answer`, error);
    log("run failed", { agent: agent.handle, ms: Date.now() - startedAt, error });
    text = describeRunFailure(error);
  }

  try {
    await replyInThread({
      botToken: context.botToken,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts,
      text: toMrkdwn(text),
    });
  } catch (error) {
    // The last place a message can vanish: the run worked, the answer exists,
    // and Slack refused to post it — a missing `chat:write`, or a channel the
    // app was never added to.
    console.error(`Agent ${agent.handle} could not post its reply`, error);
    log("reply failed", { agent: agent.handle, channel: event.channel, error });
  }
}

/** One line for the prompt about what woke the agent up. */
function describeTrigger(event: SlackMessageEvent, addressed: boolean) {
  if (event.channel_type === "im") return "a direct message in Slack";
  if (addressed) return "an @mention in a Slack channel";
  return "a new message in a Slack thread you were called into earlier";
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
