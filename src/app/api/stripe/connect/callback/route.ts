import type { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { baseUrl } from "@/lib/base-url";
import { exchangeStripeCode } from "@/lib/stripe";
import { getStripeConnectionByState, markStripeConnected } from "@/lib/stripe-connections";
import { syncStripeEndpoint } from "@/lib/stripe-webhook";

/**
 * Where Stripe Connect sends people back to. The `state` finds the workspace
 * the install was started for — and the agent whose page it was started from,
 * which is where the person lands again; the session has to belong to that
 * workspace before the code is used. The install is the workspace's: from
 * here on every agent in it picks Stripe events without installing again.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code");

  const connection = state ? await getStripeConnectionByState(state) : null;
  if (!connection) {
    return new Response("Unknown or expired connection.", { status: 400 });
  }

  const back = connection.agentId ? `/app/${connection.agentId}/triggers/stripe` : "/app";

  const session = await auth();
  if (session?.slack?.teamId !== connection.workspaceId) {
    return new Response("This connection belongs to another workspace.", { status: 403 });
  }

  if (params.get("error") || !code) {
    return redirectTo(back, {
      error: params.get("error") === "access_denied" ? "stripe_denied" : "stripe_failed",
    });
  }

  let account;
  try {
    account = await exchangeStripeCode(code);
  } catch (error) {
    console.error(`Stripe connection for workspace ${connection.workspaceId} failed`, error);
    return redirectTo(back, { error: "stripe_failed" });
  }

  await markStripeConnected(connection.workspaceId, account);
  // The shared endpoint subscribes to everything, so it can exist before
  // anyone has picked events. Saving events retries if this fails.
  await syncStripeEndpoint().catch((error) =>
    console.error("Could not register the Stripe webhook endpoint", error),
  );
  if (connection.agentId) revalidatePath(`/app/${connection.agentId}`);
  return redirectTo(back, { connected: "1" });
}

function redirectTo(path: string, query?: Record<string, string>) {
  const url = new URL(path, baseUrl());
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return Response.redirect(url, 303);
}
