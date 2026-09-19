import { randomBytes } from "node:crypto";

import { baseUrl } from "@/lib/base-url";
import { slackPost } from "@/lib/slack";
import { SLACK_INSTALL_REDIRECT_PATH } from "@/lib/slack-apps";

/**
 * The URL that installs an agent's Slack app. `team` pre-selects the agent's
 * workspace on Slack's side; the callback still checks that the install
 * really landed there.
 */
export function buildInstallUrl(input: {
  clientId: string;
  workspaceId: string;
  state: string;
  /** Must match the manifest's, which follow from the agent's events. */
  scopes: readonly string[];
}) {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", input.scopes.join(","));
  url.searchParams.set("redirect_uri", installRedirectUri());
  url.searchParams.set("state", input.state);
  url.searchParams.set("team", input.workspaceId);
  return url.toString();
}

export function newInstallState() {
  return randomBytes(24).toString("base64url");
}

export type SlackInstallation = {
  botToken: string;
  botUserId: string;
  teamId: string;
  scopes: string[];
};

export async function exchangeInstallCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<SlackInstallation> {
  const response = await slackPost<{
    ok: true;
    access_token: string;
    bot_user_id: string;
    scope: string;
    team: { id: string; name?: string };
  }>("oauth.v2.access", {
    form: {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: installRedirectUri(),
    },
  });

  return {
    botToken: response.access_token,
    botUserId: response.bot_user_id,
    teamId: response.team.id,
    scopes: response.scope.split(","),
  };
}

/** Undoes an install we don't want to keep — e.g. one into the wrong workspace. */
export async function revokeInstallation(botToken: string) {
  await slackPost("auth.revoke", { token: botToken, form: {} });
}

function installRedirectUri() {
  return `${baseUrl()}${SLACK_INSTALL_REDIRECT_PATH}`;
}
