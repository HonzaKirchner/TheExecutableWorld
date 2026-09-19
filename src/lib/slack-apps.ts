import { baseUrl } from "@/lib/base-url";
import { getConfigAccessToken } from "@/lib/slack-config-token";
import { slackPost } from "@/lib/slack";

export type SlackAppCredentials = {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  oauthAuthorizeUrl: string;
};

/**
 * What the agent needs to be a usable coworker: hear mentions, read and write
 * DMs, and look people up. The manifest declares them and the install flow
 * asks for the same list, so the two can't drift apart.
 */
export const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
];

/** display_information.description is capped at 140 characters. */
const DESCRIPTION_MAX = 140;

/**
 * Where Slack sends people after they install an agent. Slack only accepts a
 * redirect_uri that is listed in the manifest, so the install flow imports
 * this rather than spelling the path out a second time.
 */
export const SLACK_INSTALL_REDIRECT_PATH = "/api/slack/install/callback";

/**
 * The events Slack pushes to an agent's webhook. Both are covered by the
 * scopes above (`app_mentions:read`, `im:history`).
 */
export const BOT_EVENTS = ["app_mention", "message.im"];

export async function createSlackApp(input: {
  name: string;
  handle: string;
  persona: string;
  /** Where Slack should deliver events — must be reachable from the internet. */
  eventsUrl: string;
}): Promise<SlackAppCredentials> {
  const token = await getConfigAccessToken();

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

export async function deleteSlackApp(appId: string) {
  const token = await getConfigAccessToken();
  await slackPost("apps.manifest.delete", { token, form: { app_id: appId } });
}

export function buildManifest({
  name,
  handle,
  persona,
  eventsUrl,
}: {
  name: string;
  handle: string;
  persona: string;
  eventsUrl: string;
}) {
  return {
    display_information: {
      name,
      description: truncate(persona, DESCRIPTION_MAX),
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
    },
    oauth_config: {
      scopes: { bot: BOT_SCOPES },
      redirect_urls: [`${baseUrl()}${SLACK_INSTALL_REDIRECT_PATH}`],
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      // Slack verifies the URL with a challenge when the app is created, so
      // the endpoint has to be deployed before agents can be.
      event_subscriptions: {
        request_url: eventsUrl,
        bot_events: BOT_EVENTS,
      },
    },
  };
}

function truncate(value: string, max: number) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
