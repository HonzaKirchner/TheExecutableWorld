import Link from "next/link";
import { ChevronRight, Link2, Zap } from "lucide-react";

import type { Agent } from "@/lib/agents";
import { isGmailTriggerConfigured } from "@/lib/gmail/google";
import { isStripeConfigured } from "@/lib/stripe";
import {
  gmailWatchLapsed,
  slackEventsUrl,
  TRIGGERS,
  type Trigger,
  type TriggerKind,
} from "@/lib/triggers";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Tone = "emerald" | "amber" | "rose" | "muted";

export function TriggersSection({
  agent,
  triggers,
  gmailConnected,
}: {
  agent: Agent;
  triggers: Trigger[];
  /** Whether the agent's Gmail MCP connection is authorized — the Gmail trigger listens through it. */
  gmailConnected: boolean;
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
        What makes this coworker act. Open one to choose its events.
      </p>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {TRIGGERS.map((definition, i) => {
          const trigger = byKind.get(definition.id) ?? null;
          const available = configured[definition.id];
          const { tone, label, hint } = describe(definition.id, trigger, agent, available, gmailConnected);
          const active = tone === "emerald";

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

                {available ? (
                  <span className="mt-3 flex items-center gap-0.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                    {trigger ? "Manage events" : "Set up"}
                    <ChevronRight className="size-3.5" />
                  </span>
                ) : null}
              </div>
            </>
          );

          const className =
            "group flex h-full gap-4 rounded-xl border bg-card p-4 transition-all animate-in fade-in slide-in-from-bottom-1 duration-500 [animation-fill-mode:backwards]";

          return (
            <li key={definition.id} style={{ animationDelay: `${i * 40}ms` }} className="contents">
              {available ? (
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

function describe(
  kind: TriggerKind,
  trigger: Trigger | null,
  agent: Agent,
  available: boolean,
  gmailConnected: boolean,
): { tone: Tone; label: string; hint?: string } {
  if (kind === "slack") {
    if (!trigger) return { tone: "muted", label: "Not added" };
    return agent.slackInstalledAt
      ? { tone: "emerald", label: "Active" }
      : { tone: "amber", label: "Waiting for install" };
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
        ? { tone: "muted", label: "Not listening", hint: "Gmail is connected. Start listening to wake the agent on new mail." }
        : { tone: "muted", label: "Not connected", hint: "Connect Gmail under Access, then start listening here." };
    }
    if (trigger.status === "disconnected") {
      return { tone: "rose", label: "Disconnected", hint: "Google stopped honouring the tokens. Connect Gmail again." };
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
  if (!trigger) return { tone: "muted", label: "Not connected" };
  switch (trigger.status) {
    case "active":
      return trigger.events.length > 0
        ? { tone: "emerald", label: "Connected" }
        : { tone: "amber", label: "No events yet", hint: "Connected — choose the events to listen for." };
    case "pending":
      return { tone: "amber", label: "Waiting for Stripe" };
    case "disconnected":
      return { tone: "rose", label: "Disconnected", hint: "The account revoked access. Connect it again." };
  }
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
