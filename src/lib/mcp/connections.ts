import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { db, ensureSchema } from "@/lib/db";

/*
 * Connections hang off an agent, and agents are looked up by workspace. None
 * of the functions here re-check the tenant: callers get the agent through
 * `getAgent(workspaceId, agentId)` first and pass its id on, so an agent id
 * from another workspace never gets this far.
 */

export type McpConnectionStatus = "pending" | "authorized";

/**
 * What pages and Server Actions may see. The OAuth material — tokens, the
 * registered client, the PKCE verifier — is read through `loadCredentials`
 * only, so it can't end up in a serialised return value by accident.
 */
export type McpConnection = {
  id: string;
  agentId: string;
  serverId: string;
  serverUrl: string;
  status: McpConnectionStatus;
  toolsSyncedAt: string | null;
  createdAt: string;
};

export type McpConnectionSummary = McpConnection & {
  toolCount: number;
  allowedCount: number;
  approvalCount: number;
};

export type McpTool = {
  name: string;
  title: string | null;
  description: string | null;
  annotations: ToolAnnotations | null;
  allowed: boolean;
  requiresApproval: boolean;
};

/** A tool as the server reports it, before anyone has decided anything. */
export type DiscoveredTool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
};

export type McpCredentials = {
  oauthState: string | null;
  codeVerifier: string | null;
  clientInformation: OAuthClientInformationMixed | null;
  tokens: OAuthTokens | null;
  discovery: OAuthDiscoveryState | null;
};

type ConnectionRow = {
  id: string;
  agent_id: string;
  server_id: string;
  server_url: string;
  status: McpConnectionStatus;
  tools_synced_at: string | null;
  created_at: string;
};

type SummaryRow = ConnectionRow & {
  tool_count: number | string;
  allowed_count: number | string;
  approval_count: number | string;
};

type ToolRow = {
  name: string;
  title: string | null;
  description: string | null;
  annotations: ToolAnnotations | null;
  allowed: boolean;
  requires_approval: boolean;
};

type CredentialsRow = {
  oauth_state: string | null;
  code_verifier: string | null;
  client_information: OAuthClientInformationMixed | null;
  tokens: OAuthTokens | null;
  discovery: OAuthDiscoveryState | null;
};

const CONNECTION_COLUMNS =
  "id, agent_id, server_id, server_url, status, tools_synced_at, created_at";

function toConnection(row: ConnectionRow): McpConnection {
  return {
    id: row.id,
    agentId: row.agent_id,
    serverId: row.server_id,
    serverUrl: row.server_url,
    status: row.status,
    toolsSyncedAt: row.tools_synced_at,
    createdAt: row.created_at,
  };
}

function toTool(row: ToolRow): McpTool {
  return {
    name: row.name,
    title: row.title,
    description: row.description,
    annotations: row.annotations,
    allowed: row.allowed,
    requiresApproval: row.requires_approval,
  };
}

export async function listConnections(
  agentId: string,
): Promise<McpConnectionSummary[]> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select c.id, c.agent_id, c.server_id, c.server_url, c.status,
            c.tools_synced_at, c.created_at,
            count(t.name)                                   as tool_count,
            count(t.name) filter (where t.allowed)          as allowed_count,
            count(t.name) filter (where t.allowed and t.requires_approval)
                                                            as approval_count
     from mcp_connections c
     left join mcp_tools t on t.connection_id = c.id
     where c.agent_id = $1
     group by c.id
     order by c.created_at`,
    [agentId],
  )) as SummaryRow[];

  // count() comes back as bigint, which the driver hands over as a string.
  return rows.map((row) => ({
    ...toConnection(row),
    toolCount: Number(row.tool_count),
    allowedCount: Number(row.allowed_count),
    approvalCount: Number(row.approval_count),
  }));
}

export async function getConnection(
  agentId: string,
  serverId: string,
): Promise<McpConnection | null> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select ${CONNECTION_COLUMNS}
     from mcp_connections
     where agent_id = $1 and server_id = $2
     limit 1`,
    [agentId, serverId],
  )) as ConnectionRow[];

  return rows[0] ? toConnection(rows[0]) : null;
}

/**
 * Resolves the `state` an authorization server sent back. Returns the agent's
 * workspace too, so the callback can check it against the session before
 * doing anything with the code.
 */
export async function getConnectionByState(
  state: string,
): Promise<(McpConnection & { workspaceId: string }) | null> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select c.id, c.agent_id, c.server_id, c.server_url, c.status,
            c.tools_synced_at, c.created_at, a.workspace_id
     from mcp_connections c
     join agents a on a.id = c.agent_id
     where c.oauth_state = $1
     limit 1`,
    [state],
  )) as (ConnectionRow & { workspace_id: string })[];

  const row = rows[0];
  return row ? { ...toConnection(row), workspaceId: row.workspace_id } : null;
}

/**
 * Creates the connection, or returns the existing one. Nothing is reset on
 * the way: a registered client is worth keeping, and the OAuth client sorts
 * out stale tokens itself (refresh, then re-authorize).
 */
export async function upsertConnection(input: {
  agentId: string;
  serverId: string;
  serverUrl: string;
}): Promise<McpConnection> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `insert into mcp_connections (agent_id, server_id, server_url)
     values ($1, $2, $3)
     on conflict (agent_id, server_id) do update
       set server_url = excluded.server_url,
           updated_at = now()
     returning ${CONNECTION_COLUMNS}`,
    [input.agentId, input.serverId, input.serverUrl],
  )) as ConnectionRow[];

  return toConnection(rows[0]);
}

export async function deleteConnection(agentId: string, serverId: string) {
  await ensureSchema();
  const sql = db();
  await sql`
    delete from mcp_connections
    where agent_id = ${agentId} and server_id = ${serverId}
  `;
}

export async function listTools(connectionId: string): Promise<McpTool[]> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql`
    select name, title, description, annotations, allowed, requires_approval
    from mcp_tools
    where connection_id = ${connectionId}
    order by name
  `) as ToolRow[];

  return rows.map(toTool);
}

/**
 * Replaces the cached tool list with what the server just reported. Choices
 * already made about a tool survive; tools the server no longer offers are
 * dropped; new ones start out not allowed, with the approval flag suggested
 * from their annotations.
 */
export async function syncTools(
  connectionId: string,
  tools: DiscoveredTool[],
  suggestApproval: (annotations: ToolAnnotations | undefined) => boolean,
) {
  await ensureSchema();
  const sql = db();

  const incoming = tools.map((tool) => ({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    annotations: tool.annotations ?? null,
    requires_approval: suggestApproval(tool.annotations),
  }));

  // One statement rather than one per tool: the HTTP driver pays a round trip
  // per query, and servers routinely expose dozens of tools.
  await sql.query(
    `insert into mcp_tools (connection_id, name, title, description, annotations, requires_approval)
     select $1, t.name, t.title, t.description, t.annotations, t.requires_approval
     from jsonb_to_recordset($2::jsonb)
       as t(name text, title text, description text, annotations jsonb, requires_approval boolean)
     on conflict (connection_id, name) do update
       set title       = excluded.title,
           description = excluded.description,
           annotations = excluded.annotations`,
    [connectionId, JSON.stringify(incoming)],
  );

  await sql.query(
    `delete from mcp_tools
     where connection_id = $1 and not (name = any($2::text[]))`,
    [connectionId, incoming.map((tool) => tool.name)],
  );

  await sql`
    update mcp_connections
    set status = 'authorized', tools_synced_at = now(), updated_at = now()
    where id = ${connectionId}
  `;
}

/**
 * Records the person's decisions. Tools not in `allowed` are switched off but
 * keep their approval flag: the form doesn't submit it for tools that aren't
 * allowed, and the suggestion should still be there if one is allowed later.
 */
export async function saveToolAccess(
  connectionId: string,
  allowed: Iterable<string>,
  requiresApproval: Iterable<string>,
) {
  await ensureSchema();
  const sql = db();

  await sql.query(
    `update mcp_tools
     set allowed           = name = any($2::text[]),
         requires_approval = case
           when name = any($2::text[]) then name = any($3::text[])
           else requires_approval
         end
     where connection_id = $1`,
    [connectionId, [...allowed], [...requiresApproval]],
  );
}

export async function loadCredentials(
  connectionId: string,
): Promise<McpCredentials> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql`
    select oauth_state, code_verifier, client_information, tokens, discovery
    from mcp_connections
    where id = ${connectionId}
    limit 1
  `) as CredentialsRow[];

  const row = rows[0];
  if (!row) throw new Error(`MCP connection ${connectionId} does not exist`);

  return {
    oauthState: row.oauth_state,
    codeVerifier: row.code_verifier,
    clientInformation: row.client_information,
    tokens: row.tokens,
    discovery: row.discovery,
  };
}

const CREDENTIAL_COLUMNS: Record<keyof McpCredentials, string> = {
  oauthState: "oauth_state",
  codeVerifier: "code_verifier",
  clientInformation: "client_information",
  tokens: "tokens",
  discovery: "discovery",
};

export async function updateCredentials(
  connectionId: string,
  patch: Partial<McpCredentials>,
) {
  await ensureSchema();
  const sql = db();

  const assignments: string[] = [];
  const params: unknown[] = [connectionId];
  for (const key of Object.keys(patch) as (keyof McpCredentials)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    params.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value);
    assignments.push(`${CREDENTIAL_COLUMNS[key]} = $${params.length}`);
  }
  if (assignments.length === 0) return;

  await sql.query(
    `update mcp_connections
     set ${assignments.join(", ")}, updated_at = now()
     where id = $1`,
    params,
  );
}
