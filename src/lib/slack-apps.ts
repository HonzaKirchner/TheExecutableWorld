import { DESCRIPTION_MAX } from "@/lib/agent-limits";
import { baseUrl } from "@/lib/base-url";
import { getConfigAccessToken } from "@/lib/slack-config-token";
import { botScopesFor, normalizeSlackEvents } from "@/lib/slack-events-catalog";
import { slackPost } from "@/lib/slack";

export type SlackAppCredentials = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  oauthAuthorizeUrl: string;
};

/**
 * Where Slack sends people after they install an agent. Slack only accepts a
 * redirect_uri that is listed in the manifest, so the install flow imports
 * this rather than spelling the path out a second time.
 */
export const SLACK_INSTALL_REDIRECT_PATH = "/api/slack/install/callback";

export type ManifestInput = {
  handle: string;
  /** One line about the coworker; becomes the app's description. */
  description: string | null;
  /**
   * The agent's Slack trigger, if it has one: where Slack should deliver
   * events — reachable from the internet — and which. Without it the app
   * subscribes to nothing; it can still post, as its tools do.
   */
  subscription?: {
    eventsUrl: string;
    /** Event ids from the catalog; the bot scopes follow from them. */
    events: readonly string[];
  };
  /** Names of the Slack tools the agent may call; their scopes are asked for too. */
  tools: readonly string[];
  /**
   * Where Slack sends button clicks and modal submissions — the approval
   * flow's own request URL, separate from events. Undefined before the agent
   * has an id to build it from (see `createSlackApp`'s caller).
   */
  interactivityUrl?: string;
};

/**
 * Creates the agent's Slack app *in `workspaceId`*. Which workspace that is
 * follows entirely from the configuration token — `apps.manifest.create` has
 * no team parameter — so the workspace is passed in to fetch the right pair,
 * not to be sent to Slack.
 */
export async function createSlackApp(
  workspaceId: string,
  input: ManifestInput,
): Promise<SlackAppCredentials> {
  const token = await getConfigAccessToken(workspaceId);

  const response = await slackPost<{
    ok: true;
    app_id: string;
    credentials: {
      client_id: string;
      client_secret: string;
      signing_secret: string;
      verification_token: string;
    };
    oauth_authorize_url: string;
  }>("apps.manifest.create", {
    token,
    // The manifest goes over as a JSON *string*, not as a nested object.
    form: { manifest: JSON.stringify(buildManifest(input)) },
  });

  return {
    appId: response.app_id,
    clientId: response.credentials.client_id,
    clientSecret: response.credentials.client_secret,
    signingSecret: response.credentials.signing_secret,
    oauthAuthorizeUrl: response.oauth_authorize_url,
  };
}

export async function deleteSlackApp(workspaceId: string, appId: string) {
  const token = await getConfigAccessToken(workspaceId);
  await slackPost("apps.manifest.delete", { token, form: { app_id: appId } });
}

/**
 * Replaces the app's manifest — used when the events or the allowed tools
 * change. Slack applies new scopes to the manifest at once, but an installed
 * app only gets them when it is installed again.
 */
export async function updateSlackApp(
  workspaceId: string,
  appId: string,
  input: ManifestInput,
) {
  const token = await getConfigAccessToken(workspaceId);
  await slackPost("apps.manifest.update", {
    token,
    form: { app_id: appId, manifest: JSON.stringify(buildManifest(input)) },
  });
}

export function buildManifest({
  handle,
  description,
  subscription,
  tools,
  interactivityUrl,
}: ManifestInput) {
  const bot_events = subscription ? normalizeSlackEvents(subscription.events) : [];
  return {
    display_information: {
      // The handle is the agent's one name — in Slack's app list as well.
      name: handle,
      ...(description
        ? { description: truncate(description, DESCRIPTION_MAX) }
        : {}),
    },
    features: {
      bot_user: {
        display_name: handle,
        always_online: true,
      },
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      ...(interactivityUrl
        ? { interactivity: { is_enabled: true, request_url: interactivityUrl } }
        : {}),
    },
    oauth_config: {
      scopes: { bot: botScopesFor(bot_events, tools) },
      redirect_urls: [`${baseUrl()}${SLACK_INSTALL_REDIRECT_PATH}`],
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      // Slack verifies the URL with a challenge when it lands in the
      // manifest, so the endpoint has to be deployed before an agent can
      // subscribe to events.
      ...(subscription
        ? {
            event_subscriptions: {
              request_url: subscription.eventsUrl,
              bot_events,
            },
          }
        : {}),
    },
  };
}

function truncate(value: string, max: number) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
