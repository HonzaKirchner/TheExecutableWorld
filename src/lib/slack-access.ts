import { getAgentBotToken, type Agent } from "@/lib/agents";
import { getMcpServer } from "@/lib/mcp/catalog";
import {
  getConnection,
  listTools,
  syncTools,
  updateCredentials,
  upsertConnection,
  type DiscoveredTool,
  type McpConnection,
} from "@/lib/mcp/connections";
import { suggestApproval } from "@/lib/mcp/tools";
import { updateSlackApp, type ManifestInput } from "@/lib/slack-apps";
import { botScopesFor } from "@/lib/slack-events-catalog";
import { SLACK_TOOLS } from "@/lib/slack-tools-catalog";
import { getTrigger, slackEventsUrl } from "@/lib/triggers";

/**
 * Where the agent's Slack app, its trigger and its Slack tools meet.
 *
 * The app is created with every agent and installed once; what the install
 * asks for follows from two choices made later — the events the trigger
 * listens for and the tools the agent may call on this app's Slack MCP
 * server. Both are kept in the app's manifest at Slack, and both are what a
 * reinstall grants — so both can be chosen before the app is installed, and
 * the one install then asks for everything at once. The connection under
 * Access carries no OAuth of its own: its tool list is the catalog, and the
 * bot token is written in whenever an install produces one.
 */

/** Names of the Slack tools the agent is allowed to call; none without a connection. */
export async function allowedSlackTools(agentId: string): Promise<string[]> {
  const connection = await getConnection(agentId, "slack");
  if (!connection) return [];
  return (await listTools(connection.id)).filter((tool) => tool.allowed).map((tool) => tool.name);
}

/**
 * What the manifest should say right now, or with one of its two inputs
 * replaced: `trigger` is the Slack trigger to subscribe with (null for none),
 * `tools` the allowed tool names. Either left out is read from the database.
 */
export type ManifestOverrides = {
  trigger?: { id: string; events: readonly string[] } | null;
  tools?: readonly string[];
};

export async function manifestInputFor(
  agent: Agent,
  overrides: ManifestOverrides = {},
): Promise<ManifestInput> {
  const trigger =
    overrides.trigger === undefined ? await getTrigger(agent.id, "slack") : overrides.trigger;
  const tools = overrides.tools ?? (await allowedSlackTools(agent.id));
  return {
    handle: agent.handle,
    description: agent.description,
    subscription: trigger
      ? { eventsUrl: slackEventsUrl(trigger.id), events: trigger.events }
      : undefined,
    tools,
  };
}

/** The bot scopes the agent's install has to grant for its events and tools. */
export async function requiredBotScopes(agent: Agent, overrides: ManifestOverrides = {}) {
  const input = await manifestInputFor(agent, overrides);
  return botScopesFor(input.subscription?.events ?? [], input.tools);
}

/**
 * Writes the manifest to Slack. Throws what `updateSlackApp` throws — a
 * `SlackConfigTokenError` when the workspace's configuration token is gone,
 * a `SlackApiError` when Slack rejects the manifest — so callers can decide
 * whether the change they were about to store should still be stored.
 */
export async function syncSlackManifest(agent: Agent, overrides: ManifestOverrides = {}) {
  if (!agent.slackAppId) return;
  await updateSlackApp(agent.workspaceId, agent.slackAppId, await manifestInputFor(agent, overrides));
}

/** The catalog in the shape a server would report it — the server reports exactly this. */
export function slackCatalogTools(): DiscoveredTool[] {
  return SLACK_TOOLS.map(({ name, title, description, annotations }) => ({
    name,
    title,
    description,
    annotations,
  }));
}

/**
 * The agent's connection to this app's Slack MCP server, created if need be,
 * with the catalog as its tool list and — once the app is installed — the
 * bot token to speak with. Nothing to authorize and nothing to ask the
 * server: the tools are known, so an agent can be given Slack tools before
 * its app is installed, and the install asks for their scopes.
 */
export async function ensureSlackConnection(agent: Agent): Promise<McpConnection> {
  const server = getMcpServer("slack")!;
  const connection = await upsertConnection({
    agentId: agent.id,
    serverId: server.id,
    serverUrl: server.url,
  });
  const botToken = await getAgentBotToken(agent.id);
  if (botToken) {
    await updateCredentials(connection.id, {
      tokens: { access_token: botToken, token_type: "bearer" },
    });
  }
  await syncTools(connection.id, slackCatalogTools(), suggestApproval);
  return connection;
}

/**
 * After a (re)install: the connection, if there is one, speaks with the token
 * Slack just issued. A reinstall usually returns the same token, but Slack
 * doesn't promise that.
 */
export async function refreshSlackConnectionToken(agent: Agent) {
  const connection = await getConnection(agent.id, "slack");
  if (!connection) return;
  const botToken = await getAgentBotToken(agent.id);
  if (!botToken) return;
  await updateCredentials(connection.id, {
    tokens: { access_token: botToken, token_type: "bearer" },
  });
}
