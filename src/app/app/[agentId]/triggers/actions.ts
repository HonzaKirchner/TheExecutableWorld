"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAgent } from "@/app/app/require-agent";
import type { Agent } from "@/lib/agents";
import { GmailApiError } from "@/lib/gmail/api";
import { GoogleAuthError, isGmailTriggerConfigured } from "@/lib/gmail/google";
import { GmailWatchError, startGmailWatch, stopGmailWatch } from "@/lib/gmail/watch";
import { DEFAULT_GMAIL_EVENTS, normalizeGmailEvents } from "@/lib/gmail-events";
import { SlackApiError } from "@/lib/slack";
import { updateSlackApp } from "@/lib/slack-apps";
import { normalizeSlackEvents } from "@/lib/slack-events-catalog";
import {
  StripeApiError,
  buildStripeConnectUrl,
  deauthorizeStripeAccount,
  isStripeConfigured,
  newStripeState,
} from "@/lib/stripe";
import { normalizeStripeEvents } from "@/lib/stripe-events";
import { syncStripeEndpoint } from "@/lib/stripe-webhook";
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  setTriggerOAuthState,
  slackEventsUrl,
  updateTriggerEvents,
} from "@/lib/triggers";

export type TriggerActionState = { error?: string };

/**
 * Changes which Slack events the agent's app subscribes to. The manifest is
 * updated at Slack first; only if that goes through is the choice stored, so
 * the two can't disagree. New scopes take effect on the next install.
 */
export async function saveSlackEventsAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const trigger = await getTrigger(agent.id, "slack");
  if (!trigger) return { error: "This agent has no Slack trigger." };

  const events = normalizeSlackEvents(strings(formData.getAll("events")));

  if (agent.slackAppId) {
    try {
      await updateSlackApp(agent.slackAppId, {
        handle: agent.handle,
        description: agent.description,
        eventsUrl: slackEventsUrl(trigger.id),
        events,
      });
    } catch (error) {
      return { error: slackFailure(error) };
    }
  }

  await updateTriggerEvents(trigger.id, events);
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/** Sends the person to Stripe to connect an account to this agent. */
export async function connectStripeAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  if (!isStripeConfigured()) {
    return { error: "Stripe isn't configured: set STRIPE_SECRET_KEY and STRIPE_INSTALL_LINK." };
  }

  const trigger =
    (await getTrigger(agent.id, "stripe")) ??
    (await createTrigger({ agentId: agent.id, kind: "stripe", events: [], status: "pending" }));

  const state = newStripeState();
  await setTriggerOAuthState(trigger.id, state);
  redirect(buildStripeConnectUrl({ state }));
}

/**
 * Records which Stripe events reach this agent. The shared endpoint takes
 * everything; this list is the filter the events route applies. Catalog picks
 * and typed-in event types arrive in different fields and are merged here.
 */
export async function saveStripeEventsAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const trigger = await getTrigger(agent.id, "stripe");
  if (!trigger?.accountId || trigger.status !== "active") {
    return { error: "Connect a Stripe account before choosing its events." };
  }

  const typed = str(formData.get("custom")).split(/[\s,]+/);
  const events = normalizeStripeEvents([...strings(formData.getAll("events")), ...typed]);
  if (events.length === 0) return { error: "Pick at least one event." };

  await updateTriggerEvents(trigger.id, events);
  try {
    await syncStripeEndpoint();
  } catch (error) {
    return { error: `Saved, but Stripe's webhook endpoint could not be registered: ${stripeFailure(error)}` };
  }

  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/** Removes the trigger and tells Stripe the platform no longer wants the account. */
export async function disconnectStripeAction(
  _previous: TriggerActionState,
  formData: FormData,
): Promise<TriggerActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const trigger = await getTrigger(agent.id, "stripe");
  if (!trigger) return { error: "This agent has no Stripe trigger." };

  await deauthorizeIfUnused(trigger.accountId, agent);
  await deleteTrigger(trigger.id);

  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/**
 * Another agent may listen to the same account; only the last one to leave
 * revokes the platform's access.
 */
async function deauthorizeIfUnused(accountId: string | null, agent: Agent) {
  if (!accountId || !isStripeConfigured()) return;
  const { db } = await import("@/lib/db");
  const rows = (await db()`
    select count(*)::int as n from triggers
    where kind = 'stripe' and account_id = ${accountId} and agent_id <> ${agent.id}
  `) as { n: number }[];
  if ((rows[0]?.n ?? 0) > 0) return;

  try {
    await deauthorizeStripeAccount(accountId);
  } catch (error) {
    // Already disconnected on Stripe's side is fine; anything else is logged
    // and the trigger goes anyway — the person asked for it to.
    if (!(error instanceof StripeApiError && error.code === "invalid_client")) {
      console.error(`Could not deauthorize Stripe account for agent ${agent.id}`, error);
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
  if (error instanceof SlackApiError) {
    return `Slack rejected the change (${error.code}).`;
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
