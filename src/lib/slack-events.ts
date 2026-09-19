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
 * Whether an event is a person talking to the agent — as opposed to the
 * agent's own messages echoing back, edits, joins, and the like.
 */
export function isHumanMessage(event: SlackMessageEvent) {
  if (event.bot_id || event.subtype) return false;
  if (event.type === "app_mention") return true;
  return event.type === "message" && event.channel_type === "im";
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

export async function replyInThread(input: {
  botToken: string;
  channel: string;
  /** The message being answered; replies go to its thread. */
  ts: string;
  threadTs?: string;
  text: string;
}) {
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
}
