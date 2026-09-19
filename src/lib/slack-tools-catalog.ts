/**
 * The tools the app's own Slack MCP server offers (src/lib/slack-mcp-server.ts),
 * and the bot scopes each one needs. Client-safe: no I/O, so the pages that
 * show scopes can import it alongside the events catalog.
 *
 * The server calls Slack as the agent's own app, with the bot token its
 * install granted. That install asks only for what the agent's events and
 * *allowed* tools need (see `botScopesFor`), so allowing a tool here can mean
 * the app has to be installed again — the same rule as for events.
 */
export type SlackToolDefinition = {
  name: string;
  scopes: readonly string[];
};

export const SLACK_TOOLS: readonly SlackToolDefinition[] = [
  // chat:write and im:write are base scopes; listed so the mapping is complete.
  { name: "send_message", scopes: ["chat:write", "im:write"] },
  { name: "list_channels", scopes: ["channels:read", "groups:read"] },
  { name: "join_channel", scopes: ["channels:join"] },
  { name: "read_channel", scopes: ["channels:history", "groups:history"] },
  { name: "read_thread", scopes: ["channels:history", "groups:history"] },
  { name: "find_user", scopes: ["users:read"] },
  { name: "add_reaction", scopes: ["reactions:write"] },
];

export function getSlackTool(name: string) {
  return SLACK_TOOLS.find((tool) => tool.name === name);
}

/** The bot scopes these tools need, unknown names ignored. */
export function slackToolScopes(names: Iterable<string>): string[] {
  const scopes = new Set<string>();
  for (const name of names) {
    for (const scope of getSlackTool(name)?.scopes ?? []) scopes.add(scope);
  }
  return [...scopes];
}
