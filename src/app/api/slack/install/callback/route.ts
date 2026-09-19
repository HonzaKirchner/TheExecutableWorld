import type { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { baseUrl } from "@/lib/base-url";
import {
  getAgentByInstallState,
  getAgentSlackCredentials,
  markSlackInstalled,
} from "@/lib/agents";
import { exchangeInstallCode, revokeInstallation } from "@/lib/slack-install";

/**
 * Where Slack sends people after they've installed (or declined to install)
 * an agent's app. The path is listed in every generated app's manifest, so
 * moving it means regenerating the apps.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code");

  const agent = state ? await getAgentByInstallState(state) : null;
  if (!agent) {
    return new Response("Unknown or expired install.", { status: 400 });
  }

  const back = `/app/${agent.id}`;

  const session = await auth();
  if (session?.slack?.teamId !== agent.workspaceId) {
    return new Response("This install belongs to another workspace.", { status: 403 });
  }

  if (params.get("error") || !code) {
    return redirectTo(back, {
      error: params.get("error") === "access_denied" ? "slack_denied" : "slack_failed",
    });
  }

  const credentials = await getAgentSlackCredentials(agent.id);
  if (!credentials) {
    return redirectTo(back, { error: "slack_failed" });
  }

  let installation;
  try {
    installation = await exchangeInstallCode({ ...credentials, code });
  } catch (error) {
    console.error(`Slack install of agent ${agent.id} failed`, error);
    return redirectTo(back, { error: "slack_failed" });
  }

  // `team` on the authorize URL only pre-selects a workspace; Slack lets the
  // person pick another. An agent belongs to exactly one, so don't keep a
  // token for anywhere else.
  if (installation.teamId !== agent.workspaceId) {
    await revokeInstallation(installation.botToken).catch(() => {});
    return redirectTo(back, { error: "slack_wrong_workspace" });
  }

  await markSlackInstalled(agent.id, installation);
  revalidatePath(back);
  revalidatePath("/app");
  return redirectTo(back, { installed: "1" });
}

function redirectTo(path: string, query?: Record<string, string>) {
  const url = new URL(path, baseUrl());
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return Response.redirect(url, 303);
}
