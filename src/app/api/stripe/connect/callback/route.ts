import type { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { exchangeStripeCode } from "@/lib/stripe";
import { getTriggerByOAuthState, markStripeConnected } from "@/lib/triggers";

/**
 * Where Stripe Connect sends people back to. The `state` finds the trigger
 * (and so the agent) the connection was started for; the session has to
 * belong to that agent's workspace before the code is used.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code");

  const trigger = state ? await getTriggerByOAuthState(state) : null;
  if (!trigger) {
    return new Response("Unknown or expired connection.", { status: 400 });
  }

  const back = `/app/${trigger.agentId}/triggers/stripe`;

  const session = await auth();
  if (session?.slack?.teamId !== trigger.workspaceId) {
    return new Response("This connection belongs to another workspace.", { status: 403 });
  }

  if (params.get("error") || !code) {
    return redirectTo(request, back, {
      error: params.get("error") === "access_denied" ? "stripe_denied" : "stripe_failed",
    });
  }

  let account;
  try {
    account = await exchangeStripeCode(code);
  } catch (error) {
    console.error(`Stripe connection for agent ${trigger.agentId} failed`, error);
    return redirectTo(request, back, { error: "stripe_failed" });
  }

  await markStripeConnected(trigger.id, account.accountId);
  revalidatePath(`/app/${trigger.agentId}`);
  return redirectTo(request, back, { connected: "1" });
}

function redirectTo(request: NextRequest, path: string, query?: Record<string, string>) {
  const url = new URL(path, request.nextUrl.origin);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return Response.redirect(url, 303);
}
