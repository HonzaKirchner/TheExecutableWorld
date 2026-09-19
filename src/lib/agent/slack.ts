import type { ModelMessage } from "ai";

import { getAgentById } from "@/lib/agents";
import { describeRunFailure, runAgent } from "@/lib/agent/run";
import { fetchThread, replyInThread, type SlackMessageEvent } from "@/lib/slack-events";
import type { SlackTriggerContext } from "@/lib/triggers";

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
 */
export async function answerSlackMessage(
  context: SlackTriggerContext & { botToken: string },
  event: SlackMessageEvent & { channel: string; ts: string },
) {
  const threadTs = event.thread_ts ?? event.ts;

  const agent = await getAgentById(context.agentId);
  if (!agent) {
    console.error(`Slack event for agent ${context.agentId}, which no longer exists`);
    return;
  }

  let text: string;
  try {
    const run = await runAgent({
      agent,
      trigger: {
        description:
          event.channel_type === "im"
            ? "a direct message in Slack"
            : "an @mention in a Slack channel",
        facts: [
          `The person who wrote to you is <@${event.user ?? "unknown"}>.`,
          "Your answer is posted in the thread, so keep it to what fits in a chat message.",
        ],
      },
      messages: await buildMessages(context, event, threadTs),
    });

    console.log(
      `Agent ${agent.handle} answered in ${event.channel}: ${run.steps} step(s), ` +
        `${run.toolCalls.length} tool call(s)`,
    );

    // A run that only called tools and said nothing still owes the thread a
    // word, or the message looks unanswered.
    text = run.text || "Done.";
  } catch (error) {
    console.error(`Agent ${agent.handle} failed to answer`, error);
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
    console.error(`Agent ${agent.handle} could not post its reply`, error);
  }
}

/**
 * The conversation as the model should see it: the thread so far, with the
 * agent's own messages as its own turns. Falls back to the single message
 * Slack delivered when the thread can't be read (see `fetchThread`).
 */
async function buildMessages(
  context: SlackTriggerContext & { botToken: string },
  event: SlackMessageEvent & { channel: string; ts: string },
  threadTs: string,
): Promise<ModelMessage[]> {
  const thread = await fetchThread({
    botToken: context.botToken,
    channel: event.channel,
    threadTs,
    limit: THREAD_LIMIT,
  });

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
