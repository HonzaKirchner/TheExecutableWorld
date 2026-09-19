import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  SlackApiError,
  slackPost,
  listSlackChannels as listConversations,
  listSlackUsers as listMembers,
} from "@/lib/slack";
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
 * server — and, unlike any other server, before the app is installed: the
 * tool list is the catalog in src/lib/slack-tools-catalog.ts, which is also
 * where each tool's title, description, annotations and bot scopes come
 * from. The install asks for a tool's scopes only once the tool is allowed,
 * so a tool allowed after the install answers `missing_scope` until the app
 * is installed again.
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

/** What the catalog says about a tool; the server adds only the argument schema. */
function meta(name: string) {
  const tool = getSlackTool(name);
  if (!tool) throw new Error(`Slack tool ${name} is not in the catalog.`);
  return { title: tool.title, description: tool.description, annotations: tool.annotations };
}

function createSlackServer() {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "send_message",
    { ...meta("send_message"), inputSchema: {
        channel: z
          .string()
          .regex(SLACK_ID)
          .describe("A channel id (C…/G…/D…) or a person's user id (U…/W…) for a DM."),
        text: z.string().min(1),
        thread_ts: z.string().optional().describe("The ts of the message to reply under."),
      } },
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
    { ...meta("list_channels"), inputSchema: {
        query: z.string().default("").describe("A part of the channel name; empty lists them all."),
        max_results: z.number().int().min(1).max(200).default(50),
      } },
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
    { ...meta("join_channel"), inputSchema: { channel: z.string().regex(SLACK_ID) } },
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
    { ...meta("read_channel"), inputSchema: {
        channel: z.string().regex(SLACK_ID),
        max_results: z.number().int().min(1).max(100).default(20),
        oldest: z.string().optional().describe("Only messages after this ts."),
      } },
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
    { ...meta("read_thread"), inputSchema: {
        channel: z.string().regex(SLACK_ID),
        thread_ts: z.string().describe("The ts of the thread's first message."),
        max_results: z.number().int().min(1).max(200).default(50),
      } },
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
    { ...meta("find_user"), inputSchema: {
        query: z.string().min(1).describe("A part of the person's name or handle."),
        max_results: z.number().int().min(1).max(50).default(10),
      } },
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
    { ...meta("add_reaction"), inputSchema: {
        channel: z.string().regex(SLACK_ID),
        timestamp: z.string().describe("The ts of the message."),
        name: z.string().regex(/^[a-z0-9_+-]+$/),
      } },
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

type RawMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  subtype?: string;
};

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
