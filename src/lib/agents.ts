import { db, ensureSchema } from "@/lib/db";
import type { SlackAppCredentials } from "@/lib/slack-apps";

export type Agent = {
  id: string;
  workspaceId: string;
  handle: string;
  /** One line about the coworker — also the Slack app's description. */
  description: string | null;
  /** What the coworker follows. */
  instructions: string | null;
  model: string;
  createdAt: string;
  slackAppId: string | null;
  slackOauthAuthorizeUrl: string | null;
  slackInstalledAt: string | null;
};

type AgentRow = {
  id: string;
  workspace_id: string;
  handle: string;
  description: string | null;
  instructions: string | null;
  model: string;
  created_at: string;
  slack_app_id: string | null;
  slack_oauth_authorize_url: string | null;
  slack_installed_at: string | null;
};

/**
 * Deliberately excludes the Slack client and signing secrets. They are stored
 * for the install flow, and nothing that reaches a page or a Server Action
 * return value should be able to carry them to the client by accident.
 */
const AGENT_COLUMNS =
  "id, workspace_id, handle, description, instructions, model, created_at, slack_app_id, slack_oauth_authorize_url, slack_installed_at";

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    handle: row.handle,
    description: row.description,
    instructions: row.instructions,
    model: row.model,
    createdAt: row.created_at,
    slackAppId: row.slack_app_id,
    slackOauthAuthorizeUrl: row.slack_oauth_authorize_url,
    slackInstalledAt: row.slack_installed_at,
  };
}

/**
 * Records the Slack workspace and the user who just signed in. Called on every
 * sign-in, so it upserts rather than inserts.
 */
export async function initWorkspace(input: {
  workspaceId: string;
  workspaceName?: string;
  workspaceDomain?: string;
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
  userImage?: string | null;
}) {
  await ensureSchema();
  const sql = db();

  await sql`
    insert into workspaces (id, name, domain)
    values (${input.workspaceId}, ${input.workspaceName ?? null}, ${input.workspaceDomain ?? null})
    on conflict (id) do update
      set name   = coalesce(excluded.name, workspaces.name),
          domain = coalesce(excluded.domain, workspaces.domain)
  `;

  await sql`
    insert into workspace_users (id, workspace_id, name, email, image)
    values (
      ${input.userId},
      ${input.workspaceId},
      ${input.userName ?? null},
      ${input.userEmail ?? null},
      ${input.userImage ?? null}
    )
    on conflict (id) do update
      set workspace_id = excluded.workspace_id,
          name         = coalesce(excluded.name, workspace_users.name),
          email        = coalesce(excluded.email, workspace_users.email),
          image        = coalesce(excluded.image, workspace_users.image),
          last_seen_at = now()
  `;
}

export async function listAgents(workspaceId: string): Promise<Agent[]> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select ${AGENT_COLUMNS}
     from agents
     where workspace_id = $1
     order by created_at desc`,
    [workspaceId],
  )) as AgentRow[];

  return rows.map(toAgent);
}

/**
 * Scoped by workspace on purpose: an agent id from another workspace must read
 * as "not found" rather than leaking across tenants.
 */
export async function getAgent(
  workspaceId: string,
  agentId: string,
): Promise<Agent | null> {
  await ensureSchema();
  const sql = db();

  // agents.id is a uuid column, so a non-uuid path segment would make Postgres
  // raise a type error instead of returning an empty result.
  if (!isUuid(agentId)) return null;

  const rows = (await sql.query(
    `select ${AGENT_COLUMNS}
     from agents
     where workspace_id = $1 and id = $2
     limit 1`,
    [workspaceId, agentId],
  )) as AgentRow[];

  return rows[0] ? toAgent(rows[0]) : null;
}

export async function createAgent(input: {
  workspaceId: string;
  handle: string;
  description?: string | null;
  instructions?: string | null;
  model: string;
  slackApp?: SlackAppCredentials;
}): Promise<Agent> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `insert into agents (
       workspace_id, handle, description, instructions, model,
       slack_app_id, slack_client_id, slack_client_secret,
       slack_signing_secret, slack_oauth_authorize_url
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning ${AGENT_COLUMNS}`,
    [
      input.workspaceId,
      input.handle,
      input.description ?? null,
      input.instructions ?? null,
      input.model,
      input.slackApp?.appId ?? null,
      input.slackApp?.clientId ?? null,
      input.slackApp?.clientSecret ?? null,
      input.slackApp?.signingSecret ?? null,
      input.slackApp?.oauthAuthorizeUrl ?? null,
    ],
  )) as AgentRow[];

  return toAgent(rows[0]);
}

/** Removes an agent and, by cascade, its connections and triggers. */
export async function deleteAgent(agentId: string) {
  await ensureSchema();
  const sql = db();
  await sql`delete from agents where id = ${agentId}`;
}

/**
 * Handles are unique per workspace at the database level. Checking first lets
 * us reject a duplicate before spending a Slack app on it — app creation is
 * rate limited and the app would have to be cleaned up by hand.
 */
export async function isHandleTaken(workspaceId: string, handle: string) {
  await ensureSchema();
  const sql = db();

  const rows = (await sql`
    select 1
    from agents
    where workspace_id = ${workspaceId} and lower(handle) = lower(${handle})
    limit 1
  `) as unknown[];

  return rows.length > 0;
}

/**
 * The Slack OAuth client credentials of the agent's app. Kept out of `Agent`
 * on purpose — only the install flow needs them, and it runs on the server.
 * Callers have already scoped the agent by workspace via `getAgent`.
 */
export async function getAgentSlackCredentials(
  agentId: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql`
    select slack_client_id, slack_client_secret
    from agents
    where id = ${agentId}
    limit 1
  `) as { slack_client_id: string | null; slack_client_secret: string | null }[];

  const row = rows[0];
  if (!row?.slack_client_id || !row.slack_client_secret) return null;
  return { clientId: row.slack_client_id, clientSecret: row.slack_client_secret };
}

/** Remembers the `state` of an install that has just been sent off to Slack. */
export async function setSlackInstallState(agentId: string, state: string) {
  await ensureSchema();
  const sql = db();
  await sql`
    update agents
    set slack_install_state = ${state}, updated_at = now()
    where id = ${agentId}
  `;
}

/**
 * Resolves the `state` Slack sent back to the agent being installed. The
 * workspace comes along so the callback can check it against the session.
 */
export async function getAgentByInstallState(state: string): Promise<Agent | null> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select ${AGENT_COLUMNS}
     from agents
     where slack_install_state = $1
     limit 1`,
    [state],
  )) as AgentRow[];

  return rows[0] ? toAgent(rows[0]) : null;
}

export async function markSlackInstalled(
  agentId: string,
  input: { botToken: string; botUserId: string },
) {
  await ensureSchema();
  const sql = db();
  await sql`
    update agents
    set slack_bot_token     = ${input.botToken},
        slack_bot_user_id   = ${input.botUserId},
        slack_installed_at  = now(),
        slack_install_state = null,
        updated_at          = now()
    where id = ${agentId}
  `;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string) {
  return UUID_RE.test(value);
}
