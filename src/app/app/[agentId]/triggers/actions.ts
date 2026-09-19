"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAgent } from "@/app/app/require-agent";
import type { Agent } from "@/lib/agents";
import { GmailApiError } from "@/lib/gmail/api";
import { GoogleAuthError, isGmailTriggerConfigured } from "@/lib/gmail/google";
import { GmailWatchError, startGmailWatch, stopGmailWatch } from "@/lib/gmail/watch";
import { DEFAULT_GMAIL_EVENTS, normalizeGmailEvents } from "@/lib/gmail-events";
import { describeSlackErrors, SlackApiError } from "@/lib/slack";
import { syncSlackManifest } from "@/lib/slack-access";
import { SlackConfigTokenError } from "@/lib/slack-config-token";
import { normalizeSlackEvents } from "@/lib/slack-events-catalog";
import {
  StripeApiError,
  buildStripeConnectUrl,
  deauthorizeStripeAccount,
  isStripeConfigured,
  newStripeState,
} from "@/lib/stripe";
import {
  countOtherStripeConnections,
  deleteStripeConnection,
  getStripeConnection,
  isStripeConnected,
  startStripeConnection,
} from "@/lib/stripe-connections";
import { normalizeStripeEvents } from "@/lib/stripe-events";
import { syncStripeEndpoint } from "@/lib/stripe-webhook";
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  updateTriggerEvents,
} from "@/lib/triggers";

export type TriggerActionState = { error?: string };

/**
 * Chooses which Slack events wake the agent; the first save is what creates
 * its Slack trigger. The manifest at Slack is updated before the choice is
 * stored, so the two can't disagree — except that a brand-new trigger has to
 * be inserted first, because its id is the webhook's path and Slack
 * challenges that URL as soon as it sees it. If Slack then refuses, the row
 * goes again. New scopes take effect on the next install.
 */
export async function saveSlackEventsAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const events = normalizeSlackEvents(strings(formData.getAll("events")));

  const existing = await getTrigger(agent.id, "slack");
  const trigger = existing ?? (await createTrigger({ agentId: agent.id, kind: "slack", events }));

  try {
    await syncSlackManifest(agent, { trigger: { id: trigger.id, events } });
  } catch (error) {
    if (!existing) await deleteTrigger(trigger.id).catch(() => {});
    return { error: slackFailure(error) };
  }

  if (existing) await updateTriggerEvents(trigger.id, events);
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/**
 * The agent stops listening to Slack: the subscription leaves the manifest
 * and the trigger goes. The app stays installed, and its tools keep working.
 */
export async function stopSlackEventsAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const trigger = await getTrigger(agent.id, "slack");
  if (!trigger) return { error: "This agent has no Slack trigger." };

  try {
    await syncSlackManifest(agent, { trigger: null });
  } catch (error) {
    return { error: slackFailure(error) };
  }

  await deleteTrigger(trigger.id);
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/**
 * Sends the person to Stripe to connect an account to the agent's workspace.
 * The install is the workspace's: it happens once, and afterwards every agent
 * in it picks events without going to Stripe again. Started from an agent's
 * page so the callback can bring the person back to it.
 */
export async function connectStripeAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  if (!isStripeConfigured()) {
    return { error: "Stripe isn't configured: set STRIPE_SECRET_KEY and STRIPE_INSTALL_LINK." };
  }

  const state = newStripeState();
  await startStripeConnection({ workspaceId: agent.workspaceId, agentId: agent.id, state });
  redirect(buildStripeConnectUrl({ state }));
}

/**
 * Records which Stripe events reach this agent; the first save is what
 * creates its trigger. The shared endpoint takes everything, so this list is
 * the filter the events route applies. Catalog picks and typed-in event
 * types arrive in different fields and are merged here.
 */
export async function saveStripeEventsAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const connection = await getStripeConnection(agent.workspaceId);
  if (!isStripeConnected(connection)) {
    return { error: "Connect a Stripe account before choosing its events." };
  }

  const typed = str(formData.get("custom")).split(/[\s,]+/);
  const events = normalizeStripeEvents([...strings(formData.getAll("events")), ...typed]);
  if (events.length === 0) return { error: "Pick at least one event." };

  const trigger = await getTrigger(agent.id, "stripe");
  if (trigger) await updateTriggerEvents(trigger.id, events);
  else await createTrigger({ agentId: agent.id, kind: "stripe", events });

  try {
    await syncStripeEndpoint();
  } catch (error) {
    return { error: `Saved, but Stripe's webhook endpoint could not be registered: ${stripeFailure(error)}` };
  }

  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/** This agent stops listening to Stripe. The workspace's account stays connected for the others. */
export async function stopStripeEventsAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const trigger = await getTrigger(agent.id, "stripe");
  if (!trigger) return { error: "This agent has no Stripe trigger." };

  await deleteTrigger(trigger.id);
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/**
 * Disconnects the Stripe account from the whole workspace and tells Stripe
 * the platform no longer wants it. Every agent's event list stays where it
 * is, inert, so connecting again (the same account or another) picks up
 * where things left off.
 */
export async function disconnectStripeAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const connection = await getStripeConnection(agent.workspaceId);
  if (!connection) return { error: "This workspace has no Stripe connection." };

  if (connection.accountId) await deauthorizeIfUnused(connection.accountId, agent);
  await deleteStripeConnection(agent.workspaceId);

  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/**
 * The same account may be connected to another workspace; only the last one
 * to leave revokes the platform's access.
 */
async function deauthorizeIfUnused(accountId: string, agent: Agent) {
  if (!isStripeConfigured()) return;
  if ((await countOtherStripeConnections(accountId, agent.workspaceId)) > 0) return;

  try {
    await deauthorizeStripeAccount(accountId);
  } catch (error) {
    // Already disconnected on Stripe's side is fine; anything else is logged
    // and the connection goes anyway — the person asked for it to.
    if (!(error instanceof StripeApiError && error.code === "invalid_client")) {
      console.error(`Could not deauthorize Stripe account for workspace ${agent.workspaceId}`, error);
    }
  }
}

/**
 * Starts watching the mailbox of the agent's Gmail connection. Events start
 * out as the default (mail received); the trigger page is where they change.
 */
export async function startGmailWatchAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  if (!isGmailTriggerConfigured()) {
    return {
      error:
        "Gmail triggers aren't configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_PUBSUB_TOPIC and GMAIL_PUBSUB_TOKEN.",
    };
  }

  const existing = await getTrigger(agent.id, "gmail");
  try {
    await startGmailWatch(agent.id, existing?.events.length ? existing.events : DEFAULT_GMAIL_EVENTS);
  } catch (error) {
    return { error: gmailFailure(error) };
  }

  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}/triggers/gmail?started=1`);
}

/**
 * Changes which inbox events reach the agent. The watch is re-issued with
 * the labels the new choice needs; the history position carries over.
 */
export async function saveGmailEventsAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const trigger = await getTrigger(agent.id, "gmail");
  if (!trigger || trigger.status !== "active") {
    return { error: "Start listening before choosing events." };
  }

  const events = normalizeGmailEvents(strings(formData.getAll("events")));
  try {
    await startGmailWatch(agent.id, events);
  } catch (error) {
    return { error: gmailFailure(error) };
  }

  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/** Removes the trigger; stops the mailbox watch if no other agent shares it. */
export async function stopGmailWatchAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const trigger = await getTrigger(agent.id, "gmail");
  if (!trigger) return { error: "This agent has no Gmail trigger." };

  await stopGmailWatch(agent.id, trigger);
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

function gmailFailure(error: unknown) {
  if (error instanceof GmailWatchError || error instanceof GoogleAuthError) return error.message;
  if (error instanceof GmailApiError) return `Gmail refused: ${error.message}`;
  return error instanceof Error ? error.message : "Gmail could not be reached.";
}

function slackFailure(error: unknown) {
  // Changing the manifest needs the workspace's app configuration token, which
  // can be gone or expired by now. Its own message says how to replace it.
  if (error instanceof SlackConfigTokenError) return error.message;
  if (error instanceof SlackApiError) {
    const reason = describeSlackErrors(error.details);
    return `Slack rejected the change (${error.code}${reason ? `: ${reason}` : ""}).`;
  }
  return error instanceof Error ? error.message : "Slack could not be updated.";
}

function stripeFailure(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function str(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function strings(values: FormDataEntryValue[]) {
  return values.filter((value): value is string => typeof value === "string");
}
