import { db, ensureSchema } from "@/lib/db";

/**
 * A workspace's Stripe account: the one install of this deployment's Stripe
 * App that every agent in the workspace shares. Installing is a Stripe-side
 * grant to the platform, not to an agent, so it happens once; afterwards each
 * agent's Stripe trigger is nothing but the list of event types it wants (see
 * src/lib/triggers.ts), and the events route fans an account's event out to
 * every agent in the account's workspace(s) that asked for its type.
 *
 * `pending`: the workspace has never finished connecting (a state may be in
 * flight). `active`: events flow. `disconnected`: the account uninstalled the
 * app, so Stripe has stopped sending; connecting again brings it back. A
 * re-connect started on an `active` row leaves its status alone until Stripe
 * answers, so an abandoned attempt doesn't take the workspace offline.
 */
export type StripeConnectionStatus = "pending" | "active" | "disconnected";

export type StripeConnection = {
  workspaceId: string;
  /** `acct_…`; null until the first install completes. */
  accountId: string | null;
  livemode: boolean | null;
  status: StripeConnectionStatus;
  connectedAt: string | null;
};

type Row = {
  workspace_id: string;
  account_id: string | null;
  livemode: boolean | null;
  status: StripeConnectionStatus;
  connected_at: string | null;
};

const COLUMNS = "workspace_id, account_id, livemode, status, connected_at";

function toConnection(row: Row): StripeConnection {
  return {
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    livemode: row.livemode,
    status: row.status,
    connectedAt: row.connected_at,
  };
}

/** Whether events from the workspace's account reach its agents right now. */
export function isStripeConnected(
  connection: StripeConnection | null | undefined,
): connection is StripeConnection & { accountId: string } {
  return connection?.status === "active" && Boolean(connection.accountId);
}

/*
 * Callers derive the workspace from the session (pages and Server Actions) or
 * from the `state` / account an outside request carries (the callback and the
 * webhook). The queries here trust the workspace id they're given.
 */

export async function getStripeConnection(workspaceId: string): Promise<StripeConnection | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `select ${COLUMNS} from stripe_connections where workspace_id = $1 limit 1`,
    [workspaceId],
  )) as Row[];
  return rows[0] ? toConnection(rows[0]) : null;
}

/**
 * Remembers the `state` of an install that has just been sent off to Stripe,
 * and the agent whose page it started from, so the callback can land the
 * person back there. A workspace that is already connected keeps its status
 * and account until the new code is exchanged.
 */
export async function startStripeConnection(input: {
  workspaceId: string;
  agentId: string;
  state: string;
}) {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into stripe_connections (workspace_id, oauth_state, oauth_agent_id)
    values (${input.workspaceId}, ${input.state}, ${input.agentId})
    on conflict (workspace_id) do update
      set oauth_state    = excluded.oauth_state,
          oauth_agent_id = excluded.oauth_agent_id,
          updated_at     = now()
  `;
}

/**
 * Resolves the `state` Stripe sent back. The workspace is what the callback
 * checks against the session; the agent is where the person goes afterwards,
 * or null if it was deleted in the meantime.
 */
export async function getStripeConnectionByState(
  state: string,
): Promise<(StripeConnection & { agentId: string | null }) | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `select ${COLUMNS}, oauth_agent_id from stripe_connections where oauth_state = $1 limit 1`,
    [state],
  )) as (Row & { oauth_agent_id: string | null })[];
  const row = rows[0];
  return row ? { ...toConnection(row), agentId: row.oauth_agent_id } : null;
}

export async function markStripeConnected(
  workspaceId: string,
  input: { accountId: string; livemode: boolean },
) {
  await ensureSchema();
  const sql = db();
  await sql`
    update stripe_connections
    set account_id     = ${input.accountId},
        livemode       = ${input.livemode},
        status         = 'active',
        oauth_state    = null,
        oauth_agent_id = null,
        connected_at   = now(),
        updated_at     = now()
    where workspace_id = ${workspaceId}
  `;
}

/**
 * Stripe said the account uninstalled the app. The same account could have
 * been connected to more than one workspace; all of them go quiet.
 */
export async function markStripeAccountDisconnected(accountId: string) {
  await ensureSchema();
  const sql = db();
  await sql`
    update stripe_connections
    set status = 'disconnected', updated_at = now()
    where account_id = ${accountId}
  `;
}

/** The workspace no longer wants the account. Its agents' event lists stay, inert until a reconnect. */
export async function deleteStripeConnection(workspaceId: string) {
  await ensureSchema();
  const sql = db();
  await sql`delete from stripe_connections where workspace_id = ${workspaceId}`;
}

/** Whether another workspace still uses this account — revoking it at Stripe would silence them too. */
export async function countOtherStripeConnections(accountId: string, workspaceId: string) {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select count(*)::int as n from stripe_connections
    where account_id = ${accountId} and workspace_id <> ${workspaceId}
  `) as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** How many of the workspace's agents have a Stripe trigger — what a disconnect would switch off. */
export async function countStripeListeners(workspaceId: string) {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select count(*)::int as n
    from triggers t
    join agents a on a.id = t.agent_id
    where t.kind = 'stripe' and a.workspace_id = ${workspaceId}
  `) as { n: number }[];
  return rows[0]?.n ?? 0;
}
