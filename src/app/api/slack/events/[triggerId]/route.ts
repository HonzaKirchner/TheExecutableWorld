import { after, type NextRequest } from "next/server";

import { answerSlackMessage } from "@/lib/agent/slack";
import { debugScope, preview } from "@/lib/log";
import { routeMessage, verifySlackSignature, type SlackEventEnvelope } from "@/lib/slack-events";
import { getSlackTriggerContext, recordTriggerEvent } from "@/lib/triggers";

const log = debugScope("slack.webhook");

/**
 * The whole pipeline — the trigger lookup, the signature check and the agent's
 * run — happens after the response, so all of it has to fit in here. Vercel
 * caps this by plan, so a deployment that allows less will cut a long run short.
 */
export const maxDuration = 300;

/**
 * Slack's Events API calls this for one agent — the trigger id in the path
 * says which.
 *
 * Slack gives the endpoint three seconds and retries on a timeout, and the
 * work behind this URL cannot be made to fit: the trigger lookup alone can
 * take seconds on a cold process, before the agent has even started. So the
 * request does the least it can — read the body, answer the one event that
 * needs an answer in this response — and hands everything else to `after`.
 *
 * The cost of that is deliberate: the 200 goes out before the signature has
 * been checked, so it says "received", not "accepted". Nothing is acted on
 * until `processEvent` has verified the request; an unsigned one just gets a
 * 200 and is dropped a moment later. See `processEvent`.
 */
export async function POST(
  request: NextRequest,
  { params }: RouteContext<"/api/slack/events/[triggerId]">,
) {
  const { triggerId } = await params;

  // The body has to be read here: once the response is sent, the stream is no
  // longer readable. It's also cheap, unlike everything else we used to do
  // first.
  const body = await request.text();
  const retry = request.headers.get("x-slack-retry-num");

  log("request", {
    triggerId,
    bytes: body.length,
    retry,
    retryReason: request.headers.get("x-slack-retry-reason"),
  });

  let envelope: SlackEventEnvelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    log("rejected: malformed body", { triggerId, body: preview(body) });
    return new Response("Malformed body.", { status: 400 });
  }

  // Sent once when the URL is saved into the app's manifest. The challenge has
  // to come back in this response, so this is the one path that can't be
  // deferred — and it answers without checking the signature, since that would
  // mean the slow lookup we're here to avoid. Echoing Slack's own nonce back
  // reveals nothing and changes nothing.
  if (envelope.type === "url_verification" && envelope.challenge) {
    log("url_verification answered (unverified by design)", { triggerId });
    return Response.json({ challenge: envelope.challenge });
  }

  // Now that the 200 is immediate, a retry really does mean what this assumed
  // all along: Slack missed our response, not that the event went unhandled.
  // Answering again would post the reply twice.
  if (retry) {
    log("ignored: retry of an event we already received", {
      triggerId,
      retry,
      reason: request.headers.get("x-slack-retry-reason"),
    });
    return new Response(null, { status: 200 });
  }

  if (envelope.type !== "event_callback") {
    log("ignored: not an event_callback", { triggerId, envelopeType: envelope.type });
    return new Response(null, { status: 200 });
  }

  after(() =>
    processEvent({
      triggerId,
      envelope,
      body,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
    }),
  );

  return new Response(null, { status: 200 });
}

/**
 * Everything that used to happen before the 200. Runs once Slack has its
 * response, so nothing here can change it — a rejection is a log line and
 * nothing else, and a failure that reaches the person does so in the thread.
 */
async function processEvent(input: {
  triggerId: string;
  envelope: SlackEventEnvelope;
  body: string;
  timestamp: string | null;
  signature: string | null;
}) {
  const { triggerId, envelope } = input;

  try {
    const context = await getSlackTriggerContext(triggerId);
    if (!context?.signingSecret) {
      // Either no Slack trigger has this id, or the agent row has no signing
      // secret — which means its Slack app was never finished being set up.
      log("dropped: unknown trigger or no signing secret", {
        triggerId,
        foundTrigger: Boolean(context),
      });
      return;
    }

    // The signature covers the raw bytes, which is why the body is passed
    // through as text rather than re-serialised from `envelope`.
    const valid = verifySlackSignature({
      signingSecret: context.signingSecret,
      timestamp: input.timestamp,
      signature: input.signature,
      body: input.body,
    });
    if (!valid) {
      // `verifySlackSignature` has already said which check failed.
      log("dropped: bad signature", { agent: context.agentHandle, bytes: input.body.length });
      return;
    }

    // The manifest declares which app this URL belongs to, but nothing stops an
    // app with the same signing secret — i.e. this very app — from being the
    // only one that can get here. Check anyway; it's cheap.
    if (context.slackAppId && envelope.api_app_id && envelope.api_app_id !== context.slackAppId) {
      log("dropped: event is for another Slack app", {
        agent: context.agentHandle,
        expected: context.slackAppId,
        received: envelope.api_app_id,
      });
      return;
    }

    const event = envelope.event;
    log("event", {
      agent: context.agentHandle,
      eventId: envelope.event_id,
      type: event?.type,
      subtype: event?.subtype,
      channel: event?.channel,
      channelType: event?.channel_type,
      user: event?.user,
      botId: event?.bot_id,
      ts: event?.ts,
      threadTs: event?.thread_ts,
      text: preview(event?.text, 80),
    });

    if (event?.type) {
      await recordTriggerEvent(context.triggerId, event.type).catch((error) => {
        log("could not record the event on the trigger", { error });
      });
    }

    // The agent hears every message in every conversation it's in, so most of
    // what arrives is other people's. `routeMessage` decides, without calling
    // Slack, which ones are its business.
    if (!event) {
      log("ignored: event_callback with no event", { agent: context.agentHandle });
      return;
    }
    const routing = routeMessage(event, context.botUserId);
    if (!routing.answer) {
      log("ignored", { agent: context.agentHandle, reason: routing.reason });
      return;
    }

    if (!context.botToken) {
      // Slack can only deliver events once the app is installed, so this means
      // the install happened outside the app. Nothing we can say back.
      console.warn(`Agent ${context.agentId} received an event but has no bot token.`);
      return;
    }

    // `answerSlackMessage` handles its own failures — it has to, because the
    // person in the thread is the only one who'd notice.
    await answerSlackMessage(
      { ...context, botToken: context.botToken },
      routing.event,
      routing.addressed,
    );
  } catch (error) {
    // Nothing above is allowed to throw past here. Slack has its 200 and will
    // not retry, so an escaping error would lose the message with no trace
    // beyond an unhandled rejection.
    console.error(`Slack event for trigger ${triggerId} failed`, error);
    log("processing failed", { triggerId, error });
  }
}
