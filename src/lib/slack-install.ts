import { randomBytes } from "node:crypto";

import { getAgentSlackCredentials, setSlackInstallState, type Agent } from "@/lib/agents";
import { baseUrl } from "@/lib/base-url";
import { slackPost } from "@/lib/slack";
import { SLACK_INSTALL_REDIRECT_PATH, updateSlackApp } from "@/lib/slack-apps";
import { botScopesFor, DEFAULT_SLACK_EVENTS } from "@/lib/slack-events-catalog";
import { getTrigger, slackEventsUrl } from "@/lib/triggers";

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

/**
 * Where the callback sends the person once Slack is done: the agent's page
 * (the install panel lives there) or the Slack trigger's page, where picking
 * events is the next step. It rides inside `state`, which Slack returns
 * verbatim, so nothing else has to remember it — and a `state` from before
 * this existed still resolves, to the agent's page.
 */
export type InstallReturnTo = "agent" | "trigger";

const RETURN_TO_VALUES: readonly InstallReturnTo[] = ["agent", "trigger"];

export function newInstallState(returnTo: InstallReturnTo = "agent") {
  return `${randomBytes(24).toString("base64url")}.${returnTo}`;
}

export function installReturnTo(state: string): InstallReturnTo {
  const suffix = state.slice(state.lastIndexOf(".") + 1);
  return isReturnTo(suffix) ? suffix : "agent";
}

/** For form fields: anything but a known value means the agent's page. */
export function parseInstallReturnTo(value: unknown): InstallReturnTo {
  return isReturnTo(value) ? value : "agent";
}

function isReturnTo(value: unknown): value is InstallReturnTo {
  return typeof value === "string" && (RETURN_TO_VALUES as readonly string[]).includes(value);
}

/**
 * Records a fresh install `state` on the agent and returns the URL to send
 * the person to. The scopes asked for have to match the manifest's, which
 * follow from the events the agent's Slack trigger listens for.
 */
export async function startSlackInstall(agent: Agent, returnTo: InstallReturnTo) {
  const credentials = await getAgentSlackCredentials(agent.id);
  if (!credentials) {
    throw new Error("This agent has no Slack app to install.");
  }

  const trigger = await getTrigger(agent.id, "slack");
  const events = trigger?.events ?? DEFAULT_SLACK_EVENTS;
  const scopes = botScopesFor(events);

  // Slack grants only what the app's own configuration lists, and that was
  // written when the app was created — so an app made before a scope was added
  // to the catalog would send the person all the way to Slack just to be told
  // the scope is invalid. Pushing the manifest first makes installing (or
  // reinstalling) the cure for any drift between the app and what this code
  // now asks for, which is exactly what the "needs new permissions" panel
  // tells people to do.
  if (agent.slackAppId && trigger) {
    await updateSlackApp(agent.workspaceId, agent.slackAppId, {
      handle: agent.handle,
      description: agent.description,
      eventsUrl: slackEventsUrl(trigger.id),
      events,
    });
  }

  const state = newInstallState(returnTo);
  await setSlackInstallState(agent.id, state);
  return buildInstallUrl({
    clientId: credentials.clientId,
    workspaceId: agent.workspaceId,
    state,
    scopes,
  });
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
