import { after, type NextRequest } from "next/server";

import { getAgentBotToken, getAgentById, getAgentSlackSigningSecret } from "@/lib/agents";
import {
  checkResumeReadiness,
  getPause,
  getToolApproval,
  isWhitelisted,
  recordApprovalDecision,
  updateApprovalMessage,
  type ToolApprovalRow,
} from "@/lib/agent/approvals";
import { resumeSlackRun, stopSlackRun } from "@/lib/agent/slack";
import { resumeStripeRun, stopStripeRun } from "@/lib/agent/stripe";
import { debugScope } from "@/lib/log";
import { slackPost } from "@/lib/slack";
import { verifySlackSignature } from "@/lib/slack-events";

const log = debugScope("slack.interactions");

export const maxDuration = 300;

/**
 * Slack calls this for one agent's approval buttons and modals — its own
 * "Interactivity" request URL, separate from the Events API one. Keyed by
 * agent id rather than a trigger id: approvals aren't tied to any one
 * trigger, they belong to the agent's Slack app as a whole.
 *
 * Same shape as the events route: answer fast, verify and act after. A block
 * action or a modal submission both arrive as `payload`, url-encoded.
 */
export async function POST(
  request: NextRequest,
  { params }: RouteContext<"/api/slack/interactions/[agentId]">,
) {
  const { agentId } = await params;
  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");

  after(() => process({ agentId, body, timestamp, signature }));

  return new Response(null, { status: 200 });
}

async function process(input: {
  agentId: string;
  body: string;
  timestamp: string | null;
  signature: string | null;
}) {
  try {
    const signingSecret = await getAgentSlackSigningSecret(input.agentId);
    if (!signingSecret) {
      log("dropped: no signing secret for this agent", { agentId: input.agentId });
      return;
    }
    if (!verifySlackSignature({ signingSecret, timestamp: input.timestamp, signature: input.signature, body: input.body })) {
      log("dropped: bad signature", { agentId: input.agentId });
      return;
    }

    const params = new URLSearchParams(input.body);
    const raw = params.get("payload");
    if (!raw) {
      log("dropped: no payload field", { agentId: input.agentId });
      return;
    }
    const payload = JSON.parse(raw) as SlackInteractionPayload;

    const botToken = await getAgentBotToken(input.agentId);
    if (!botToken) {
      log("dropped: agent has no bot token", { agentId: input.agentId });
      return;
    }

    if (payload.type === "block_actions") {
      await handleBlockAction(input.agentId, botToken, payload);
    } else if (payload.type === "view_submission" && payload.view?.callback_id === DECLINE_CALLBACK_ID) {
      await handleDeclineSubmission(input.agentId, botToken, payload);
    } else {
      log("ignored: unhandled interaction type", { type: payload.type });
    }
  } catch (error) {
    console.error(`Slack interaction for agent ${input.agentId} failed`, error);
    log("processing failed", { agentId: input.agentId, error });
  }
}

const DECLINE_CALLBACK_ID = "decline_with_note";
const NOTE_BLOCK_ID = "note";
const NOTE_ACTION_ID = "note_input";

type SlackInteractionPayload = {
  type: string;
  trigger_id?: string;
  response_url?: string;
  user?: { id: string; username?: string; name?: string };
  actions?: { action_id: string; value?: string }[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values: Record<string, Record<string, { value?: string }>> };
  };
};

async function handleBlockAction(agentId: string, botToken: string, payload: SlackInteractionPayload) {
  const action = payload.actions?.[0];
  const userId = payload.user?.id;
  if (!action?.value || !userId) return;

  const approval = await getToolApproval(action.value);
  if (!approval || approval.agentId !== agentId) return;

  if (approval.status !== "pending") {
    await ephemeral(payload.response_url, "Someone already decided this one.");
    return;
  }

  const agent = await getAgentById(agentId);
  if (!agent || !isWhitelisted(agent, userId)) {
    await ephemeral(payload.response_url, "You're not on the list of people who can decide this.");
    return;
  }

  if (action.action_id === "approval_decline") {
    if (!payload.trigger_id) return;
    await slackPost("views.open", {
      token: botToken,
      json: {
        trigger_id: payload.trigger_id,
        view: {
          type: "modal",
          callback_id: DECLINE_CALLBACK_ID,
          private_metadata: approval.id,
          title: { type: "plain_text", text: "Decline with note" },
          submit: { type: "plain_text", text: "Decline" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: NOTE_BLOCK_ID,
              label: { type: "plain_text", text: "Why?" },
              element: {
                type: "plain_text_input",
                action_id: NOTE_ACTION_ID,
                multiline: true,
                placeholder: { type: "plain_text", text: "Shown to the agent, so it can adjust." },
              },
              optional: true,
            },
          ],
        },
      },
    });
    return;
  }

  const outcome = action.action_id === "approval_stop" ? "stopped" : "approved";
  if (outcome !== "stopped" && action.action_id !== "approval_approve") return;

  await decide(agent, approval, {
    outcome,
    userId,
    userName: payload.user?.username ?? payload.user?.name ?? null,
    note: null,
  });
}

async function handleDeclineSubmission(agentId: string, botToken: string, payload: SlackInteractionPayload) {
  const approvalId = payload.view?.private_metadata;
  const userId = payload.user?.id;
  if (!approvalId || !userId) return;

  const approval = await getToolApproval(approvalId);
  if (!approval || approval.agentId !== agentId || approval.status !== "pending") return;

  const agent = await getAgentById(agentId);
  if (!agent || !isWhitelisted(agent, userId)) return;

  const note = payload.view?.state?.values[NOTE_BLOCK_ID]?.[NOTE_ACTION_ID]?.value?.trim() || null;

  await decide(agent, approval, {
    outcome: "declined",
    userId,
    userName: payload.user?.username ?? payload.user?.name ?? null,
    note,
  });
  void botToken; // the modal itself needs no further Slack call once submitted
}

/**
 * Records one person's decision, updates the message it came from, and — if
 * every gated call from the same pause now has an answer — picks the run
 * back up (or stops it for good).
 */
async function decide(
  agent: { id: string },
  approval: ToolApprovalRow,
  decision: { outcome: "approved" | "declined" | "stopped"; userId: string; userName: string | null; note: string | null },
) {
  await recordApprovalDecision(approval.id, {
    status: decision.outcome,
    decidedBy: decision.userId,
    decidedByName: decision.userName,
    note: decision.note,
  });

  const botToken = await getAgentBotToken(agent.id);
  if (botToken) {
    await updateApprovalMessage(botToken, approval, resolutionText(approval, decision));
  }

  const readiness = await checkResumeReadiness(approval.sessionId);
  if (!readiness.ready) return;

  const pause = await getPause(approval.sessionId);
  const triggerKind = pause?.triggerKind ?? "slack";

  if (readiness.outcome === "stopped") {
    if (triggerKind === "stripe") {
      await stopStripeRun(approval.sessionId, readiness.stoppedBy, readiness.note);
    } else {
      await stopSlackRun(approval.sessionId, readiness.stoppedBy, readiness.note);
    }
    return;
  }

  if (triggerKind === "stripe") {
    await resumeStripeRun(approval.sessionId, readiness.decisions);
  } else {
    await resumeSlackRun(approval.sessionId, readiness.decisions);
  }
}

function resolutionText(
  approval: ToolApprovalRow,
  decision: { outcome: "approved" | "declined" | "stopped"; userId: string; userName: string | null; note: string | null },
) {
  // Always Slack's own mention syntax, which renders as a real, clickable tag
  // — a literal `@username` is never linked, whatever we type. `userName` is
  // used elsewhere (the reason handed back to the model), but never here.
  const who = `<@${decision.userId}>`;
  const label = `\`${approval.serverName}: ${approval.toolName}\``;
  if (decision.outcome === "approved") return `✅ ${label} approved by ${who}.`;
  if (decision.outcome === "stopped") return `⏹️ ${label} — agent stopped by ${who}.`;
  return decision.note
    ? `❌ ${label} declined by ${who}: ${decision.note}`
    : `❌ ${label} declined by ${who}.`;
}

async function ephemeral(responseUrl: string | undefined, text: string) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    });
  } catch {
    // Best effort — the decision was refused either way.
  }
}
