import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { SlackApiError, slackPost } from "@/lib/slack";
import { getSlackTool } from "@/lib/slack-tools-catalog";

/**
 * A Slack MCP server, hosted by this app.
 *
 * Every agent already has a Slack app of its own, installed into the
 * workspace with a bot token. This server turns that token into tools: a
 * Streamable HTTP server whose tools are thin wrappers over Slack's Web API,
 * calling it with the bearer token on the request. The token *is* the bot
 * token — `auth.test` says whether it's good and whose it is — so the agent
 * acts in Slack as itself, and nothing has to be authorized a second time.
 * The connection under Access is seeded with the token by
 * src/lib/slack-access.ts.
 *
 * Which tools may be called is decided per agent under Access, as for any
 * server. Each tool needs bot scopes (src/lib/slack-tools-catalog.ts) that
 * the install asks for only once the tool is allowed, so a tool allowed
 * after the install answers `missing_scope` until the app is installed again.
 *
 * Stateless: one server and transport per request, nothing kept between.
 */
export async function handleSlackMcpRequest(request: Request): Promise<Response> {
  const token = bearerToken(request);
  const identity = token ? await identify(token) : null;
  if (!token || !identity) {
    return unauthorized(token ? "invalid_token" : undefined);
  }

  const authInfo: AuthInfo = {
    token,
    clientId: identity.botId ?? identity.userId,
    scopes: [],
    extra: identity,
  };

  const server = createSlackServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { authInfo });
  } finally {
    await server.close().catch(() => {});
  }
}

type Identity = { teamId: string; userId: string; botId?: string };

/** Whom the token belongs to, or nothing if Slack no longer honours it. */
async function identify(token: string): Promise<Identity | null> {
  try {
    const response = await slackPost<{
      ok: true;
      team_id: string;
      user_id: string;
      bot_id?: string;
    }>("auth.test", { token, form: {} });
    return { teamId: response.team_id, userId: response.user_id, botId: response.bot_id };
  } catch {
    return null;
  }
}

/**
 * No `resource_metadata` in the challenge: there is no authorization server
 * to send a client to. The token comes from installing the agent's app.
 */
function unauthorized(error?: string) {
  const parts = [`realm="slack"`];
  if (error) parts.push(`error="${error}"`);
  return new Response(JSON.stringify({ error: error ?? "unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer ${parts.join(", ")}`,
    },
  });
}

function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

const SERVER_INFO = { name: "slack", version: "0.1.0" };

/** Slack ids: channels (C…), private channels (G…), DMs (D…), people (U…/W…). */
const SLACK_ID = /^[A-Z][A-Z0-9]{5,}$/;

function createSlackServer() {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "send_message",
    {
      title: "Send message",
      description:
        "Post a message as the agent, to a channel it's in or as a direct message to a person. Pass thread_ts to reply in a thread. Text is Slack mrkdwn: *bold*, _italic_, <@U…> to mention.",
      inputSchema: {
        channel: z
          .string()
          .regex(SLACK_ID)
          .describe("A channel id (C…/G…/D…) or a person's user id (U…/W…) for a DM."),
        text: z.string().min(1),
        thread_ts: z.string().optional().describe("The ts of the message to reply under."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withSlack("send_message", async (token, { channel, text, thread_ts }) => {
      const target = await channelFor(token, channel);
      const posted = await slackPost<{ ok: true; channel: string; ts: string }>(
        "chat.postMessage",
        { token, json: { channel: target, text, ...(thread_ts ? { thread_ts } : {}) } },
      );
      return json({ sent: true, channel: posted.channel, ts: posted.ts });
    }),
  );

  server.registerTool(
    "list_channels",
    {
      title: "List channels",
      description:
        "The workspace's public channels and the private ones the agent is in, with whether it's a member of each. Filter by a part of the name.",
      inputSchema: {
        query: z.string().default("").describe("A part of the channel name; empty lists them all."),
        max_results: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    withSlack("list_channels", async (token, { query, max_results }) => {
      const needle = query.trim().toLowerCase().replace(/^#/, "");
      const channels = await listConversations(token);
      const matching = channels
        .filter((channel) => !needle || channel.name?.toLowerCase().includes(needle))
        .slice(0, max_results)
        .map((channel) => ({
          id: channel.id,
          name: channel.name ?? null,
          private: channel.is_private ?? false,
          member: channel.is_member ?? false,
          members: channel.num_members ?? null,
          topic: channel.topic?.value || null,
          purpose: channel.purpose?.value || null,
        }));
      return json(matching);
    }),
  );

  server.registerTool(
    "join_channel",
    {
      title: "Join channel",
      description:
        "Join a public channel so the agent can read and post there. Private channels need a person to invite the agent.",
      inputSchema: { channel: z.string().regex(SLACK_ID) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withSlack("join_channel", async (token, { channel }) => {
      const joined = await slackPost<{ ok: true; channel: { id: string; name?: string } }>(
        "conversations.join",
        { token, form: { channel } },
      );
      return json({ joined: true, channel: joined.channel.id, name: joined.channel.name ?? null });
    }),
  );

  server.registerTool(
    "read_channel",
    {
      title: "Read channel",
      description:
        "The latest messages in a channel the agent is in, newest first. Threads show only their first message; use read_thread for the replies.",
      inputSchema: {
        channel: z.string().regex(SLACK_ID),
        max_results: z.number().int().min(1).max(100).default(20),
        oldest: z.string().optional().describe("Only messages after this ts."),
      },
      annotations: { readOnlyHint: true },
    },
    withSlack("read_channel", async (token, { channel, max_results, oldest }) => {
      const history = await slackPost<{ ok: true; messages?: RawMessage[] }>(
        "conversations.history",
        {
          token,
          form: { channel, limit: String(max_results), ...(oldest ? { oldest } : {}) },
        },
      );
      return json((history.messages ?? []).map(summarizeMessage));
    }),
  );

  server.registerTool(
    "read_thread",
    {
      title: "Read thread",
      description: "Every message in a thread, oldest first, starting with the one it hangs off.",
      inputSchema: {
        channel: z.string().regex(SLACK_ID),
        thread_ts: z.string().describe("The ts of the thread's first message."),
        max_results: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    withSlack("read_thread", async (token, { channel, thread_ts, max_results }) => {
      const replies = await slackPost<{ ok: true; messages?: RawMessage[] }>(
        "conversations.replies",
        { token, form: { channel, ts: thread_ts, limit: String(max_results) } },
      );
      return json((replies.messages ?? []).map(summarizeMessage));
    }),
  );

  server.registerTool(
    "find_user",
    {
      title: "Find user",
      description:
        "Look people up by name, handle or display name. Returns their ids, for mentioning them or sending a DM.",
      inputSchema: {
        query: z.string().min(1).describe("A part of the person's name or handle."),
        max_results: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    withSlack("find_user", async (token, { query, max_results }) => {
      const needle = query.trim().toLowerCase().replace(/^@/, "");
      const members = await listMembers(token);
      const matching = members
        .filter((member) => !member.deleted && !member.is_bot && member.id !== "USLACKBOT")
        .filter((member) =>
          [member.name, member.real_name, member.profile?.display_name, member.profile?.real_name]
            .filter((text): text is string => typeof text === "string")
            .some((text) => text.toLowerCase().includes(needle)),
        )
        .slice(0, max_results)
        .map((member) => ({
          id: member.id,
          handle: member.name ?? null,
          name: member.profile?.real_name || member.real_name || null,
          display_name: member.profile?.display_name || null,
          title: member.profile?.title || null,
          timezone: member.tz ?? null,
        }));
      return json(matching);
    }),
  );

  server.registerTool(
    "add_reaction",
    {
      title: "Add reaction",
      description: "React to a message with an emoji, by its name without colons (e.g. eyes, white_check_mark).",
      inputSchema: {
        channel: z.string().regex(SLACK_ID),
        timestamp: z.string().describe("The ts of the message."),
        name: z.string().regex(/^[a-z0-9_+-]+$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withSlack("add_reaction", async (token, { channel, timestamp, name }) => {
      await slackPost("reactions.add", { token, form: { channel, timestamp, name } });
      return json({ reacted: true });
    }),
  );

  return server;
}

/**
 * Wraps a tool so Slack's refusals come back as tool errors the model can
 * act on rather than as thrown exceptions. `missing_scope` gets the fuller
 * explanation, because the fix is a person's, not the agent's.
 */
function withSlack<A>(
  toolName: string,
  run: (token: string, args: A) => Promise<CallToolResult>,
): (args: A, extra: { authInfo?: AuthInfo }) => Promise<CallToolResult> {
  return async (args, extra) => {
    const token = extra.authInfo?.token;
    if (!token) return failure("No Slack token on this request.");
    try {
      return await run(token, args);
    } catch (error) {
      if (!(error instanceof SlackApiError)) throw error;
      return failure(describeRefusal(toolName, error));
    }
  };
}

function describeRefusal(toolName: string, error: SlackApiError) {
  switch (error.code) {
    case "missing_scope": {
      const scopes = getSlackTool(toolName)?.scopes.join(", ");
      return (
        `Slack refused: the agent's app wasn't installed with the permission this tool needs` +
        `${scopes ? ` (${scopes})` : ""}. A person has to reinstall the app from the agent's page.`
      );
    }
    case "not_in_channel":
      return "Slack refused: the agent isn't in that channel. Join it first (join_channel), or ask a person to invite it.";
    case "channel_not_found":
      return "Slack refused: no channel with that id, or the agent can't see it.";
    case "user_not_found":
    case "users_not_found":
      return "Slack refused: no person with that id.";
    case "already_reacted":
      return "The agent has already reacted to that message with this emoji.";
    case "invalid_name":
      return "Slack refused: there's no emoji with that name in the workspace.";
    default:
      return `Slack refused: ${error.code}.`;
  }
}

/** A DM target given as a user id becomes the DM channel with that person. */
async function channelFor(token: string, channelOrUser: string) {
  if (!/^[UW]/.test(channelOrUser)) return channelOrUser;
  const opened = await slackPost<{ ok: true; channel: { id: string } }>("conversations.open", {
    token,
    form: { users: channelOrUser },
  });
  return opened.channel.id;
}

type RawChannel = {
  id: string;
  name?: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
};

type RawMember = {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  tz?: string;
  profile?: { display_name?: string; real_name?: string; title?: string };
};

type RawMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
};

/** Slack pages at most this far through a list. Workspaces bigger than this get the first pages. */
const MAX_PAGES = 5;

async function listConversations(token: string) {
  return paginate<RawChannel>(token, "conversations.list", "channels", {
    types: "public_channel,private_channel",
    exclude_archived: "true",
  });
}

async function listMembers(token: string) {
  return paginate<RawMember>(token, "users.list", "members", {});
}

async function paginate<T>(
  token: string,
  method: string,
  key: string,
  form: Record<string, string>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await slackPost<{
      ok: true;
      response_metadata?: { next_cursor?: string };
      [key: string]: unknown;
    }>(method, { token, form: { ...form, limit: "200", ...(cursor ? { cursor } : {}) } });
    const batch = response[key];
    if (Array.isArray(batch)) items.push(...(batch as T[]));
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return items;
}

function summarizeMessage(message: RawMessage) {
  return {
    ts: message.ts ?? null,
    user: message.user ?? null,
    bot: Boolean(message.bot_id),
    text: message.text ?? "",
    thread_ts: message.thread_ts ?? null,
    replies: message.reply_count ?? 0,
    ...(message.subtype ? { subtype: message.subtype } : {}),
  };
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
