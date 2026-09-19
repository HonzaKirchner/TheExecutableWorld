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
      handle        text not null,
      description   text,
      instructions  text,
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

  // The handle is the agent's one identifier, so the separate display name
  // went away. `description` used to hold the instructions; now it is the
  // one-line summary (also the Slack app's description) and the instructions
  // have a column of their own. Agents from before the split are migrated
  // once: their old text becomes the instructions and they get no summary.
  await sql`
    alter table agents
      add column if not exists instructions text
  `;
  await sql`
    update agents
    set instructions = description, description = null
    where instructions is null and description is not null
  `;
  await sql`
    alter table agents drop column if exists name
  `;

  // What the install actually granted. Compared with what the agent's
  // events now require, to tell when a reinstall is due.
  await sql`
    alter table agents
      add column if not exists slack_bot_scopes text[]
  `;

  // Where an agent's tool-approval requests go, and who may decide them. An
  // empty (null) whitelist means anyone in the channel can — the channel
  // itself is the access control until someone asks for narrower.
  await sql`
    alter table agents
      add column if not exists audit_channel_id   text,
      add column if not exists approval_whitelist  text[]
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
      client_information  text,
      tokens              text,
      discovery           jsonb,
      tools_synced_at     timestamptz,
      created_at          timestamptz not null default now(),
      updated_at          timestamptz not null default now(),
      unique (agent_id, server_id)
    )
  `;

  // Servers outside the catalog are connected by URL, so their display name
  // has nowhere else to live. Null for catalog connections.
  await sql`
    alter table mcp_connections
      add column if not exists name text
  `;

  await sql`
    create index if not exists mcp_connections_oauth_state_idx
      on mcp_connections (oauth_state)
      where oauth_state is not null
  `;

  // The registered client, the token pair and the PKCE verifier are stored
  // encrypted (see src/lib/crypto.ts), which makes them opaque text rather
  // than jsonb. `discovery` is public metadata and stays queryable. Rows
  // written before encryption can't be read any more; they go back to
  // `pending`, which makes the person authorize again.
  await sql`
    alter table mcp_connections
      alter column client_information type text using client_information::text,
      alter column tokens type text using tokens::text
  `;
  await sql`
    update mcp_connections
    set client_information = null, tokens = null, code_verifier = null,
        status = 'pending', updated_at = now()
    where (client_information is not null and client_information not like 'enc:v1:%')
       or (tokens is not null and tokens not like 'enc:v1:%')
       or (code_verifier is not null and code_verifier not like 'enc:v1:%')
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

  // A tool that needs approval can also be handed a classifier: Jev decides,
  // per call, whether it's obviously fine (the run goes ahead) or worth a
  // person's attention (it pauses as usual). Off by default — a tool starts
  // out needing a person every time, same as before this existed.
  await sql`
    alter table mcp_tools
      add column if not exists classifier_enabled       boolean not null default false,
      add column if not exists classifier_system_prompt  text,
      add column if not exists classifier_context        text,
      add column if not exists classifier_auto_approve   text,
      add column if not exists classifier_escalate       text
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

  // What the trigger listens for lives in `config` (`{ events: [...] }` for
  // every kind). `account_id` is Gmail's mailbox address (Stripe's account
  // moved to `stripe_connections`, below); `oauth_state` is no longer written;
  // the last event that arrived is the only sign, short of logs, that the
  // webhook works.
  await sql`
    alter table triggers
      add column if not exists config           jsonb not null default '{}'::jsonb,
      add column if not exists status           text not null default 'active',
      add column if not exists account_id       text,
      add column if not exists oauth_state      text,
      add column if not exists last_event_at    timestamptz,
      add column if not exists last_event_type  text
  `;
  await sql`
    create index if not exists triggers_account_idx
      on triggers (kind, account_id)
      where account_id is not null
  `;
  await sql`
    create index if not exists triggers_oauth_state_idx
      on triggers (oauth_state)
      where oauth_state is not null
  `;

  // The platform's one Connect webhook endpoint at Stripe, created by the app
  // the first time a Stripe trigger is saved. Stripe only hands out the
  // signing secret when the endpoint is created, hence the row.
  await sql`
    create table if not exists stripe_webhook_endpoint (
      id              text primary key,
      endpoint_id     text not null,
      url             text not null,
      secret          text not null,
      enabled_events  text[] not null,
      livemode        boolean not null default false,
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )
  `;

  // A workspace's Stripe account: one install of the platform's Stripe App,
  // shared by every agent in the workspace, each of which only picks event
  // types on its trigger. Holds the OAuth `state` of an install in flight and
  // the agent whose page it was started from, so the callback can go back.
  await sql`
    create table if not exists stripe_connections (
      workspace_id    text primary key references workspaces (id) on delete cascade,
      account_id      text,
      livemode        boolean,
      status          text not null default 'pending',
      oauth_state     text,
      oauth_agent_id  uuid references agents (id) on delete set null,
      connected_at    timestamptz,
      created_at      timestamptz not null default now(),
      updated_at      timestamptz not null default now()
    )
  `;
  await sql`
    create index if not exists stripe_connections_account_idx
      on stripe_connections (account_id)
      where account_id is not null
  `;
  await sql`
    create index if not exists stripe_connections_oauth_state_idx
      on stripe_connections (oauth_state)
      where oauth_state is not null
  `;

  // Stripe accounts used to be connected per agent, on the trigger row. Each
  // workspace's newest one becomes its connection; the triggers keep their
  // events and drop the account. Placeholders for installs that were never
  // finished have nothing to carry over. All of it is a no-op once run.
  await sql`
    delete from triggers
    where kind = 'stripe' and account_id is null and status = 'pending'
  `;
  await sql`
    insert into stripe_connections (workspace_id, account_id, status, connected_at)
    select distinct on (a.workspace_id)
           a.workspace_id, t.account_id,
           case when t.status = 'disconnected' then 'disconnected' else 'active' end,
           t.created_at
    from triggers t
    join agents a on a.id = t.agent_id
    where t.kind = 'stripe' and t.account_id is not null
    order by a.workspace_id, t.created_at desc
    on conflict (workspace_id) do nothing
  `;
  await sql`
    update triggers
    set account_id = null, oauth_state = null, status = 'active'
    where kind = 'stripe' and (account_id is not null or status <> 'active')
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
  //
  // One row per workspace: `apps.manifest.create` has no team parameter, so an
  // app is born in whatever workspace its configuration token came from. A
  // single shared pair would create every workspace's agents in ours.
  //
  // Databases from before that go through a rename. Their one `'default'` row
  // held the platform owner's pair and belongs to no workspace we can name
  // here, so it goes; that workspace pastes its own pair like everyone else.
  await sql`
    do $$
    begin
      if to_regclass('public.slack_config_tokens') is not null
         and exists (
           select 1
           from information_schema.columns
           where table_schema = 'public'
             and table_name = 'slack_config_tokens'
             and column_name = 'id'
         )
      then
        delete from slack_config_tokens where id = 'default';
        alter table slack_config_tokens rename column id to workspace_id;
      end if;
    end
    $$
  `;

  await sql`
    create table if not exists slack_config_tokens (
      workspace_id  text primary key references workspaces (id) on delete cascade,
      access_token  text not null,
      refresh_token text not null,
      expires_at    timestamptz not null,
      updated_at    timestamptz not null default now()
    )
  `;

  // The foreign key came with the rename; a renamed table doesn't have it yet.
  // Orphans have to go first, or adding it fails.
  await sql`
    delete from slack_config_tokens
    where workspace_id not in (select id from workspaces)
  `;
  await sql`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conrelid = 'slack_config_tokens'::regclass
          and contype = 'f'
      ) then
        alter table slack_config_tokens
          add constraint slack_config_tokens_workspace_id_fkey
          foreign key (workspace_id) references workspaces (id) on delete cascade;
      end if;
    end
    $$
  `;

  // One run of an agent: something triggered it, it did some things, it
  // finished. The id is the whole of the transcript's address — /s/<id> is
  // readable by anyone who has the link, with no sign-in — so it is a random
  // uuid and nothing about it is guessable from the agent or the workspace.
  await sql`
    create table if not exists agent_sessions (
      id            uuid primary key default gen_random_uuid(),
      agent_id      uuid not null references agents (id) on delete cascade,
      trigger_id    uuid references triggers (id) on delete set null,
      trigger_kind  text not null,
      -- One line for the header: who said what, or which event arrived.
      title         text,
      status        text not null default 'running',
      error         text,
      started_at    timestamptz not null default now(),
      ended_at      timestamptz
    )
  `;

  await sql`
    create index if not exists agent_sessions_agent_idx
      on agent_sessions (agent_id, started_at desc)
  `;

  // The transcript. `seq` is per session and gap-free, which is what makes it
  // a cursor: the live view asks for everything after the highest seq it has.
  // Everything here is served without authentication, so only text meant to be
  // read by whoever holds the link belongs in `body` and `data`.
  await sql`
    create table if not exists agent_session_events (
      session_id  uuid not null references agent_sessions (id) on delete cascade,
      seq         integer not null,
      type        text not null,
      role        text,
      body        text,
      data        jsonb,
      created_at  timestamptz not null default now(),
      primary key (session_id, seq)
    )
  `;

  // A run that's waiting on a human. `resume_messages` is the full
  // conversation up to and including the assistant turn that asked for the
  // gated tool call — the AI SDK's own shape, kept opaque here — so resuming
  // is just handing it back with the decisions appended and calling the model
  // again. `trigger_context` and `reply_context` are what the trigger-specific
  // code (Slack, Stripe, …) needs to pick the run back up and, if there's
  // somewhere to answer, finish it the same way it would have the first time.
  // One row per session: a session is one run, and a run pauses at one place
  // at a time.
  await sql`
    create table if not exists agent_pauses (
      session_id       uuid primary key references agent_sessions (id) on delete cascade,
      agent_id         uuid not null references agents (id) on delete cascade,
      resume_messages  jsonb not null,
      trigger_kind     text not null,
      trigger_context  jsonb not null default '{}'::jsonb,
      reply_context    jsonb,
      created_at       timestamptz not null default now()
    )
  `;

  // One row per tool call a run stopped for. Several can belong to the same
  // pause (the model asked for more than one gated tool in the same step);
  // the run resumes once every row for its session has a decision.
  await sql`
    create table if not exists tool_approvals (
      id                  uuid primary key default gen_random_uuid(),
      session_id          uuid not null references agent_sessions (id) on delete cascade,
      agent_id            uuid not null references agents (id) on delete cascade,
      approval_id         text not null,
      tool_call_id        text not null,
      tool_name           text not null,
      server_name         text not null,
      arguments           jsonb not null default '{}'::jsonb,
      classifier_verdict  text,
      classifier_reason   text,
      status              text not null default 'pending',
      decided_by          text,
      decided_by_name     text,
      note                text,
      slack_channel       text,
      slack_message_ts    text,
      created_at          timestamptz not null default now(),
      decided_at          timestamptz
    )
  `;
  await sql`
    create index if not exists tool_approvals_session_idx on tool_approvals (session_id)
  `;
}
