import { DESCRIPTION_MAX } from "@/lib/agent-limits";
import { baseUrl } from "@/lib/base-url";
import { withConfigToken } from "@/lib/slack-config-token";
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
  /** Where Slack should deliver events — must be reachable from the internet. */
  eventsUrl: string;
  /** Event ids from the catalog; the bot scopes follow from them. */
  events: readonly string[];
};

export async function createSlackApp(input: ManifestInput): Promise<SlackAppCredentials> {
  const response = await withConfigToken((token) =>
    slackPost<{
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
    }),
  );

  return {
    appId: response.app_id,
    clientId: response.credentials.client_id,
    clientSecret: response.credentials.client_secret,
    signingSecret: response.credentials.signing_secret,
    oauthAuthorizeUrl: response.oauth_authorize_url,
  };
}

export async function deleteSlackApp(appId: string) {
  await withConfigToken((token) =>
    slackPost("apps.manifest.delete", { token, form: { app_id: appId } }),
  );
}

/**
 * Replaces the app's manifest — used when the events change. Slack applies
 * new scopes to the manifest at once, but an installed app only gets them
 * when it is installed again.
 */
export async function updateSlackApp(appId: string, input: ManifestInput) {
  await withConfigToken((token) =>
    slackPost("apps.manifest.update", {
      token,
      form: { app_id: appId, manifest: JSON.stringify(buildManifest(input)) },
    }),
  );
}

export function buildManifest({ handle, description, eventsUrl, events }: ManifestInput) {
  const bot_events = normalizeSlackEvents(events);
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
    },
    oauth_config: {
      scopes: { bot: botScopesFor(bot_events) },
      redirect_urls: [`${baseUrl()}${SLACK_INSTALL_REDIRECT_PATH}`],
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      // Slack verifies the URL with a challenge when the app is created, so
      // the endpoint has to be deployed before agents can be.
      event_subscriptions: {
        request_url: eventsUrl,
        bot_events,
      },
    },
  };
}

function truncate(value: string, max: number) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
