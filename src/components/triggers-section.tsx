import Link from "next/link";
import { ChevronRight, Link2, Zap } from "lucide-react";

import { connectMcpServerAction } from "@/app/app/[agentId]/access/actions";
import { connectStripeAction, startGmailWatchAction } from "@/app/app/[agentId]/triggers/actions";
import type { Agent } from "@/lib/agents";
import { isGmailTriggerConfigured } from "@/lib/gmail/google";
import { isStripeConfigured } from "@/lib/stripe";
import { isStripeConnected, type StripeConnection } from "@/lib/stripe-connections";
import {
  gmailWatchLapsed,
  slackEventsUrl,
  TRIGGERS,
  type Trigger,
  type TriggerKind,
} from "@/lib/triggers";
import {
  ConnectTriggerCard,
  ConnectTriggerLabel,
} from "@/components/triggers/connect-trigger-card";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Tone = "emerald" | "amber" | "rose" | "muted";

/** What clicking a not-yet-connected card does: the action, its inputs, and the footer line. */
type Connect = {
  action: React.ComponentProps<typeof ConnectTriggerCard>["action"];
  fields?: Record<string, string>;
  label: string;
  pendingLabel: string;
};

export function TriggersSection({
  agent,
  triggers,
  gmailConnected,
  stripeConnection,
}: {
  agent: Agent;
  triggers: Trigger[];
  /**
   * Whether a Google account is there to listen on: the agent's own Gmail
   * connection, or one another agent of the workspace holds, which the
   * trigger takes over when it starts.
   */
  gmailConnected: boolean;
  /** The workspace's Stripe account, shared by all its agents; null until one is connected. */
  stripeConnection: StripeConnection | null;
}) {
  const byKind = new Map(triggers.map((trigger) => [trigger.kind, trigger]));
  const configured: Record<TriggerKind, boolean> = {
    slack: true,
    stripe: isStripeConfigured(),
    gmail: isGmailTriggerConfigured(),
  };

  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold tracking-tight">Triggers</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        What makes this coworker act. Nothing wakes it until you choose events — Slack is
        ready for that as is; Stripe and Gmail connect first.
      </p>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {TRIGGERS.map((definition, i) => {
          const trigger = byKind.get(definition.id) ?? null;
          const available = configured[definition.id];
          const { tone, label, hint } = describe(
            definition.id,
            trigger,
            agent,
            available,
            gmailConnected,
            stripeConnection,
          );
          const active = tone === "emerald";
          // Until the trigger is connected its card starts the connection
          // itself instead of opening a page whose only button would do that.
          const connect = available
            ? connectFor(definition.id, trigger, agent, gmailConnected, stripeConnection)
            : null;

          const body = (
            <>
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-lg border ${
                  active
                    ? "border-emerald-700/20 bg-emerald-600 text-white"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <Zap className="size-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="truncate font-medium">{definition.name}</h3>
                  <Status tone={tone}>{label}</Status>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{hint ?? definition.description}</p>

                {trigger && trigger.events.length > 0 ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {trigger.events.slice(0, 4).map((event) => (
                      <Badge key={event} variant="outline" className="font-mono text-[10px]">
                        {event}
                      </Badge>
                    ))}
                    {trigger.events.length > 4 ? (
                      <span className="text-[11px] text-muted-foreground">
                        +{trigger.events.length - 4} more
                      </span>
                    ) : null}
                    {definition.id === "slack" ? <WebhookHint url={slackEventsUrl(trigger.id)} /> : null}
                  </div>
                ) : null}

                {connect ? (
                  <ConnectTriggerLabel label={connect.label} pendingLabel={connect.pendingLabel} />
                ) : available ? (
                  <span className="mt-3 flex items-center gap-0.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                    {trigger?.events.length ? "Manage events" : "Choose events"}
                    <ChevronRight className="size-3.5" />
                  </span>
                ) : null}
              </div>
            </>
          );

          const className =
            "group flex h-full gap-4 rounded-xl border bg-card p-4 transition-all animate-in fade-in slide-in-from-bottom-1 duration-300 [animation-fill-mode:backwards]";

          return (
            <li key={definition.id} style={{ animationDelay: `${i * 30}ms` }} className="contents">
              {connect ? (
                <ConnectTriggerCard
                  action={connect.action}
                  agentId={agent.id}
                  fields={connect.fields}
                  className={className}
                >
                  {body}
                </ConnectTriggerCard>
              ) : available ? (
                <Link
                  href={`/app/${agent.id}/triggers/${definition.id}`}
                  className={`${className} hover:-translate-y-0.5 hover:shadow-sm ${
                    active
                      ? "border-emerald-300/70 bg-emerald-50/40 hover:border-emerald-400/80 dark:border-emerald-800/60 dark:bg-emerald-950/20"
                      : "hover:border-border/80"
                  }`}
                >
                  {body}
                </Link>
              ) : (
                <div className={`${className} border-dashed bg-card/50 opacity-60`}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * How a trigger that isn't connected yet gets connected, or nothing when it
 * already is and the card should open its page instead. Slack has nothing
 * to connect — every agent has its app — so its card always opens the page,
 * where the events are chosen; the install lives on the agent's page.
 * Stripe needs the workspace's account connected, which any one agent does
 * for all of them; Gmail needs its connection authorized and then the
 * mailbox watched, which are two clicks when starting from scratch — the
 * first one carries straight into the second.
 */
function connectFor(
  kind: TriggerKind,
  trigger: Trigger | null,
  agent: Agent,
  gmailConnected: boolean,
  stripeConnection: StripeConnection | null,
): Connect | null {
  if (kind === "slack") return null;

  if (kind === "stripe") {
    if (isStripeConnected(stripeConnection)) return null;
    return { action: connectStripeAction, label: "Connect Stripe", pendingLabel: "Opening Stripe…" };
  }

  if (trigger?.status === "active") return null;
  return gmailConnected
    ? { action: startGmailWatchAction, label: "Start listening", pendingLabel: "Asking Gmail…" }
    : {
        action: connectMcpServerAction,
        fields: { serverId: "gmail", returnTo: "trigger" },
        label: "Connect Gmail",
        pendingLabel: "Opening Google…",
      };
}

function describe(
  kind: TriggerKind,
  trigger: Trigger | null,
  agent: Agent,
  available: boolean,
  gmailConnected: boolean,
  stripeConnection: StripeConnection | null,
): { tone: Tone; label: string; hint?: string } {
  if (kind === "slack") {
    return trigger
      ? { tone: "emerald", label: "Active" }
      : {
          tone: "muted",
          label: "Not listening",
          hint: `Choose the Slack events that wake @${agent.handle}.`,
        };
  }

  if (kind === "gmail") {
    if (!available) {
      return {
        tone: "muted",
        label: "Not configured",
        hint: "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_PUBSUB_TOPIC and GMAIL_PUBSUB_TOKEN on the deployment to enable Gmail.",
      };
    }
    if (!trigger || trigger.status === "pending") {
      return gmailConnected
        ? { tone: "muted", label: "Not listening", hint: "A Google account is connected. Start listening to wake the agent on new mail." }
        : { tone: "muted", label: "Not connected", hint: "Connect the agent's Google account; it starts listening for new mail right away." };
    }
    if (trigger.status === "disconnected") {
      return gmailConnected
        ? { tone: "rose", label: "Disconnected", hint: "The mailbox watch stopped. Start listening again." }
        : { tone: "rose", label: "Disconnected", hint: "Google stopped honouring the tokens. Connect Gmail again." };
    }
    return gmailWatchLapsed(trigger)
      ? { tone: "amber", label: "Renewal due", hint: "The mailbox watch has lapsed. Save the events to renew it." }
      : { tone: "emerald", label: "Listening" };
  }

  if (!available) {
    return {
      tone: "muted",
      label: "Not configured",
      hint: "Set STRIPE_SECRET_KEY and STRIPE_INSTALL_LINK on the deployment to enable Stripe.",
    };
  }
  // The account is the workspace's; the trigger is only this agent's events.
  if (!isStripeConnected(stripeConnection)) {
    return stripeConnection?.status === "disconnected"
      ? { tone: "rose", label: "Disconnected", hint: "The Stripe account revoked access. Connect it again, once for the whole workspace." }
      : { tone: "muted", label: "Not connected", hint: "Connect a Stripe account once; every agent in the workspace can then pick its events." };
  }
  if (!trigger) {
    return { tone: "muted", label: "Not listening", hint: `Stripe is connected. Choose the events @${agent.handle} should hear about.` };
  }
  return trigger.events.length > 0
    ? { tone: "emerald", label: "Listening" }
    : { tone: "amber", label: "No events yet", hint: "Stripe is connected — choose the events to listen for." };
}

function Status({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  if (tone === "muted") {
    return <span className="shrink-0 text-xs text-muted-foreground">{children}</span>;
  }
  const color = {
    emerald: "text-emerald-700 dark:text-emerald-400",
    amber: "text-amber-700 dark:text-amber-400",
    rose: "text-rose-700 dark:text-rose-400",
  }[tone];
  return (
    <span className={`flex shrink-0 items-center gap-1.5 text-xs font-medium ${color}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** The webhook URL, on hover only — it's long and rarely needed. */
function WebhookHint({ url }: { url: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground">
            <Link2 className="size-3.5" />
            Webhook
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-[90vw]">
          <span className="font-mono text-[11px] break-all">{url}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
