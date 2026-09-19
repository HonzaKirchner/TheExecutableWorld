import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * The tools the app's own Slack MCP server offers (src/lib/slack-mcp-server.ts),
 * with the bot scopes each one needs. Client-safe: no I/O, so the pages that
 * show scopes can import it alongside the events catalog.
 *
 * This is the server's tool list, written down: the server registers exactly
 * these, taking their titles, descriptions and annotations from here. That is
 * what lets an agent be given Slack tools before its app is installed —
 * listing them needs no bot token, because there is nothing to ask the
 * server that this file doesn't already say. Only the argument schemas live
 * in the server, and a run lists those from it anyway.
 *
 * The server calls Slack as the agent's own app, with the bot token its
 * install granted. That install asks only for what the agent's events and
 * *allowed* tools need (see `botScopesFor`), so allowing a tool here can mean
 * the app has to be installed again — the same rule as for events.
 */
export type SlackToolDefinition = {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  scopes: readonly string[];
};

export const SLACK_TOOLS: readonly SlackToolDefinition[] = [
  {
    name: "send_message",
    title: "Send message",
    description:
      "Post a message as the agent, to a channel it's in or as a direct message to a person. Pass thread_ts to reply in a thread. Text is Slack mrkdwn: *bold*, _italic_, <@U…> to mention.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    // chat:write and im:write are base scopes; listed so the mapping is complete.
    scopes: ["chat:write", "im:write"],
  },
  {
    name: "list_channels",
    title: "List channels",
    description:
      "The workspace's public channels and the private ones the agent is in, with whether it's a member of each. Filter by a part of the name.",
    annotations: { readOnlyHint: true },
    scopes: ["channels:read", "groups:read"],
  },
  {
    name: "join_channel",
    title: "Join channel",
    description:
      "Join a public channel so the agent can read and post there. Private channels need a person to invite the agent.",
    annotations: { readOnlyHint: false, destructiveHint: false },
    scopes: ["channels:join"],
  },
  {
    name: "read_channel",
    title: "Read channel",
    description:
      "The latest messages in a channel the agent is in, newest first. Threads show only their first message; use read_thread for the replies.",
    annotations: { readOnlyHint: true },
    scopes: ["channels:history", "groups:history"],
  },
  {
    name: "read_thread",
    title: "Read thread",
    description: "Every message in a thread, oldest first, starting with the one it hangs off.",
    annotations: { readOnlyHint: true },
    scopes: ["channels:history", "groups:history"],
  },
  {
    name: "find_user",
    title: "Find user",
    description:
      "Look people up by name, handle or display name. Returns their ids, for mentioning them or sending a DM.",
    annotations: { readOnlyHint: true },
    scopes: ["users:read"],
  },
  {
    name: "add_reaction",
    title: "Add reaction",
    description:
      "React to a message with an emoji, by its name without colons (e.g. eyes, white_check_mark).",
    annotations: { readOnlyHint: false, destructiveHint: false },
    scopes: ["reactions:write"],
  },
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
