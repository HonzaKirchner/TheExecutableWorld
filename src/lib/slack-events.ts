import { createHmac, timingSafeEqual } from "node:crypto";

import { slackPost } from "@/lib/slack";

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
  if (!input.timestamp || !input.signature) return false;

  const timestamp = Number(input.timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_AGE_SECONDS) {
    return false;
  }

  const expected = `v0=${createHmac("sha256", input.signingSecret)
    .update(`v0:${input.timestamp}:${input.body}`)
    .digest("hex")}`;

  const a = Buffer.from(expected);
  const b = Buffer.from(input.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The outer object Slack posts. Which fields are present depends on `type`. */
export type SlackEventEnvelope = {
  type: string;
  /** `url_verification` only. */
  challenge?: string;
  /** `event_callback` only. */
  api_app_id?: string;
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
 * the channel's type, and an agent only subscribed to `app_mention` was never
 * granted `channels:history`. Rather than track which of the four scopes
 * applies, ask and accept "no" — the caller falls back to the one message
 * Slack delivered, which is enough to answer with.
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
    return response.messages ?? null;
  } catch {
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
  await slackPost("chat.postMessage", {
    token: input.botToken,
    json: {
      channel: input.channel,
      thread_ts: input.threadTs ?? input.ts,
      text: input.text,
    },
  });
}
