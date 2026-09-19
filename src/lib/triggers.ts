import { decryptOptional } from "@/lib/crypto";
import { db, ensureSchema } from "@/lib/db";
import { publicBaseUrl } from "@/lib/base-url";

/**
 * The kinds of trigger an agent can have. Each one is a webhook that an OAuth
 * app somewhere else calls: Slack's Events API for the agent's own Slack app,
 * Stripe's Connect webhook for a Stripe account the person connects, Gmail's
 * push notifications (via Pub/Sub) for a mailbox the agent has been given.
 */
export type TriggerKind = "slack" | "stripe" | "gmail";

export type TriggerDefinition = {
  id: TriggerKind;
  name: string;
  description: string;
  /** Added to every agent without asking. */
  automatic: boolean;
};

export const TRIGGERS: readonly TriggerDefinition[] = [
  {
    id: "slack",
    name: "Slack",
    description: "Runs when someone @mentions the agent or sends it a direct message.",
    automatic: true,
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Runs on payment events — a refund, a failed charge, a new subscription.",
    automatic: false,
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Runs when an email lands in the inbox of the connected Google account.",
    automatic: false,
  },
];

export function isTriggerKind(value: string): value is TriggerKind {
  return TRIGGERS.some((definition) => definition.id === value);
}

export function getTriggerDefinition(kind: TriggerKind) {
  return TRIGGERS.find((definition) => definition.id === kind)!;
}

/**
 * `active`: events flow. `pending`: a Stripe connection is waiting for the
 * person to come back from Stripe. `disconnected`: the account revoked the
 * platform's access (Stripe told us so; Google refused to refresh).
 */
export type TriggerStatus = "active" | "pending" | "disconnected";

export type Trigger = {
  id: string;
  agentId: string;
  kind: TriggerKind;
  status: TriggerStatus;
  /** Event ids the trigger listens for — Slack event names or Stripe event types. */
  events: string[];
  /** Stripe: the connected account (`acct_…`). Gmail: the mailbox's address. */
  accountId: string | null;
  /** Gmail: where in the mailbox's history the next notification picks up. */
  historyId: string | null;
  /** Gmail: when the watch lapses unless renewed. */
  watchExpiresAt: string | null;
  lastEventAt: string | null;
  lastEventType: string | null;
  createdAt: string;
};

type TriggerRow = {
  id: string;
  agent_id: string;
  kind: TriggerKind;
  status: TriggerStatus;
  config: { events?: unknown; historyId?: unknown; expiration?: unknown } | null;
  account_id: string | null;
  last_event_at: string | null;
  last_event_type: string | null;
  created_at: string;
};

const TRIGGER_COLUMNS =
  "id, agent_id, kind, status, config, account_id, last_event_at, last_event_type, created_at";

function toTrigger(row: TriggerRow): Trigger {
  const events = row.config?.events;
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    status: row.status,
    events: Array.isArray(events) ? events.filter((e): e is string => typeof e === "string") : [],
    accountId: row.account_id,
    historyId: typeof row.config?.historyId === "string" ? row.config.historyId : null,
    watchExpiresAt: expirationToIso(row.config?.expiration),
    lastEventAt: row.last_event_at,
    lastEventType: row.last_event_type,
    createdAt: row.created_at,
  };
}

/** Gmail reports the watch expiry as epoch milliseconds in a string. */
function expirationToIso(value: unknown) {
  const ms = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** Gmail: whether the watch has run out, so notifications have stopped until it's renewed. */
export function gmailWatchLapsed(trigger: Trigger, now = Date.now()) {
  return Boolean(trigger.watchExpiresAt && Date.parse(trigger.watchExpiresAt) < now);
}

/** The URL Slack calls for this trigger. Its id is the only thing in the path. */
export function slackEventsUrl(triggerId: string) {
  return `${publicBaseUrl()}/api/slack/events/${triggerId}`;
}

/*
 * As with MCP connections, callers scope the agent by workspace first; the
 * queries here trust the agent id they're given.
 */

export async function listTriggers(agentId: string): Promise<Trigger[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `select ${TRIGGER_COLUMNS} from triggers where agent_id = $1 order by created_at`,
    [agentId],
  )) as TriggerRow[];
  return rows.map(toTrigger);
}

export async function getTrigger(agentId: string, kind: TriggerKind): Promise<Trigger | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `select ${TRIGGER_COLUMNS} from triggers where agent_id = $1 and kind = $2 limit 1`,
    [agentId, kind],
  )) as TriggerRow[];
  return rows[0] ? toTrigger(rows[0]) : null;
}

/**
 * The id may be chosen by the caller: the Slack app's manifest has to carry
 * the webhook URL before the agent — and so the trigger — can be inserted.
 */
export async function createTrigger(input: {
  id?: string;
  agentId: string;
  kind: TriggerKind;
  events: readonly string[];
  status?: TriggerStatus;
}): Promise<Trigger> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `insert into triggers (id, agent_id, kind, status, config)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5::jsonb)
     returning ${TRIGGER_COLUMNS}`,
    [
      input.id ?? null,
      input.agentId,
      input.kind,
      input.status ?? "active",
      JSON.stringify({ events: [...input.events] }),
    ],
  )) as TriggerRow[];
  return toTrigger(rows[0]);
}

export async function updateTriggerEvents(triggerId: string, events: readonly string[]) {
  await ensureSchema();
  const sql = db();
  await sql.query(
    `update triggers
     set config = jsonb_set(config, '{events}', $2::jsonb)
     where id = $1`,
    [triggerId, JSON.stringify([...events])],
  );
}

export async function deleteTrigger(triggerId: string) {
  await ensureSchema();
  const sql = db();
  await sql`delete from triggers where id = ${triggerId}`;
}

/** Remembers the `state` of a Stripe connection that has just been started. */
export async function setTriggerOAuthState(triggerId: string, state: string) {
  await ensureSchema();
  const sql = db();
  await sql`update triggers set oauth_state = ${state}, status = 'pending' where id = ${triggerId}`;
}

/**
 * Resolves the `state` Stripe sent back. The workspace comes along so the
 * callback can check it against the session.
 */
export async function getTriggerByOAuthState(
  state: string,
): Promise<(Trigger & { workspaceId: string }) | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `select t.id, t.agent_id, t.kind, t.status, t.config, t.account_id,
            t.last_event_at, t.last_event_type, t.created_at, a.workspace_id
     from triggers t
     join agents a on a.id = t.agent_id
     where t.oauth_state = $1
     limit 1`,
    [state],
  )) as (TriggerRow & { workspace_id: string })[];
  const row = rows[0];
  return row ? { ...toTrigger(row), workspaceId: row.workspace_id } : null;
}

export async function markStripeConnected(triggerId: string, accountId: string) {
  await ensureSchema();
  const sql = db();
  await sql`
    update triggers
    set account_id = ${accountId}, status = 'active', oauth_state = null
    where id = ${triggerId}
  `;
}

/** Stripe said the account disconnected from the platform. */
export async function markStripeDisconnected(accountId: string) {
  await ensureSchema();
  const sql = db();
  await sql`
    update triggers
    set status = 'disconnected'
    where kind = 'stripe' and account_id = ${accountId}
  `;
}

/**
 * The triggers a Stripe event is for: those on the account it came from that
 * listen for its type. Several agents can watch the same account.
 */
export async function findStripeTriggers(accountId: string, eventType: string): Promise<Trigger[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `select ${TRIGGER_COLUMNS}
     from triggers
     where kind = 'stripe' and status = 'active' and account_id = $1
       and config->'events' ? $2`,
    [accountId, eventType],
  )) as TriggerRow[];
  return rows.map(toTrigger);
}

/*
 * Gmail. One watch per mailbox; the trigger remembers the address it's for,
 * where in the history it got to, and when the watch has to be renewed.
 */

export async function markGmailWatching(
  triggerId: string,
  input: { email: string; historyId: string; expiration: string },
) {
  await ensureSchema();
  const sql = db();
  await sql.query(
    `update triggers
     set account_id = $2, status = 'active',
         config = config || jsonb_build_object('historyId', $3::text, 'expiration', $4::text)
     where id = $1`,
    [triggerId, input.email, input.historyId, input.expiration],
  );
}

/** A renewal moves the expiry only: the history position must not jump. */
export async function updateGmailWatchExpiration(triggerId: string, expiration: string) {
  await ensureSchema();
  const sql = db();
  await sql.query(
    `update triggers set config = jsonb_set(config, '{expiration}', to_jsonb($2::text)) where id = $1`,
    [triggerId, expiration],
  );
}

export async function updateGmailHistoryId(triggerId: string, historyId: string) {
  await ensureSchema();
  const sql = db();
  await sql.query(
    `update triggers set config = jsonb_set(config, '{historyId}', to_jsonb($2::text)) where id = $1`,
    [triggerId, historyId],
  );
}

/** The triggers a Gmail notification is for. Several agents can share a mailbox. */
export async function findGmailTriggers(email: string): Promise<Trigger[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `select ${TRIGGER_COLUMNS}
     from triggers
     where kind = 'gmail' and status = 'active' and lower(account_id) = lower($1)`,
    [email],
  )) as TriggerRow[];
  return rows.map(toTrigger);
}

export async function listActiveGmailTriggers(): Promise<Trigger[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `select ${TRIGGER_COLUMNS} from triggers where kind = 'gmail' and status = 'active'`,
  )) as TriggerRow[];
  return rows.map(toTrigger);
}

/** Whether any other agent still listens to this mailbox — stopping the watch would silence it too. */
export async function countOtherGmailTriggers(email: string, agentId: string) {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select count(*)::int as n from triggers
    where kind = 'gmail' and lower(account_id) = lower(${email}) and agent_id <> ${agentId}
  `) as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** The service no longer honours our tokens; the person has to connect again. */
export async function markTriggerDisconnected(triggerId: string) {
  await ensureSchema();
  const sql = db();
  await sql`update triggers set status = 'disconnected' where id = ${triggerId}`;
}

/** The only evidence, short of logs, that a webhook is being called. */
export async function recordTriggerEvent(triggerId: string, eventType: string) {
  await ensureSchema();
  const sql = db();
  await sql`
    update triggers
    set last_event_at = now(), last_event_type = ${eventType}
    where id = ${triggerId}
  `;
}

/**
 * Everything the Slack events endpoint needs to check a request and answer
 * it. Server-only: carries the signing secret and bot token, decrypted.
 * Looked up by the trigger id in the URL, which is why that id is a uuid and
 * not a counter.
 */
export type SlackTriggerContext = {
  triggerId: string;
  agentId: string;
  agentHandle: string;
  slackAppId: string | null;
  signingSecret: string | null;
  botToken: string | null;
};

export async function getSlackTriggerContext(
  triggerId: string,
): Promise<SlackTriggerContext | null> {
  await ensureSchema();
  const sql = db();

  if (!UUID_RE.test(triggerId)) return null;

  const rows = (await sql`
    select t.id as trigger_id, a.id, a.handle, a.slack_app_id, a.slack_signing_secret, a.slack_bot_token
    from triggers t
    join agents a on a.id = t.agent_id
    where t.id = ${triggerId} and t.kind = 'slack'
    limit 1
  `) as {
    trigger_id: string;
    id: string;
    handle: string;
    slack_app_id: string | null;
    slack_signing_secret: string | null;
    slack_bot_token: string | null;
  }[];

  const row = rows[0];
  if (!row) return null;
  return {
    triggerId: row.trigger_id,
    agentId: row.id,
    agentHandle: row.handle,
    slackAppId: row.slack_app_id,
    signingSecret: decryptOptional(row.slack_signing_secret),
    botToken: decryptOptional(row.slack_bot_token),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
