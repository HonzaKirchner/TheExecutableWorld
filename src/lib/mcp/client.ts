import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { DiscoveredTool, McpConnection } from "@/lib/mcp/connections";
import { DbOAuthClientProvider } from "@/lib/mcp/oauth-provider";

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
 */
export async function connectAndListTools(
  connection: Pick<McpConnection, "id" | "serverUrl">,
): Promise<ConnectResult> {
  const provider = new DbOAuthClientProvider(connection.id);
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
  connection: Pick<McpConnection, "id" | "serverUrl">,
  authorizationCode: string,
) {
  const provider = new DbOAuthClientProvider(connection.id);
  const result = await auth(provider, {
    serverUrl: connection.serverUrl,
    authorizationCode,
  });
  if (result !== "AUTHORIZED") {
    throw new UnauthorizedError("The server asked for another authorization.");
  }
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
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}
