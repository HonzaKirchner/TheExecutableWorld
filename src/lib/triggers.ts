import { db, ensureSchema } from "@/lib/db";
import { publicBaseUrl } from "@/lib/base-url";

/**
 * The kinds of trigger an agent can have. Only Slack for now; each one is a
 * webhook that an OAuth app somewhere else calls.
 */
export type TriggerDefinition = {
  id: string;
  name: string;
  description: string;
  /** Added to every agent without asking. */
  automatic: boolean;
  /** False for kinds that are listed to show where this is going, but don't work yet. */
  available: boolean;
};

export const TRIGGERS: readonly TriggerDefinition[] = [
  {
    id: "slack",
    name: "Slack",
    description: "Runs when someone @mentions the agent or sends it a direct message.",
    automatic: true,
    available: true,
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Runs on payment events — a new subscription, a failed charge, a refund.",
    automatic: false,
    available: false,
  },
];

export type Trigger = {
  id: string;
  agentId: string;
  kind: string;
  createdAt: string;
};

type TriggerRow = {
  id: string;
  agent_id: string;
  kind: string;
  created_at: string;
};

function toTrigger(row: TriggerRow): Trigger {
  return { id: row.id, agentId: row.agent_id, kind: row.kind, createdAt: row.created_at };
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
  const rows = (await sql`
    select id, agent_id, kind, created_at
    from triggers
    where agent_id = ${agentId}
    order by created_at
  `) as TriggerRow[];
  return rows.map(toTrigger);
}

/**
 * The id is chosen by the caller: the Slack app's manifest has to carry the
 * webhook URL before the agent — and so the trigger — can be inserted.
 */
export async function createTrigger(input: {
  id: string;
  agentId: string;
  kind: string;
}): Promise<Trigger> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    insert into triggers (id, agent_id, kind)
    values (${input.id}, ${input.agentId}, ${input.kind})
    returning id, agent_id, kind, created_at
  `) as TriggerRow[];
  return toTrigger(rows[0]);
}

/**
 * Everything the events endpoint needs to check a request and answer it.
 * Server-only: carries the signing secret and bot token. Looked up by the
 * trigger id in the URL, which is why that id is a uuid and not a counter.
 */
export type SlackTriggerContext = {
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
    select a.id, a.handle, a.slack_app_id, a.slack_signing_secret, a.slack_bot_token
    from triggers t
    join agents a on a.id = t.agent_id
    where t.id = ${triggerId} and t.kind = 'slack'
    limit 1
  `) as {
    id: string;
    handle: string;
    slack_app_id: string | null;
    slack_signing_secret: string | null;
    slack_bot_token: string | null;
  }[];

  const row = rows[0];
  if (!row) return null;
  return {
    agentId: row.id,
    agentHandle: row.handle,
    slackAppId: row.slack_app_id,
    signingSecret: row.slack_signing_secret,
    botToken: row.slack_bot_token,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
