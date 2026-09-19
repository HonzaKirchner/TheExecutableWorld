import type { NextRequest } from "next/server";

import {
  isHumanMessage,
  replyInThread,
  verifySlackSignature,
  type SlackEventEnvelope,
} from "@/lib/slack-events";
import { getSlackTriggerContext } from "@/lib/triggers";

/**
 * Slack's Events API calls this for one agent — the trigger id in the path
 * says which. Slack expects a 200 within three seconds and retries otherwise,
 * so the work here is kept to: check the signature, answer the challenge,
 * reply in the thread.
 */
export async function POST(
  request: NextRequest,
  { params }: RouteContext<"/api/slack/events/[triggerId]">,
) {
  const { triggerId } = await params;
  const context = await getSlackTriggerContext(triggerId);
  if (!context?.signingSecret) {
    return new Response("Unknown trigger.", { status: 404 });
  }

  // The signature covers the raw body, so read it as text before parsing.
  const body = await request.text();
  const valid = verifySlackSignature({
    signingSecret: context.signingSecret,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    body,
  });
  if (!valid) {
    return new Response("Bad signature.", { status: 401 });
  }

  let envelope: SlackEventEnvelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    return new Response("Malformed body.", { status: 400 });
  }

  // Sent once when the URL is saved into the app's manifest.
  if (envelope.type === "url_verification" && envelope.challenge) {
    return Response.json({ challenge: envelope.challenge });
  }

  // A retry means our first response was late, not that the reply is missing —
  // answering again would post it twice.
  if (request.headers.get("x-slack-retry-num")) {
    return new Response(null, { status: 200 });
  }

  if (envelope.type !== "event_callback") {
    return new Response(null, { status: 200 });
  }

  // The manifest declares which app this URL belongs to, but nothing stops an
  // app with the same signing secret — i.e. this very app — from being the
  // only one that can get here. Check anyway; it's cheap.
  if (context.slackAppId && envelope.api_app_id && envelope.api_app_id !== context.slackAppId) {
    return new Response("Wrong app.", { status: 403 });
  }

  const event = envelope.event;
  if (!event || !isHumanMessage(event) || !event.channel || !event.ts) {
    return new Response(null, { status: 200 });
  }

  if (!context.botToken) {
    // Slack can only deliver events once the app is installed, so this means
    // the install happened outside the app. Nothing we can say back.
    console.warn(`Agent ${context.agentId} received an event but has no bot token.`);
    return new Response(null, { status: 200 });
  }

  try {
    await replyInThread({
      botToken: context.botToken,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts,
      text: `Hi, I'm @${context.agentHandle}. I heard you — answering properly is my next lesson.`,
    });
  } catch (error) {
    // Still 200: Slack would otherwise retry, and the failure is ours to fix.
    console.error(`Agent ${context.agentId} failed to reply`, error);
  }

  return new Response(null, { status: 200 });
}
