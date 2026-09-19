import { neon } from "@neondatabase/serverless";

/**
 * Neon HTTP client. One round trip per query, no connection to keep alive,
 * which is what we want on Vercel's serverless functions.
 *
 * Created lazily so that importing this module (e.g. from the route gate in
 * src/proxy.ts) doesn't throw when the connection string isn't configured.
 */
let client: ReturnType<typeof neon> | null = null;

export function db() {
  if (client) return client;

  const connectionString = process.env.DB_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("DB_CONNECTION_STRING is not set");
  }
  if (connectionString === "[sensitive]") {
    // `vercel env pull` writes this placeholder for variables marked Sensitive
    // in Vercel. Fail with the cause rather than a confusing driver error.
    throw new Error(
      'DB_CONNECTION_STRING is the literal string "[sensitive]". ' +
        "`vercel env pull` cannot read Sensitive variables — put the real value " +
        "in .env.development.local, which env:pull does not overwrite.",
    );
  }

  client = neon(connectionString);
  return client;
}

/**
 * Creates the schema if it isn't there yet. Idempotent, and memoised so we pay
 * for it at most once per server process rather than on every sign-in.
 */
let schemaReady: Promise<void> | null = null;

export function ensureSchema() {
  schemaReady ??= createSchema().catch((error) => {
    // Don't cache a failure — the next caller should be able to retry.
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function createSchema() {
  const sql = db();

  await sql`
    create table if not exists workspaces (
      id          text primary key,
      name        text,
      domain      text,
      created_at  timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists workspace_users (
      id            text primary key,
      workspace_id  text not null references workspaces (id) on delete cascade,
      name          text,
      email         text,
      image         text,
      created_at    timestamptz not null default now(),
      last_seen_at  timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists agents (
      id            uuid primary key default gen_random_uuid(),
      workspace_id  text not null references workspaces (id) on delete cascade,
      name          text not null,
      handle        text not null,
      description   text,
      model         text not null,
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now()
    )
  `;

  // Handles are how you'll address an agent, so they must be unique per
  // workspace — but only within a workspace, not globally.
  await sql`
    create unique index if not exists agents_workspace_handle_idx
      on agents (workspace_id, lower(handle))
  `;

  await sql`
    create index if not exists agents_workspace_idx on agents (workspace_id)
  `;

  // Every agent is backed by its own Slack app. The credentials Slack hands
  // back are what the install flow will need, so they live next to the agent.
  //
  // Added after `agents` shipped, hence the ALTERs: `create table if not
  // exists` above is a no-op for databases that already have the table.
  await sql`
    alter table agents
      add column if not exists slack_app_id            text,
      add column if not exists slack_client_id         text,
      add column if not exists slack_client_secret     text,
      add column if not exists slack_signing_secret    text,
      add column if not exists slack_oauth_authorize_url text,
      add column if not exists slack_installed_at      timestamptz
  `;

  // Installing the app gives us a bot token for the workspace. The install
  // state is the OAuth `state` parameter of an install that is in flight.
  await sql`
    alter table agents
      add column if not exists slack_bot_token      text,
      add column if not exists slack_bot_user_id    text,
      add column if not exists slack_install_state  text
  `;

  // One row per (agent, MCP server) the agent has been pointed at. Everything
  // the OAuth client needs to come back later lives here: the registered
  // client, the token pair, the PKCE verifier and `state` of an authorization
  // that is in flight, and the discovered endpoints so they aren't re-fetched.
  await sql`
    create table if not exists mcp_connections (
      id                  uuid primary key default gen_random_uuid(),
      agent_id            uuid not null references agents (id) on delete cascade,
      server_id           text not null,
      server_url          text not null,
      status              text not null default 'pending',
      oauth_state         text,
      code_verifier       text,
      client_information  jsonb,
      tokens              jsonb,
      discovery           jsonb,
      tools_synced_at     timestamptz,
      created_at          timestamptz not null default now(),
      updated_at          timestamptz not null default now(),
      unique (agent_id, server_id)
    )
  `;

  await sql`
    create index if not exists mcp_connections_oauth_state_idx
      on mcp_connections (oauth_state)
      where oauth_state is not null
  `;

  // The tools a connection last reported, plus what the person decided about
  // each: whether the agent may call it at all, and whether a call has to be
  // approved by a human first.
  await sql`
    create table if not exists mcp_tools (
      connection_id      uuid not null references mcp_connections (id) on delete cascade,
      name               text not null,
      title              text,
      description        text,
      annotations        jsonb,
      allowed            boolean not null default false,
      requires_approval  boolean not null default true,
      primary key (connection_id, name)
    )
  `;

  // What makes an agent act. One row per (agent, kind); the row's id is the
  // path segment of the webhook the outside service calls.
  await sql`
    create table if not exists triggers (
      id          uuid primary key default gen_random_uuid(),
      agent_id    uuid not null references agents (id) on delete cascade,
      kind        text not null,
      created_at  timestamptz not null default now(),
      unique (agent_id, kind)
    )
  `;

  // Every agent gets a Slack trigger. Agents created before triggers existed
  // get theirs here — though their Slack apps were made without event
  // subscriptions, so Slack won't call the webhook until the app is recreated.
  await sql`
    insert into triggers (agent_id, kind)
    select a.id, 'slack'
    from agents a
    where not exists (
      select 1 from triggers t where t.agent_id = a.id and t.kind = 'slack'
    )
  `;

  // App configuration tokens expire after 12 hours and each rotation
  // invalidates the previous refresh token, so the current pair has to be
  // persisted rather than kept in memory or in the environment.
  await sql`
    create table if not exists slack_config_tokens (
      id            text primary key,
      access_token  text not null,
      refresh_token text not null,
      expires_at    timestamptz not null,
      updated_at    timestamptz not null default now()
    )
  `;
}
