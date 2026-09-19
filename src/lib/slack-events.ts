import { createHmac, timingSafeEqual } from "node:crypto";

import { debugScope, preview } from "@/lib/log";
import { slackPost } from "@/lib/slack";

const log = debugScope("slack.events");

/** Requests older than this are replayed ones, whatever their signature says. */
const MAX_AGE_SECONDS = 5 * 60;

/**
 * Checks that a request really came from Slack, per
 * https://api.slack.com/authentication/verifying-requests-from-slack:
 * `v0=` + HMAC-SHA256 over `v0:{timestamp}:{raw body}` with the app's
 * signing secret. The body must be the raw bytes, not re-serialised JSON.
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number;
}) {
  if (!input.timestamp || !input.signature) {
    // Not from Slack at all — a browser hitting the URL, or a proxy that
    // strips unknown headers on the way in.
    log("signature: headers missing", {
      timestamp: Boolean(input.timestamp),
      signature: Boolean(input.signature),
    });
    return false;
  }

  const timestamp = Number(input.timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_AGE_SECONDS) {
    // Usually a replayed request — or a machine whose clock has drifted.
    log("signature: timestamp out of range", {
      timestamp: input.timestamp,
      skewSeconds: Number.isFinite(timestamp) ? now - timestamp : undefined,
      maxSeconds: MAX_AGE_SECONDS,
    });
    return false;
  }

  const expected = `v0=${createHmac("sha256", input.signingSecret)
    .update(`v0:${input.timestamp}:${input.body}`)
    .digest("hex")}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  const matches = a.length === b.length && timingSafeEqual(a, b);
  if (!matches) {
    // The secret is the usual culprit: the app was reinstalled, or the one in
    // the database belongs to a different Slack app. A proxy that re-encodes
    // the body would do it too, since the digest covers the raw bytes.
    log("signature: digest mismatch", { bodyBytes: input.body.length });
  }
  return matches;
}

/** The outer object Slack posts. Which fields are present depends on `type`. */
export type SlackEventEnvelope = {
  type: string;
  /** `url_verification` only. */
  challenge?: string;
  /** `event_callback` only. */
  api_app_id?: string;
  /** `event_callback` only. Slack's id for this delivery, stable across retries. */
  event_id?: string;
  team_id?: string;
  event?: SlackMessageEvent;
};

export type SlackMessageEvent = {
  type: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
};

/**
 * Whether an event is a person talking — as opposed to the agent's own
 * messages echoing back, edits, joins, and the like.
 */
export function isHumanMessage(event: SlackMessageEvent) {
  if (event.bot_id || event.subtype) return false;
  return event.type === "app_mention" || event.type === "message";
}

/** Whether `text` mentions `userId`, in either of Slack's two mention forms. */
export function mentionsUser(text: string | undefined, userId: string | null) {
  if (!text || !userId) return false;
  return new RegExp(`<@${userId}(\\|[^>]*)?>`).test(text);
}

/** A message that has a home to reply into. */
export type AnswerableMessage = SlackMessageEvent & { channel: string; ts: string };

export type MessageRouting =
  /** Why the event is none of the agent's business. For the log, not for Slack. */
  | { answer: false; reason: string }
  /** `addressed`: the message named the agent, rather than merely reaching it. */
  | { answer: true; addressed: boolean; event: AnswerableMessage };

/**
 * Whether this event is the agent's to answer.
 *
 * The agent is subscribed to every message in every conversation it is in, so
 * most of what arrives here is other people's. Deciding what to act on is done
 * in code, deterministically, and never by the model: a mention is answered, a
 * DM is answered, and a reply in a thread is a *candidate* — whether the thread
 * began with someone calling on the agent is settled by its root message, which
 * only the caller can see (`answerSlackMessage`).
 *
 * Everything else — a message at the top level of a channel, someone else's
 * thread — is dropped here without a single API call, which is what keeps a
 * busy channel from costing anything.
 */
export function routeMessage(
  event: SlackMessageEvent,
  botUserId: string | null,
): MessageRouting {
  if (!isHumanMessage(event)) {
    return { answer: false, reason: event.bot_id ? "a bot's message" : `subtype ${event.subtype}` };
  }
  if (!event.channel || !event.ts) {
    return { answer: false, reason: "no channel or ts" };
  }
  // Carried through so the caller has the two fields proven present here,
  // rather than asserting them again.
  const answerable: AnswerableMessage = { ...event, channel: event.channel, ts: event.ts };

  // Being named is being spoken to, wherever it happens.
  if (event.type === "app_mention") return { answer: true, addressed: true, event: answerable };
  if (event.channel_type === "im") {
    return { answer: true, addressed: true, event: answerable };
  }

  // From here on it's an ordinary message in a channel, private channel or
  // group DM — the firehose.

  // Slack delivers a mention twice, once as `app_mention` and once as the
  // channel's `message.*`. Answering both would post the reply twice, so the
  // copy that carries the mention is dropped and the `app_mention` above wins.
  if (mentionsUser(event.text, botUserId)) {
    return { answer: false, reason: "already delivered as app_mention" };
  }

  // Without knowing our own user id we can't tell a mention from anything
  // else, which makes both of the rules around this one unsafe. An install
  // from before that id was recorded therefore behaves as it always did:
  // mentions and DMs only.
  if (!botUserId) {
    return { answer: false, reason: "the agent's Slack user id is unknown" };
  }

  // Only replies inside a thread can belong to a conversation the agent was
  // called into. A top-level message starts a thread that nobody has invited
  // the agent to yet.
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return { answer: false, reason: "not a reply in a thread" };
  }

  return { answer: true, addressed: false, event: answerable };
}

/**
 * The messages in a thread, oldest first, so the agent can answer in context
 * rather than treating every message as the first thing it has ever heard.
 *
 * Best effort on purpose: `conversations.replies` needs the history scope for
 * the channel's type. Every agent now asks for all four at install (see
 * `BASE_BOT_SCOPES`), but an app installed before that did not — so rather
 * than track which of the four applies, ask and accept "no". The caller falls
 * back to the one message Slack delivered, which is enough to answer with.
 */
export async function fetchThread(input: {
  botToken: string;
  channel: string;
  threadTs: string;
  limit?: number;
}): Promise<SlackMessageEvent[] | null> {
  try {
    const response = await slackPost<{ ok: boolean; messages?: SlackMessageEvent[] }>(
      "conversations.replies",
      {
        token: input.botToken,
        form: {
          channel: input.channel,
          ts: input.threadTs,
          limit: String(input.limit ?? 50),
        },
      },
    );
    log("thread fetched", {
      channel: input.channel,
      threadTs: input.threadTs,
      messages: response.messages?.length ?? 0,
    });
    return response.messages ?? null;
  } catch (error) {
    // Expected when the app lacks the history scope for this channel type;
    // the caller falls back to the single delivered message.
    log("thread not fetched, falling back to the delivered message", {
      channel: input.channel,
      threadTs: input.threadTs,
      error,
    });
    return null;
  }
}

/** Returns the posted message's `ts`, so a caller can update it later. */
export async function replyInThread(input: {
  botToken: string;
  channel: string;
  /** The message being answered; replies go to its thread. */
  ts: string;
  threadTs?: string;
  text: string;
}): Promise<string | undefined> {
  log("posting reply", {
    channel: input.channel,
    threadTs: input.threadTs ?? input.ts,
    chars: input.text.length,
    text: preview(input.text),
  });
  const response = await slackPost<{ ok: boolean; ts?: string }>("chat.postMessage", {
    token: input.botToken,
    json: {
      channel: input.channel,
      thread_ts: input.threadTs ?? input.ts,
      text: input.text,
    },
  });
  log("reply posted", { channel: input.channel, ts: response.ts });
  return response.ts;
}

/**
 * Rewrites a message already posted with `replyInThread` — how the live
 * progress view and the final answer both land in the same bubble.
 */
export async function updateReply(input: {
  botToken: string;
  channel: string;
  ts: string;
  text: string;
}) {
  await slackPost("chat.update", {
    token: input.botToken,
    json: { channel: input.channel, ts: input.ts, text: input.text },
  });
}

