import {
  getMessage,
  getProfile,
  GmailApiError,
  listHistory,
  stopWatch,
  summarizeMessage,
  watch,
  type HistoryRecord,
} from "@/lib/gmail/api";
import { bearerFromConnection, GoogleAuthError, gmailPubSubTopic } from "@/lib/gmail/google";
import { getGmailEvent, gmailLabelIdsFor, normalizeGmailEvents } from "@/lib/gmail-events";
import { ensureGmailConnection } from "@/lib/gmail/connection";
import { handleGmailEvent } from "@/lib/agent/gmail";
import { getConnection } from "@/lib/mcp/connections";
import {
  claimGmailMessage,
  countOtherGmailTriggers,
  createTrigger,
  deleteTrigger,
  findGmailTriggers,
  getTrigger,
  listActiveGmailTriggers,
  markGmailWatching,
  markTriggerDisconnected,
  pruneGmailClaims,
  recordTriggerEvent,
  updateGmailHistoryId,
  updateGmailWatchExpiration,
  updateTriggerEvents,
  type Trigger,
} from "@/lib/triggers";

/**
 * The Gmail trigger, end to end:
 *
 * 1. `users.watch` asks Gmail to publish to the deployment's Pub/Sub topic
 *    whenever the labels the events map to change. Gmail forgets the watch
 *    after seven days, so it is renewed (`renewDueWatches`, from a cron, and
 *    on the side when a notification arrives).
 * 2. Pub/Sub pushes each notification to /api/gmail/events. It says only
 *    which mailbox and how far its history now reaches; what actually
 *    happened comes from `history.list` since the position the trigger last
 *    saw, which is what `processNotification` does.
 * 3. One incoming message produces several notifications (Gmail sends one
 *    per label change, Pub/Sub retries on its own), and they arrive in
 *    parallel, each listing history from the same position. Before an agent
 *    is run for a message, the (trigger, event, message) is claimed in
 *    `gmail_handled_messages`; only the notification that wins the claim
 *    acts, the rest skip it.
 *
 * The Google tokens are the agent's Gmail MCP connection's: the trigger and
 * the tools are one grant. Without that connection there is no trigger.
 */

/** Renew this far ahead of the expiry, so a missed cron run doesn't lose the watch. */
const RENEW_AHEAD_MS = 3 * 24 * 60 * 60 * 1000;

/** How many messages one notification is unpacked into, at most. */
const MESSAGES_PER_NOTIFICATION = 25;

/**
 * How long a claim on a message is kept. Gmail's history holds about a week;
 * doubling that leaves no window for a listed message to be unclaimed.
 */
const CLAIM_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export class GmailWatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailWatchError";
  }
}

/**
 * The agent's own Gmail connection — or, for an agent that has none, the
 * workspace's grant taken over on the spot, so an account connected once
 * serves every agent (see src/lib/gmail/connection.ts).
 */
async function authorizedConnection(agentId: string) {
  const connection = await ensureGmailConnection(agentId);
  if (!connection) {
    throw new GmailWatchError("Connect Gmail under Access first — the trigger listens on that account.");
  }
  return connection;
}

/**
 * Starts (or re-points) the watch for an agent and records the trigger. The
 * events decide which labels Gmail reports on.
 */
export async function startGmailWatch(agentId: string, eventIds: Iterable<string>): Promise<Trigger> {
  const topic = gmailPubSubTopic();
  if (!topic) throw new GmailWatchError("GMAIL_PUBSUB_TOPIC isn't set on this deployment.");

  const connection = await authorizedConnection(agentId);
  const bearer = bearerFromConnection(connection.id);
  const events = normalizeGmailEvents(eventIds);

  const [profile, started] = await Promise.all([
    getProfile(bearer),
    watch(bearer, topic, gmailLabelIdsFor(events)),
  ]);

  let trigger = await getTrigger(agentId, "gmail");
  if (trigger) {
    await updateTriggerEvents(trigger.id, events);
  } else {
    trigger = await createTrigger({ agentId, kind: "gmail", events });
  }

  // A trigger that already has a position keeps it: re-watching to change
  // labels mustn't skip whatever arrived in between.
  await markGmailWatching(trigger.id, {
    email: profile.emailAddress,
    historyId: trigger.historyId ?? started.historyId,
    expiration: started.expiration,
  });
  return (await getTrigger(agentId, "gmail"))!;
}

/**
 * Removes the trigger. The watch itself is per mailbox, so it's only stopped
 * when no other agent listens to the same address.
 */
export async function stopGmailWatch(agentId: string, trigger: Trigger) {
  if (trigger.accountId && (await countOtherGmailTriggers(trigger.accountId, agentId)) === 0) {
    const connection = await getConnection(agentId, "gmail");
    if (connection?.status === "authorized") {
      await stopWatch(bearerFromConnection(connection.id)).catch((error) =>
        console.error(`Could not stop the Gmail watch for agent ${agentId}`, error),
      );
    }
  }
  await deleteTrigger(trigger.id);
}

/** Watches that lapse within the renewal window, renewed. Returns what happened to each. */
export async function renewDueWatches(now = Date.now()) {
  const due = (await listActiveGmailTriggers()).filter(
    (trigger) => !trigger.watchExpiresAt || Date.parse(trigger.watchExpiresAt) - now < RENEW_AHEAD_MS,
  );
  const results: { triggerId: string; outcome: "renewed" | "disconnected" | "failed" }[] = [];
  for (const trigger of due) {
    results.push({ triggerId: trigger.id, outcome: await renewWatch(trigger) });
  }
  // The daily cron is also when old claims are let go of.
  await pruneGmailClaims(CLAIM_RETENTION_MS).catch((error) =>
    console.error("Pruning old Gmail message claims failed", error),
  );
  return results;
}

async function renewWatch(trigger: Trigger): Promise<"renewed" | "disconnected" | "failed"> {
  const topic = gmailPubSubTopic();
  const connection = await getConnection(trigger.agentId, "gmail");
  if (!topic || connection?.status !== "authorized") return "failed";
  try {
    const renewed = await watch(
      bearerFromConnection(connection.id),
      topic,
      gmailLabelIdsFor(trigger.events),
    );
    await updateGmailWatchExpiration(trigger.id, renewed.expiration);
    return "renewed";
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      await markTriggerDisconnected(trigger.id);
      return "disconnected";
    }
    console.error(`Renewing the Gmail watch for trigger ${trigger.id} failed`, error);
    return "failed";
  }
}

export type GmailNotification = { emailAddress: string; historyId: string };

/**
 * Unpacks one notification for every trigger on that mailbox: lists what
 * changed since the trigger's last position, notes the events it listens
 * for, moves the position on. Errors are per trigger — one agent's dead
 * tokens shouldn't stop another's.
 */
export async function processNotification(notification: GmailNotification) {
  const triggers = await findGmailTriggers(notification.emailAddress);
  for (const trigger of triggers) {
    try {
      await processForTrigger(trigger, notification);
    } catch (error) {
      if (error instanceof GoogleAuthError) {
        await markTriggerDisconnected(trigger.id);
      }
      console.error(`Gmail notification for trigger ${trigger.id} failed`, error);
    }
  }
  return triggers.length;
}

async function processForTrigger(trigger: Trigger, notification: GmailNotification) {
  const connection = await getConnection(trigger.agentId, "gmail");
  if (connection?.status !== "authorized") return;
  const bearer = bearerFromConnection(connection.id);

  const since = trigger.historyId ?? notification.historyId;
  let records: HistoryRecord[] = [];
  try {
    records = await listHistory(bearer, since, ["messageAdded", "labelAdded"]);
  } catch (error) {
    // The position is older than Gmail keeps history for. Start over from
    // now; whatever happened in the gap is gone either way.
    if (!(error instanceof GmailApiError && error.status === 404)) throw error;
  }

  const occurrences = eventsIn(records, trigger.events);
  for (const { eventId, messageId } of occurrences.slice(0, MESSAGES_PER_NOTIFICATION)) {
    // Another notification for this mailbox — earlier, or running right
    // now — may already have acted on this message. The claim stays even if
    // the run below fails: a second run is exactly the duplicate this avoids.
    if (!(await claimGmailMessage(trigger.id, eventId, messageId))) continue;
    await recordTriggerEvent(trigger.id, eventId).catch(() => {});
    const message = await getMessage(bearer, messageId, "metadata").catch(() => null);
    const summary = message ? summarizeMessage(message, false) : null;
    await handleGmailEvent(trigger, eventId, summary).catch((error) =>
      console.error(`Agent run for Gmail ${eventId} on trigger ${trigger.id} failed`, error),
    );
  }

  // Notifications can overtake each other; never move the position backwards.
  const furthest = [since, notification.historyId, ...records.map((record) => record.id)]
    .map(BigInt)
    .reduce((a, b) => (a > b ? a : b));
  await updateGmailHistoryId(trigger.id, furthest.toString());

  if (!trigger.watchExpiresAt || Date.parse(trigger.watchExpiresAt) - Date.now() < RENEW_AHEAD_MS) {
    await renewWatch(trigger);
  }
}

/**
 * Which of the trigger's events the history holds, once per message per
 * event. A message the account itself sent or is still drafting isn't
 * "received", even though it appears in the history with INBOX on it.
 */
export function eventsIn(records: HistoryRecord[], listening: string[]) {
  const seen = new Set<string>();
  const found: { eventId: string; messageId: string }[] = [];
  const note = (eventId: string, messageId: string) => {
    const key = `${eventId}:${messageId}`;
    if (!listening.includes(eventId) || seen.has(key)) return;
    seen.add(key);
    found.push({ eventId, messageId });
  };

  for (const record of records) {
    for (const { message } of record.messagesAdded ?? []) {
      const labels = message.labelIds ?? [];
      if (labels.includes("INBOX") && !labels.includes("SENT") && !labels.includes("DRAFT")) {
        note("message.received", message.id);
      }
    }
    for (const { message, labelIds } of record.labelsAdded ?? []) {
      for (const label of labelIds) {
        const event = labelForEvent(label);
        if (event && event !== "message.received") note(event, message.id);
      }
    }
  }
  return found;
}

function labelForEvent(labelId: string) {
  return ["message.received", "message.starred"].find((id) => getGmailEvent(id)?.labelId === labelId);
}
