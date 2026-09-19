import type { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { baseUrl } from "@/lib/base-url";
import {
  getAgentByInstallState,
  getAgentSlackCredentials,
  markSlackInstalled,
} from "@/lib/agents";
import { refreshSlackConnectionToken } from "@/lib/slack-access";
import { exchangeInstallCode, installReturnTo, revokeInstallation } from "@/lib/slack-install";

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

  // The `state` says where the install was started from: the agent's page
  // or the Slack trigger's, whose next step — picking events — is right there.
  const agentPage = `/app/${agent.id}`;
  const back = installReturnTo(state!) === "trigger" ? `${agentPage}/triggers/slack` : agentPage;

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
  // The agent's Slack tools, if it has any, speak with this token from now on.
  await refreshSlackConnectionToken(agent).catch((error) =>
    console.error(`Could not hand the new bot token to agent ${agent.id}'s Slack connection`, error),
  );
  revalidatePath(agentPage);
  revalidatePath("/app");
  return redirectTo(back, { installed: "1" });
}

function redirectTo(path: string, query?: Record<string, string>) {
  const url = new URL(path, baseUrl());
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return Response.redirect(url, 303);
}
