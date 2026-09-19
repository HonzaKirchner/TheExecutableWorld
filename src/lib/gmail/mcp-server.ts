import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  buildRawMessage,
  createDraft,
  findHeader,
  getMessage,
  getThread,
  listLabels,
  modifyMessageLabels,
  modifyThreadLabels,
  replySubject,
  searchThreads,
  sendMessage,
  summarizeMessage,
  type OutgoingMessage,
} from "@/lib/gmail/api";
import {
  bearerFromToken,
  GMAIL_SCOPE,
  gmailMcpUrl,
  GOOGLE_ISSUER,
  introspectToken,
  type Bearer,
} from "@/lib/gmail/google";

/**
 * A Gmail MCP server, hosted by this app.
 *
 * Google's own is drafts-only and behind a preview programme, and the point
 * of giving an agent Gmail is usually that it can answer. So this one exists:
 * a Streamable HTTP server whose tools are thin wrappers over the Gmail API,
 * calling it with the bearer token on the request. That token is a Google
 * access token — the server is an OAuth resource whose authorization server
 * is Google (see the protected-resource metadata below), so any MCP client
 * with this deployment's Google client can connect, this app included.
 *
 * Stateless: one server and transport per request, nothing kept between.
 */
export async function handleGmailMcpRequest(request: Request): Promise<Response> {
  const token = bearerToken(request);
  const info = token ? await introspectToken(token) : null;
  if (!token || !info) {
    return unauthorized(token ? "invalid_token" : undefined);
  }

  const authInfo: AuthInfo = {
    token,
    clientId: info.aud,
    scopes: info.scope.split(" "),
    expiresAt: info.exp,
  };

  const server = createGmailServer();
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

/** RFC 9728: who the resource is and who issues tokens for it. */
export function protectedResourceMetadata() {
  return {
    resource: gmailMcpUrl(),
    authorization_servers: [GOOGLE_ISSUER],
    scopes_supported: [GMAIL_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Gmail (Coworkers)",
  };
}

export function protectedResourceMetadataUrl() {
  return `${gmailMcpUrl()}/oauth-protected-resource`;
}

function unauthorized(error?: string) {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl()}"`, `scope="${GMAIL_SCOPE}"`];
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

const SERVER_INFO = { name: "gmail", version: "0.1.0" };

const composeShape = {
  to: z.array(z.string()).optional().describe("Recipient addresses. Optional when replying: the original sender is used."),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional().describe("Optional when replying: 'Re:' plus the original subject is used."),
  body: z.string().describe("Plain-text body."),
  reply_to_message_id: z
    .string()
    .optional()
    .describe("Make this a reply to the given message: same thread, threaded headers."),
};

function createGmailServer() {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "search_threads",
    {
      title: "Search threads",
      description:
        "Find conversations with a Gmail search query (the same syntax as the search box: from:, subject:, newer_than:, is:unread, label:…). Returns the newest message of each thread.",
      inputSchema: {
        query: z.string().default("").describe("Gmail search query. Empty lists the most recent threads."),
        max_results: z.number().int().min(1).max(50).default(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, max_results }, extra) => {
      const bearer = bearerFor(extra.authInfo);
      const threads = await searchThreads(bearer, query, max_results);
      const results = await Promise.all(
        threads.map(async (thread) => {
          const full = await getThread(bearer, thread.id, "metadata");
          const messages = full.messages ?? [];
          const last = messages[messages.length - 1];
          return {
            thread_id: thread.id,
            message_count: messages.length,
            snippet: thread.snippet ?? null,
            latest: last ? summarizeMessage(last, false) : null,
          };
        }),
      );
      return json(results);
    },
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get thread",
      description: "Read a whole conversation: every message with its headers and text.",
      inputSchema: { thread_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ thread_id }, extra) => {
      const thread = await getThread(bearerFor(extra.authInfo), thread_id, "full");
      return json({
        thread_id: thread.id,
        messages: (thread.messages ?? []).map((message) => summarizeMessage(message, true)),
      });
    },
  );

  server.registerTool(
    "get_message",
    {
      title: "Get message",
      description: "Read one message: headers, text and attachment names.",
      inputSchema: { message_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ message_id }, extra) => {
      const message = await getMessage(bearerFor(extra.authInfo), message_id, "full");
      return json(summarizeMessage(message, true));
    },
  );

  server.registerTool(
    "send_email",
    {
      title: "Send email",
      description:
        "Send a plain-text email from the connected account, either fresh or as a reply in an existing thread.",
      inputSchema: composeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input, extra) => {
      const bearer = bearerFor(extra.authInfo);
      const { message, threadId } = await compose(bearer, input);
      const sent = await sendMessage(bearer, buildRawMessage(message), threadId);
      return json({ sent: true, message_id: sent.id, thread_id: sent.threadId, to: message.to, subject: message.subject });
    },
  );

  server.registerTool(
    "create_draft",
    {
      title: "Create draft",
      description: "Save an email as a draft for a person to review and send, instead of sending it.",
      inputSchema: composeShape,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input, extra) => {
      const bearer = bearerFor(extra.authInfo);
      const { message, threadId } = await compose(bearer, input);
      const draft = await createDraft(bearer, buildRawMessage(message), threadId);
      return json({ draft_id: draft.id, message_id: draft.message.id, thread_id: draft.message.threadId, to: message.to, subject: message.subject });
    },
  );

  server.registerTool(
    "list_labels",
    {
      title: "List labels",
      description: "The account's labels, system ones (INBOX, STARRED, UNREAD…) and the person's own.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_input, extra) => {
      const labels = await listLabels(bearerFor(extra.authInfo));
      return json(labels.map(({ id, name, type }) => ({ id, name, type })));
    },
  );

  server.registerTool(
    "modify_labels",
    {
      title: "Modify labels",
      description:
        "Add or remove labels on a message or a whole thread. Removing INBOX archives; removing UNREAD marks as read; adding STARRED stars.",
      inputSchema: {
        message_id: z.string().optional(),
        thread_id: z.string().optional().describe("Applies to every message in the thread."),
        add_label_ids: z.array(z.string()).default([]),
        remove_label_ids: z.array(z.string()).default([]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ message_id, thread_id, add_label_ids, remove_label_ids }, extra) => {
      if (!message_id && !thread_id) return failure("Give a message_id or a thread_id.");
      if (add_label_ids.length === 0 && remove_label_ids.length === 0) {
        return failure("Nothing to change: add_label_ids and remove_label_ids are both empty.");
      }
      const bearer = bearerFor(extra.authInfo);
      if (thread_id) {
        await modifyThreadLabels(bearer, thread_id, add_label_ids, remove_label_ids);
        return json({ thread_id, added: add_label_ids, removed: remove_label_ids });
      }
      const result = await modifyMessageLabels(bearer, message_id!, add_label_ids, remove_label_ids);
      return json({ message_id: result.id, labels: result.labelIds ?? [] });
    },
  );

  return server;
}

/**
 * Turns tool input into a message. For a reply, the original supplies the
 * thread, the threading headers and — unless overridden — the recipient and
 * subject.
 */
async function compose(
  bearer: Bearer,
  input: z.infer<z.ZodObject<typeof composeShape>>,
): Promise<{ message: OutgoingMessage; threadId?: string }> {
  let to = input.to ?? [];
  let subject = input.subject ?? "";
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;

  if (input.reply_to_message_id) {
    const original = await getMessage(bearer, input.reply_to_message_id, "metadata");
    const headers = original.payload?.headers;
    threadId = original.threadId;
    inReplyTo = findHeader(headers, "Message-ID") ?? undefined;
    const previous = findHeader(headers, "References");
    references = [previous, inReplyTo].filter(Boolean).join(" ") || undefined;
    if (to.length === 0) {
      const sender = findHeader(headers, "Reply-To") ?? findHeader(headers, "From");
      if (sender) to = [sender];
    }
    if (!input.subject) subject = replySubject(findHeader(headers, "Subject"));
  }

  if (to.length === 0) throw new Error("No recipient: give `to`, or reply to a message.");

  return {
    message: { to, cc: input.cc, bcc: input.bcc, subject, text: input.body, inReplyTo, references },
    threadId,
  };
}

function bearerFor(authInfo: AuthInfo | undefined) {
  if (!authInfo?.token) throw new Error("No access token on the request.");
  return bearerFromToken(authInfo.token);
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}
