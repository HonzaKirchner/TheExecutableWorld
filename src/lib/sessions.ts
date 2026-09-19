import { publicBaseUrl } from "@/lib/base-url";
import { db, ensureSchema } from "@/lib/db";

/**
 * A session is one run of an agent: a trigger woke it, it did some things, it
 * stopped. The transcript is everything it did, in order.
 *
 * Sessions are read at /s/<id> by anyone holding the link — there is no
 * sign-in on that page and no workspace check in these queries, because the
 * id is the capability. Two consequences worth keeping in mind:
 *
 *  - Nothing written here is private. Secrets, tokens, raw webhook payloads
 *    and the agent's own instructions must not reach `body` or `data`.
 *  - Ids must stay unguessable, which is why they are random uuids rather
 *    than anything derived from the agent or the event.
 */

export type SessionStatus = "running" | "paused" | "done" | "failed" | "stopped";

/**
 * What a line of the transcript is. Only `trigger`, `message`, `reply` and
 * `error` are written today — the rest are the vocabulary the agent loop will
 * use once it exists, kept here so the viewer already knows how to draw them.
 */
export type SessionEventType =
  | "trigger"
  | "message"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "reply"
  | "error"
  | "note";

export type SessionRole = "user" | "agent" | "system";

export type SessionEventInput = {
  type: SessionEventType;
  role?: SessionRole;
  /** The human-readable line. Rendered as text, never as markup. */
  body?: string | null;
  /** Small, public-safe extras — a tool name, an event type, a channel. */
  data?: Record<string, unknown> | null;
};

export type SessionEvent = {
  /** Gap-free and per session, which is what makes it the live cursor. */
  seq: number;
  type: SessionEventType;
  role: SessionRole | null;
  body: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
};

export type AgentSession = {
  id: string;
  /** The agent's handle. Deliberately the only thing about the agent here. */
  agentHandle: string;
  triggerKind: string;
  title: string | null;
  status: SessionStatus;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
};

/** A session as the agent's own (signed-in) pages list it. */
export type SessionSummary = AgentSession & {
  agentId: string;
  /** How many lines the transcript has, for the list. */
  eventCount: number;
};

type SessionRow = {
  id: string;
  agent_id: string;
  handle: string;
  trigger_kind: string;
  title: string | null;
  status: SessionStatus;
  error: string | null;
  started_at: string;
  ended_at: string | null;
};

type EventRow = {
  seq: number;
  type: SessionEventType;
  role: SessionRole | null;
  body: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
};

function toSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    agentHandle: row.handle,
    triggerKind: row.trigger_kind,
    title: row.title,
    status: row.status,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function toEvent(row: EventRow): SessionEvent {
  return {
    seq: Number(row.seq),
    type: row.type,
    role: row.role,
    body: row.body,
    data: row.data,
    createdAt: row.created_at,
  };
}

/**
 * Opens a session and writes its first lines in one round trip — webhooks are
 * on a clock (Slack gives us three seconds) so the transcript costs one query,
 * not one per line.
 */
export async function startSession(input: {
  agentId: string;
  triggerId?: string | null;
  triggerKind: string;
  title?: string | null;
  events?: SessionEventInput[];
}): Promise<string> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `with s as (
       insert into agent_sessions (agent_id, trigger_id, trigger_kind, title)
       values ($1, $2, $3, $4)
       returning id
     ),
     e as (
       insert into agent_session_events (session_id, seq, type, role, body, data)
       select s.id, ev.ord, ev.value ->> 'type', ev.value ->> 'role',
              ev.value ->> 'body', ev.value -> 'data'
       from s, jsonb_array_elements($5::jsonb) with ordinality ev (value, ord)
     )
     select id from s`,
    [
      input.agentId,
      input.triggerId ?? null,
      input.triggerKind,
      input.title ?? null,
      JSON.stringify(input.events ?? []),
    ],
  )) as { id: string }[];

  return rows[0].id;
}

/**
 * Appends to the transcript. `seq` is derived in the statement rather than
 * passed in, so a caller never has to know how far the transcript got; that
 * assumes one writer per session, which is what a run is.
 */
export async function appendSessionEvents(
  sessionId: string,
  events: SessionEventInput[],
) {
  if (events.length === 0) return;
  await ensureSchema();
  const sql = db();

  await sql.query(
    `with base as (
       select coalesce(max(seq), 0) as seq
       from agent_session_events
       where session_id = $1
     )
     insert into agent_session_events (session_id, seq, type, role, body, data)
     select $1, base.seq + ev.ord, ev.value ->> 'type', ev.value ->> 'role',
            ev.value ->> 'body', ev.value -> 'data'
     from base, jsonb_array_elements($2::jsonb) with ordinality ev (value, ord)`,
    [sessionId, JSON.stringify(events)],
  );
}

export function appendSessionEvent(sessionId: string, event: SessionEventInput) {
  return appendSessionEvents(sessionId, [event]);
}

/**
 * Marks a session as waiting on a person, without ending it — `ended_at`
 * stays null, since the run isn't over, just stopped for now.
 */
export async function pauseSession(sessionId: string, events: SessionEventInput[] = []) {
  await appendSessionEvents(sessionId, events);
  await ensureSchema();
  const sql = db();
  await sql`update agent_sessions set status = 'paused' where id = ${sessionId}`;
}

/** Picks a paused session back up — a decision came in and the run continues. */
export async function unpauseSession(sessionId: string) {
  await ensureSchema();
  const sql = db();
  await sql`update agent_sessions set status = 'running' where id = ${sessionId}`;
}

/** Closes a session, optionally with the last lines of its transcript. */
export async function finishSession(
  sessionId: string,
  input: {
    status: Exclude<SessionStatus, "running" | "paused">;
    error?: string | null;
    events?: SessionEventInput[];
  },
) {
  await ensureSchema();
  const sql = db();

  await sql.query(
    `with base as (
       select coalesce(max(seq), 0) as seq
       from agent_session_events
       where session_id = $1
     ),
     e as (
       insert into agent_session_events (session_id, seq, type, role, body, data)
       select $1, base.seq + ev.ord, ev.value ->> 'type', ev.value ->> 'role',
              ev.value ->> 'body', ev.value -> 'data'
       from base, jsonb_array_elements($4::jsonb) with ordinality ev (value, ord)
     )
     update agent_sessions
     set status = $2, error = $3, ended_at = now()
     where id = $1`,
    [
      sessionId,
      input.status,
      input.error ?? null,
      JSON.stringify(input.events ?? []),
    ],
  );
}

/**
 * The session behind a public link. No workspace scoping on purpose — see the
 * note at the top of the file — but the id still has to be a uuid, or Postgres
 * would raise a type error instead of returning nothing.
 */
export async function getSession(sessionId: string): Promise<AgentSession | null> {
  if (!isUuid(sessionId)) return null;
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select s.id, s.agent_id, a.handle, s.trigger_kind, s.title, s.status,
            s.error, s.started_at, s.ended_at
     from agent_sessions s
     join agents a on a.id = s.agent_id
     where s.id = $1
     limit 1`,
    [sessionId],
  )) as SessionRow[];

  return rows[0] ? toSession(rows[0]) : null;
}

/**
 * The transcript from `after` onwards. The live view passes the highest seq it
 * already has, so a poll that brings nothing back costs one small query.
 */
export async function listSessionEvents(
  sessionId: string,
  after = 0,
): Promise<SessionEvent[]> {
  if (!isUuid(sessionId)) return [];
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select seq, type, role, body, data, created_at
     from agent_session_events
     where session_id = $1 and seq > $2
     order by seq`,
    [sessionId, after],
  )) as EventRow[];

  return rows.map(toEvent);
}

/**
 * An agent's recent runs. Callers have scoped the agent by workspace already,
 * as elsewhere in the app.
 */
export async function listAgentSessions(
  agentId: string,
  limit = 20,
): Promise<SessionSummary[]> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select s.id, s.agent_id, a.handle, s.trigger_kind, s.title, s.status,
            s.error, s.started_at, s.ended_at,
            (select count(*) from agent_session_events e where e.session_id = s.id)
              as event_count
     from agent_sessions s
     join agents a on a.id = s.agent_id
     where s.agent_id = $1
     order by s.started_at desc
     limit $2`,
    [agentId, limit],
  )) as (SessionRow & { event_count: string })[];

  return rows.map((row) => ({
    ...toSession(row),
    agentId: row.agent_id,
    eventCount: Number(row.event_count),
  }));
}

/**
 * One of the agent's sessions, for its signed-in pages. Scoped by agent, and
 * the caller has scoped the agent by workspace — so a session id from another
 * workspace reads as "not found" here, unlike at the public link.
 */
export async function getAgentSession(
  agentId: string,
  sessionId: string,
): Promise<SessionSummary | null> {
  if (!isUuid(sessionId)) return null;
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select s.id, s.agent_id, a.handle, s.trigger_kind, s.title, s.status,
            s.error, s.started_at, s.ended_at,
            (select count(*) from agent_session_events e where e.session_id = s.id)
              as event_count
     from agent_sessions s
     join agents a on a.id = s.agent_id
     where s.agent_id = $1 and s.id = $2
     limit 1`,
    [agentId, sessionId],
  )) as (SessionRow & { event_count: string })[];

  const row = rows[0];
  return row ? { ...toSession(row), agentId: row.agent_id, eventCount: Number(row.event_count) } : null;
}

/**
 * The agent a session belongs to, if that agent is in `workspaceId`. The public
 * transcript page uses this to offer a signed-in viewer the way back into the
 * app; anyone else gets null and the page stays as bare as the link promised.
 */
export async function getSessionAgentId(
  sessionId: string,
  workspaceId: string,
): Promise<string | null> {
  if (!isUuid(sessionId)) return null;
  await ensureSchema();
  const sql = db();

  const rows = (await sql.query(
    `select s.agent_id
     from agent_sessions s
     join agents a on a.id = s.agent_id
     where s.id = $1 and a.workspace_id = $2
     limit 1`,
    [sessionId, workspaceId],
  )) as { agent_id: string }[];

  return rows[0]?.agent_id ?? null;
}

/** Where the public transcript lives. Short, because it gets pasted into Slack. */
export function sessionPath(sessionId: string) {
  return `/s/${sessionId}`;
}

/** The agent's sessions, inside the signed-in app. */
export function agentSessionsPath(agentId: string) {
  return `/app/${agentId}/sessions`;
}

/** One session, inside the signed-in app. */
export function agentSessionPath(agentId: string, sessionId: string) {
  return `${agentSessionsPath(agentId)}/${sessionId}`;
}
/**
 * The transcript's full, public URL — reachable by whoever gets the link,
 * signed in or not (see the route's own doc comment). This is what actually
 * gets posted into Slack; `sessionPath` alone is only a same-app `<Link>` href.
 */
export function sessionUrl(sessionId: string) {
  return `${publicBaseUrl()}${sessionPath(sessionId)}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string) {
  return UUID_RE.test(value);
}
