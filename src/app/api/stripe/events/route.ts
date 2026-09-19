import type { NextRequest } from "next/server";

import { STRIPE_DEAUTHORIZED_EVENT, verifyStripeSignature, type StripeEvent } from "@/lib/stripe";
import { getStripeEndpointSecret } from "@/lib/stripe-webhook";
import { findStripeTriggers, markStripeDisconnected, recordTriggerEvent } from "@/lib/triggers";

/**
 * The platform's Connect webhook: every connected account's events land
 * here, each naming its account. Stripe wants a 2xx quickly and retries for
 * days otherwise, so this does the minimum — check the signature, find the
 * triggers, note the event — and answers 200 even when there's nothing to do.
 */
export async function POST(request: NextRequest) {
  const secret = await getStripeEndpointSecret();
  if (!secret) {
    return new Response("No webhook endpoint registered.", { status: 404 });
  }

  // The signature covers the raw body, so read it as text before parsing.
  const body = await request.text();
  const valid = verifyStripeSignature({
    secret,
    header: request.headers.get("stripe-signature"),
    body,
  });
  if (!valid) {
    return new Response("Bad signature.", { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Malformed body.", { status: 400 });
  }
  if (typeof event.type !== "string") {
    return new Response("Malformed event.", { status: 400 });
  }

  // Events from the platform's own account have no `account`; none are
  // subscribed, but a stray one shouldn't reach a trigger either.
  if (!event.account) {
    return Response.json({ received: true });
  }

  if (event.type === STRIPE_DEAUTHORIZED_EVENT) {
    await markStripeDisconnected(event.account);
    return Response.json({ received: true });
  }

  const triggers = await findStripeTriggers(event.account, event.type);
  await Promise.all(
    triggers.map((trigger) => recordTriggerEvent(trigger.id, event.type).catch(() => {})),
  );
  if (triggers.length > 0) {
    console.log(
      `Stripe ${event.type} (${event.id}) for ${triggers.length} trigger(s) on ${event.account}`,
    );
  }

  return Response.json({ received: true });
}
