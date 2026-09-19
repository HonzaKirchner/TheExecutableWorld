import { after, type NextRequest } from "next/server";

import { answerSlackMessage } from "@/lib/agent/slack";
import {
  isHumanMessage,
  verifySlackSignature,
  type SlackEventEnvelope,
} from "@/lib/slack-events";
import { getSlackTriggerContext, recordTriggerEvent } from "@/lib/triggers";

/**
 * The agent's run has to fit in here, and a run that calls a few tools takes
 * far longer than a page render. Vercel caps this by plan, so a deployment
 * that allows less will cut a long run short.
 */
export const maxDuration = 300;

/**
 * Slack's Events API calls this for one agent — the trigger id in the path
 * says which. Slack expects a 200 within three seconds and retries otherwise,
 * so the request itself does nothing but check the signature and accept the
 * event; the agent runs in `after`, once Slack has its 200.
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
  if (event?.type) {
    await recordTriggerEvent(context.triggerId, event.type).catch(() => {});
  }

  // Only a person talking to the agent gets an answer. Other subscribed
  // events (reactions, joins, channel chatter) are received and, for now,
  // left at that.
  if (!event || !isHumanMessage(event) || !event.channel || !event.ts) {
    return new Response(null, { status: 200 });
  }

  if (!context.botToken) {
    // Slack can only deliver events once the app is installed, so this means
    // the install happened outside the app. Nothing we can say back.
    console.warn(`Agent ${context.agentId} received an event but has no bot token.`);
    return new Response(null, { status: 200 });
  }

  // Answer once Slack has its 200. `answerSlackMessage` handles its own
  // failures — it has to, because by now nothing it does can change the
  // response, and the person in the thread is the only one who'd notice.
  const botToken = context.botToken;
  const channel = event.channel;
  const ts = event.ts;
  after(() => answerSlackMessage({ ...context, botToken }, { ...event, channel, ts }));

  return new Response(null, { status: 200 });
}
