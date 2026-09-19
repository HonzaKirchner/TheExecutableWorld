import type { ModelMessage } from "ai";

import type { Agent } from "@/lib/agents";
import type { ApprovalDecision, PendingApproval } from "@/lib/agent/run";
import type { TriggerContext } from "@/lib/agent/prompt";
import { db, ensureSchema } from "@/lib/db";
import { slackPost } from "@/lib/slack";
import { sessionPath } from "@/lib/sessions";
import { baseUrl } from "@/lib/base-url";
import type { TriggerKind } from "@/lib/triggers";

/**
 * A run paused waiting on one or more approvals. `resumeMessages` and
 * `triggerContext` are opaque outside `run.ts` and the trigger that started
 * the run — this module only stores and returns them. `replyContext` is
 * whatever that trigger needs to finish the job once the run picks back up
 * (a Slack channel and thread, say); it's `null` for a trigger with nowhere
 * to answer.
 */
export type StoredPause = {
  sessionId: string;
  agentId: string;
  resumeMessages: ModelMessage[];
  triggerKind: TriggerKind | string;
  triggerContext: TriggerContext;
  replyContext: unknown;
};

export type ApprovalStatus = "pending" | "approved" | "declined" | "stopped";

export type ToolApprovalRow = {
  id: string;
  sessionId: string;
  agentId: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  serverName: string;
  arguments: unknown;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedByName: string | null;
  note: string | null;
  slackChannel: string | null;
  slackMessageTs: string | null;
};

type PauseRow = {
  session_id: string;
  agent_id: string;
  resume_messages: ModelMessage[];
  trigger_kind: string;
  trigger_context: TriggerContext;
  reply_context: unknown;
};

type ApprovalRow = {
  id: string;
  session_id: string;
  agent_id: string;
  approval_id: string;
  tool_call_id: string;
  tool_name: string;
  server_name: string;
  arguments: unknown;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_by_name: string | null;
  note: string | null;
  slack_channel: string | null;
  slack_message_ts: string | null;
};

function toPause(row: PauseRow): StoredPause {
  return {
    sessionId: row.session_id,
    agentId: row.agent_id,
    resumeMessages: row.resume_messages,
    triggerKind: row.trigger_kind,
    triggerContext: row.trigger_context,
    replyContext: row.reply_context,
  };
}

function toApproval(row: ApprovalRow): ToolApprovalRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    approvalId: row.approval_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    serverName: row.server_name,
    arguments: row.arguments,
    status: row.status,
    decidedBy: row.decided_by,
    decidedByName: row.decided_by_name,
    note: row.note,
    slackChannel: row.slack_channel,
    slackMessageTs: row.slack_message_ts,
  };
}

/** One row per session: a run pauses at one place at a time. */
export async function savePause(input: {
  sessionId: string;
  agentId: string;
  resumeMessages: ModelMessage[];
  triggerKind: string;
  triggerContext: TriggerContext;
  replyContext: unknown;
}) {
  await ensureSchema();
  const sql = db();
  await sql.query(
    `insert into agent_pauses (session_id, agent_id, resume_messages, trigger_kind, trigger_context, reply_context)
     values ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb)
     on conflict (session_id) do update
       set resume_messages = excluded.resume_messages,
           trigger_context = excluded.trigger_context,
           reply_context   = excluded.reply_context`,
    [
      input.sessionId,
      input.agentId,
      JSON.stringify(input.resumeMessages),
      input.triggerKind,
      JSON.stringify(input.triggerContext),
      JSON.stringify(input.replyContext ?? null),
    ],
  );
}

export async function getPause(sessionId: string): Promise<StoredPause | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select session_id, agent_id, resume_messages, trigger_kind, trigger_context, reply_context
    from agent_pauses
    where session_id = ${sessionId}
    limit 1
  `) as PauseRow[];
  return rows[0] ? toPause(rows[0]) : null;
}

export async function deletePause(sessionId: string) {
  await ensureSchema();
  const sql = db();
  await sql`delete from agent_pauses where session_id = ${sessionId}`;
}

/** One row per gated tool call the model asked for in the step that paused. */
export async function createToolApprovals(
  sessionId: string,
  agentId: string,
  approvals: readonly PendingApproval[],
): Promise<ToolApprovalRow[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql.query(
    `insert into tool_approvals (session_id, agent_id, approval_id, tool_call_id, tool_name, server_name, arguments)
     select $1, $2, r.approval_id, r.tool_call_id, r.tool_name, r.server_name, r.arguments
     from jsonb_to_recordset($3::jsonb) as r(
       approval_id text, tool_call_id text, tool_name text, server_name text, arguments jsonb
     )
     returning id, session_id, agent_id, approval_id, tool_call_id, tool_name, server_name,
               arguments, status, decided_by, decided_by_name, note, slack_channel, slack_message_ts`,
    [
      sessionId,
      agentId,
      JSON.stringify(
        approvals.map((approval) => ({
          approval_id: approval.approvalId,
          tool_call_id: approval.toolCallId,
          tool_name: approval.toolName,
          server_name: approval.serverName,
          arguments: approval.args ?? {},
        })),
      ),
    ],
  )) as ApprovalRow[];
  return rows.map(toApproval);
}

export async function getToolApproval(id: string): Promise<ToolApprovalRow | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, session_id, agent_id, approval_id, tool_call_id, tool_name, server_name,
           arguments, status, decided_by, decided_by_name, note, slack_channel, slack_message_ts
    from tool_approvals
    where id = ${id}
    limit 1
  `) as ApprovalRow[];
  return rows[0] ? toApproval(rows[0]) : null;
}

export async function listToolApprovals(sessionId: string): Promise<ToolApprovalRow[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, session_id, agent_id, approval_id, tool_call_id, tool_name, server_name,
           arguments, status, decided_by, decided_by_name, note, slack_channel, slack_message_ts
    from tool_approvals
    where session_id = ${sessionId}
    order by created_at
  `) as ApprovalRow[];
  return rows.map(toApproval);
}

export async function recordApprovalDecision(
  id: string,
  input: { status: Exclude<ApprovalStatus, "pending">; decidedBy: string; decidedByName: string | null; note?: string | null },
) {
  await ensureSchema();
  const sql = db();
  await sql`
    update tool_approvals
    set status          = ${input.status},
        decided_by      = ${input.decidedBy},
        decided_by_name = ${input.decidedByName},
        note            = ${input.note ?? null},
        decided_at      = now()
    where id = ${id}
  `;
}

export async function setApprovalMessage(id: string, input: { channel: string; ts: string }) {
  await ensureSchema();
  const sql = db();
  await sql`
    update tool_approvals
    set slack_channel = ${input.channel}, slack_message_ts = ${input.ts}
    where id = ${id}
  `;
}

/** Whether `userId` may decide this agent's approvals — anyone can, if the list is empty. */
export function isWhitelisted(agent: Pick<Agent, "approvalWhitelist">, userId: string) {
  const whitelist = agent.approvalWhitelist;
  return !whitelist || whitelist.length === 0 || whitelist.includes(userId);
}

/**
 * Posts one Slack message per gated tool call, with buttons the interactions
 * route reads back. `action.value` is the row's id — the only thing needed to
 * look everything else up, so the payload sent to Slack never carries
 * arguments or session details of its own.
 */
export async function postApprovalRequests(input: {
  botToken: string;
  channel: string;
  approvals: ToolApprovalRow[];
  sessionId: string;
}) {
  const url = `${baseUrl()}${sessionPath(input.sessionId)}`;
  for (const approval of input.approvals) {
    const response = await slackPost<{ ok: boolean; ts?: string }>("chat.postMessage", {
      token: input.botToken,
      json: {
        channel: input.channel,
        text: `Approval needed: ${approval.serverName} — ${approval.toolName}`,
        blocks: approvalBlocks(approval, url),
        unfurl_links: false,
        unfurl_media: false,
      },
    });
    if (response.ts) {
      await setApprovalMessage(approval.id, { channel: input.channel, ts: response.ts });
    }
  }
}

/** Rewrites an approval's message once it's been decided, buttons gone. */
export async function updateApprovalMessage(
  botToken: string,
  approval: ToolApprovalRow,
  resolutionText: string,
) {
  if (!approval.slackChannel || !approval.slackMessageTs) return;
  await slackPost("chat.update", {
    token: botToken,
    json: {
      channel: approval.slackChannel,
      ts: approval.slackMessageTs,
      text: resolutionText,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: resolutionText } },
      ],
    },
  }).catch(() => {});
}

function approvalBlocks(approval: ToolApprovalRow, sessionUrl: string) {
  const args = formatArguments(approval.arguments);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval needed* — \`${approval.serverName}: ${approval.toolName}\`\n<${sessionUrl}|View the running conversation>`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `\`\`\`${args}\`\`\`` },
    },
    {
      type: "actions",
      block_id: "tool_approval",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "approval_approve",
          value: approval.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Decline with note" },
          action_id: "approval_decline",
          value: approval.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Stop agent" },
          style: "danger",
          action_id: "approval_stop",
          value: approval.id,
          confirm: {
            title: { type: "plain_text", text: "Stop this agent run?" },
            text: { type: "plain_text", text: "It will not pick this conversation back up." },
            confirm: { type: "plain_text", text: "Stop it" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    },
  ];
}

/**
 * Everything a run needs to pause: the pause row (so it can be picked back up)
 * and one Slack message per gated call, posted to the agent's audit channel.
 * Returns `posted: false` when there's no audit channel to post to — the
 * caller decides what a run should do then, since that's trigger-specific
 * (Slack has a thread to apologise in; others may not).
 */
export async function requestApprovals(input: {
  agent: Agent;
  botToken: string;
  sessionId: string;
  approvals: readonly PendingApproval[];
  resumeMessages: ModelMessage[];
  triggerKind: string;
  triggerContext: TriggerContext;
  replyContext: unknown;
}): Promise<{ posted: boolean }> {
  if (!input.agent.auditChannelId) return { posted: false };

  await savePause({
    sessionId: input.sessionId,
    agentId: input.agent.id,
    resumeMessages: input.resumeMessages,
    triggerKind: input.triggerKind,
    triggerContext: input.triggerContext,
    replyContext: input.replyContext,
  });
  const rows = await createToolApprovals(input.sessionId, input.agent.id, input.approvals);
  await postApprovalRequests({
    botToken: input.botToken,
    channel: input.agent.auditChannelId,
    approvals: rows,
    sessionId: input.sessionId,
  });
  return { posted: true };
}

/**
 * Whether every gated call from a pause has a decision yet, and what to do
 * about it. A `stopped` decision on any one of them ends the whole run right
 * away — the others are never going to matter once that's decided.
 */
export type ResumeReadiness =
  | { ready: false }
  | { ready: true; outcome: "stopped"; stoppedBy: string | null; note: string | null }
  | { ready: true; outcome: "continue"; decisions: ApprovalDecision[] };

export async function checkResumeReadiness(sessionId: string): Promise<ResumeReadiness> {
  const rows = await listToolApprovals(sessionId);
  const stopped = rows.find((row) => row.status === "stopped");
  if (stopped) {
    return { ready: true, outcome: "stopped", stoppedBy: stopped.decidedByName ?? stopped.decidedBy, note: stopped.note };
  }
  if (rows.some((row) => row.status === "pending")) return { ready: false };

  return {
    ready: true,
    outcome: "continue",
    decisions: rows.map((row) => ({
      approvalId: row.approvalId,
      approved: row.status === "approved",
      reason:
        row.status === "declined"
          ? row.note
            ? `Declined by a person: ${row.note}`
            : "Declined by a person, with no note."
          : row.decidedByName
            ? `Approved by ${row.decidedByName}.`
            : undefined,
    })),
  };
}

function formatArguments(args: unknown) {
  const json = JSON.stringify(args ?? {}, null, 2);
  return json.length > 2800 ? `${json.slice(0, 2800)}\n… truncated` : json;
}
