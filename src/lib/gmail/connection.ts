import { getAgentById, type Agent } from "@/lib/agents";
import { getMcpServer } from "@/lib/mcp/catalog";
import { connectAndListTools } from "@/lib/mcp/client";
import {
  copyCredentials,
  deleteConnection,
  findWorkspaceConnection,
  getConnection,
  syncTools,
  upsertConnection,
  type McpConnection,
} from "@/lib/mcp/connections";
import { suggestApproval } from "@/lib/mcp/tools";

/**
 * A Google account is granted to a workspace once.
 *
 * Connections are per agent — the Gmail tools and the Gmail trigger both
 * read the tokens off the agent's own row — but the person shouldn't have to
 * sit through Google's consent screen for every agent they make. So an agent
 * without a Gmail connection takes over the grant another agent of the
 * workspace already holds: its own row is created with a copy of that row's
 * tokens, and checked against Google before anyone relies on it. Only a
 * workspace with no grant at all is sent to Google. Same idea as Slack,
 * where nothing is asked twice; here the second ask is skipped rather than
 * never existing.
 *
 * Google's refresh tokens aren't single-use, so two rows refreshing from the
 * same one is fine. Revoking the account at Google stops every copy at once,
 * which is what a person revoking would expect.
 */

/**
 * The agent's authorized Gmail connection, taking over the workspace's grant
 * if the agent has none of its own. Null when there is nothing to take over
 * — or when what there was no longer works at Google.
 */
export async function ensureGmailConnection(agentId: string): Promise<McpConnection | null> {
  const own = await getConnection(agentId, "gmail");
  if (own?.status === "authorized") return own;

  const agent = await getAgentById(agentId);
  if (!agent) return null;

  const source = await findWorkspaceConnection(agent.workspaceId, "gmail", agentId);
  if (!source) return null;

  const server = getMcpServer("gmail")!;
  const connection =
    own ?? (await upsertConnection({ agentId, serverId: server.id, serverUrl: server.url }));
  await copyCredentials(source.id, connection.id);

  // Prove the copy works before calling it authorized: list the tools with
  // it, which is what a fresh authorization would do next anyway.
  let result;
  try {
    result = await connectAndListTools(connection);
  } catch (error) {
    console.error(`Adopted Gmail grant did not work for agent ${agentId}`, error);
    result = undefined;
  }
  if (result?.status !== "authorized") {
    // Leave no half-made row behind: the person goes to Google instead.
    if (!own) await deleteConnection(agentId, server.id).catch(() => {});
    return null;
  }

  await syncTools(connection.id, result.tools, suggestApproval);
  return { ...connection, status: "authorized" };
}

/**
 * Whether the agent can listen on a Google account without a trip to Google:
 * it has an authorized connection, or another agent of its workspace does.
 * A read only — the taking over happens when the trigger starts.
 */
export async function isGmailAvailable(agent: Agent): Promise<boolean> {
  const own = await getConnection(agent.id, "gmail");
  if (own?.status === "authorized") return true;
  return Boolean(await findWorkspaceConnection(agent.workspaceId, "gmail", agent.id));
}
