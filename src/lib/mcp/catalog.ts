import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";

import { baseUrl } from "@/lib/base-url";

/**
 * The MCP servers an agent can be given access to.
 *
 * All of them speak Streamable HTTP and authorize with OAuth. Most let the
 * client register itself dynamically, which is what lets one deployment
 * connect to any of them without someone pre-registering it by hand. The ones
 * that don't (GitHub, Google) take a pre-registered client from the environment.
 *
 * `id` is what gets stored, so treat it as permanent. The URL is copied onto
 * the connection at connect time, so changing one here only affects new ones.
 *
 * Servers not in the catalog can still be connected: see the `custom-`
 * connections at the bottom of this file.
 */
export type McpServerDefinition = {
  id: string;
  name: string;
  description: string;
  url: string;
  /**
   * Names of the env vars holding a pre-registered OAuth client, for servers
   * that don't support dynamic registration. The callback URL registered with
   * them has to be `<base URL>/api/mcp/callback`.
   */
  clientEnv?: { id: string; secret: string };
  /**
   * Extra query parameters for the authorization request. Google hands out a
   * refresh token only when asked with `access_type=offline`.
   */
  authorizationParams?: Record<string, string>;
  /**
   * Whether to send the RFC 8707 `resource` parameter. Off for authorization
   * servers that predate it and might balk at a parameter they don't know.
   */
  resourceIndicator?: boolean;
};

/** The path of the Gmail MCP server this app hosts (src/lib/gmail/mcp-server.ts). */
export const GMAIL_MCP_PATH = "/api/mcp/gmail";

export const MCP_SERVERS: readonly McpServerDefinition[] = [
  {
    id: "apify",
    name: "Apify",
    description:
      "Run Actors from Apify Store — scrapers, crawlers and automations — and read their results.",
    url: "https://mcp.apify.com",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and update pages and databases.",
    url: "https://mcp.notion.com/mcp",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests and code search.",
    url: "https://api.githubcopilot.com/mcp/",
    clientEnv: { id: "GITHUB_MCP_CLIENT_ID", secret: "GITHUB_MCP_CLIENT_SECRET" },
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, search, send and label mail in a connected Google account.",
    // Served by this very app, so the URL follows the deployment.
    get url() {
      return `${baseUrl()}${GMAIL_MCP_PATH}`;
    },
    clientEnv: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
    authorizationParams: { access_type: "offline", prompt: "consent" },
    resourceIndicator: false,
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects and cycles.",
    url: "https://mcp.linear.app/mcp",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Issues, errors and performance data from your projects.",
    url: "https://mcp.sentry.dev/mcp",
  },
];

/**
 * How many catalog entries get a card up front; everything after these is
 * tucked behind "show more". Custom servers are added from a button instead.
 */
export const FEATURED_COUNT = 4;

export const FEATURED_SERVERS = MCP_SERVERS.slice(0, FEATURED_COUNT);
export const MORE_SERVERS = MCP_SERVERS.slice(FEATURED_COUNT);

export function getMcpServer(id: string) {
  return MCP_SERVERS.find((server) => server.id === id);
}

/**
 * The client to present to a server that wants one registered in advance, or
 * `undefined` for servers that register clients dynamically.
 */
export function preregisteredClient(serverId: string): OAuthClientInformationMixed | undefined {
  const server = getMcpServer(serverId);
  if (!server?.clientEnv) return undefined;
  const clientId = process.env[server.clientEnv.id];
  const clientSecret = process.env[server.clientEnv.secret];
  if (!clientId || !clientSecret) return undefined;
  return { client_id: clientId, client_secret: clientSecret };
}

/** What the OAuth client needs to know about a server beyond its URL. */
export type ServerOAuthOptions = {
  preregistered?: OAuthClientInformationMixed;
  authorizationParams?: Record<string, string>;
  resourceIndicator?: boolean;
};

export function serverOAuthOptions(serverId: string): ServerOAuthOptions {
  const server = getMcpServer(serverId);
  return {
    preregistered: preregisteredClient(serverId),
    authorizationParams: server?.authorizationParams,
    resourceIndicator: server?.resourceIndicator,
  };
}

/**
 * Why a catalog server can't be connected right now, if it can't: the one
 * case is a server that needs a pre-registered client the deployment doesn't
 * have. The message is for whoever runs the deployment, so it names the vars.
 */
export function connectionBlocker(server: McpServerDefinition) {
  if (!server.clientEnv || preregisteredClient(server.id)) return undefined;
  return (
    `${server.name} doesn't register clients dynamically. Create an OAuth app there ` +
    `and set ${server.clientEnv.id} and ${server.clientEnv.secret}.`
  );
}

/*
 * Custom servers: any Streamable HTTP MCP server, by URL. They get a
 * connection row like catalog servers do, with a generated `server_id` and
 * the name the person gave them stored alongside.
 */

export const CUSTOM_SERVER_PREFIX = "custom-";

/** Longest name a custom server may be given. */
export const CUSTOM_SERVER_NAME_MAX = 40;

export function isCustomServerId(id: string) {
  return id.startsWith(CUSTOM_SERVER_PREFIX);
}

export function newCustomServerId() {
  // Short and URL-safe: it becomes a path segment.
  return CUSTOM_SERVER_PREFIX + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** A connected or connectable server as pages show it, catalog or custom. */
export type McpServerInfo = {
  id: string;
  name: string;
  description: string;
  url: string;
  custom: boolean;
};

export function describeCatalogServer(server: McpServerDefinition): McpServerInfo {
  return { ...server, custom: false };
}

/**
 * What to show for a stored connection. Catalog connections take their name
 * and description from the catalog; custom ones from the row. `undefined`
 * for a server id the catalog dropped.
 */
export function describeConnection(connection: {
  serverId: string;
  serverUrl: string;
  name: string | null;
}): McpServerInfo | undefined {
  const server = getMcpServer(connection.serverId);
  if (server) return describeCatalogServer(server);
  if (!isCustomServerId(connection.serverId)) return undefined;
  return {
    id: connection.serverId,
    name: connection.name ?? hostOf(connection.serverUrl),
    description: connection.serverUrl,
    url: connection.serverUrl,
    custom: true,
  };
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
