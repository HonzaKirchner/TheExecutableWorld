import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { serverOAuthOptions } from "@/lib/mcp/catalog";
import type { DiscoveredTool, McpConnection } from "@/lib/mcp/connections";
import { DbOAuthClientProvider } from "@/lib/mcp/oauth-provider";
import type { McpReturnTo } from "@/lib/mcp/return-to";

const CLIENT_INFO = { name: "coworkers", version: "0.1.0" };

export type ConnectResult =
  | { status: "authorized"; tools: DiscoveredTool[] }
  | { status: "redirect"; url: URL };

/**
 * Connects to the server and lists its tools — or, when the server wants the
 * person to authorize first, hands back the URL to send them to.
 *
 * Stored tokens are used if there are any; the SDK refreshes them when the
 * server says they've expired, and only falls back to a redirect when that
 * fails too. So a connection that was authorized once keeps working here
 * until the person revokes it on the server's side.
 *
 * `returnTo` is where the callback should land the person if they are sent
 * off; the caller handles the no-redirect case itself.
 */
export async function connectAndListTools(
  connection: Pick<McpConnection, "id" | "serverId" | "serverUrl">,
  { returnTo = "access" }: { returnTo?: McpReturnTo } = {},
): Promise<ConnectResult> {
  const provider = new DbOAuthClientProvider(
    connection.id,
    serverOAuthOptions(connection.serverId),
    returnTo,
  );
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(connection.serverUrl), {
    authProvider: provider,
  });

  try {
    await client.connect(transport);
  } catch (error) {
    if (error instanceof UnauthorizedError && provider.authorizationUrl) {
      return { status: "redirect", url: provider.authorizationUrl };
    }
    throw error;
  }

  try {
    return { status: "authorized", tools: await listAllTools(client) };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Exchanges the authorization code the server sent back for tokens. They're
 * saved by the provider on the way; the next `connectAndListTools` uses them.
 */
export async function finishAuthorization(
  connection: Pick<McpConnection, "id" | "serverId" | "serverUrl">,
  authorizationCode: string,
) {
  const provider = new DbOAuthClientProvider(connection.id, serverOAuthOptions(connection.serverId));
  const result = await auth(provider, {
    serverUrl: connection.serverUrl,
    authorizationCode,
  });
  if (result !== "AUTHORIZED") {
    throw new UnauthorizedError("The server asked for another authorization.");
  }
}

/**
 * A connection held open for the length of an agent run, so the tools it
 * offers can be listed once and then called as many times as the run needs.
 *
 * `connectAndListTools` above is the configure-time counterpart: it connects,
 * looks, and hangs up. Callers here must `close()`, which is why `runAgent`
 * opens sessions in a `try`/`finally`.
 */
export type McpSession = {
  serverId: string;
  listTools: () => Promise<DiscoveredTool[]>;
  callTool: (name: string, args: unknown) => Promise<CallToolResult>;
  close: () => Promise<void>;
};

/**
 * Opens a session on an already-authorized connection. Unlike the configure
 * time path this never redirects: a run has no person in front of it, so an
 * expired authorization that the SDK cannot refresh is simply an error. The
 * server's options still matter here — a refresh needs the pre-registered
 * client, and a server with no authorization at all should say so.
 */
export async function openMcpSession(
  connection: Pick<McpConnection, "id" | "serverId" | "serverUrl">,
): Promise<McpSession> {
  const provider = new DbOAuthClientProvider(connection.id, serverOAuthOptions(connection.serverId));
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(connection.serverUrl), {
    authProvider: provider,
  });

  await client.connect(transport);

  return {
    serverId: connection.serverId,
    listTools: () => listAllTools(client),
    callTool: (name, args) =>
      client.callTool({
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      }) as Promise<CallToolResult>,
    close: () => client.close().catch(() => {}),
  };
}

async function listAllTools(client: Client): Promise<DiscoveredTool[]> {
  const tools: DiscoveredTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const tool of page.tools) {
      tools.push({
        name: tool.name,
        // `title` moved from annotations onto the tool itself; servers built
        // against older SDKs still put it in the old place.
        title: tool.title ?? tool.annotations?.title,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: tool.inputSchema,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}
