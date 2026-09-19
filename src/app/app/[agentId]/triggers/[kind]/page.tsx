import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CircleAlert, CircleCheck, Zap } from "lucide-react";

import { auth } from "@/auth";
import { getAgent } from "@/lib/agents";
import { missingScopes, SLACK_EVENTS } from "@/lib/slack-events-catalog";
import { isStripeConfigured, stripeConnectRedirectUri, stripeEventsUrl } from "@/lib/stripe";
import { STRIPE_EVENTS } from "@/lib/stripe-events";
import { getStripeEndpoint } from "@/lib/stripe-webhook";
import {
  getTrigger,
  getTriggerDefinition,
  isTriggerKind,
  slackEventsUrl,
  type Trigger,
} from "@/lib/triggers";
import { FlashToast } from "@/components/flash-toast";
import { ConnectStripeButton, DisconnectStripeButton } from "@/components/triggers/stripe-buttons";
import { TriggerEventsForm } from "@/components/triggers/trigger-events-form";
import { Badge } from "@/components/ui/badge";

const ERRORS: Record<string, string> = {
  stripe_failed: "Stripe didn't complete the connection. Try again.",
  stripe_wrong_workspace:
    "That connection was started from another workspace's session, so it was ignored.",
};

const CANCELLATIONS: Record<string, string> = {
  stripe_denied: "The Stripe connection was cancelled.",
};

export default async function TriggerPage({
  params,
  searchParams,
}: PageProps<"/app/[agentId]/triggers/[kind]">) {
  const [{ agentId, kind }, query] = await Promise.all([params, searchParams]);
  if (!isTriggerKind(kind)) notFound();

  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  const agent = workspaceId ? await getAgent(workspaceId, agentId) : null;
  if (!agent) notFound();

  const definition = getTriggerDefinition(kind);
  const trigger = await getTrigger(agent.id, kind);

  const code = typeof query.error === "string" ? query.error : undefined;
  const error = code ? ERRORS[code] : undefined;
  const cancelled = code ? CANCELLATIONS[code] : undefined;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 duration-500">
      <Link
        href={`/app/${agent.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        @{agent.handle}
      </Link>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted text-muted-foreground">
            <Zap className="size-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{definition.name} trigger</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              {kind === "slack"
                ? `What in Slack makes @${agent.handle} act. Each event needs the app to hold the matching permission.`
                : `Which Stripe events reach @${agent.handle}. They come from the Stripe account you connect here.`}
            </p>
          </div>
        </div>
        {kind === "stripe" && trigger ? <DisconnectStripeButton agentId={agent.id} /> : null}
      </div>

      {query.connected === "1" ? (
        <Notice icon={CircleCheck}>Stripe account connected. Now pick the events to listen for.</Notice>
      ) : null}
      {error ? (
        <Notice icon={CircleAlert} tone="error">
          {error}
        </Notice>
      ) : null}
      {cancelled ? <FlashToast message={cancelled} /> : null}

      {kind === "slack" ? (
        <SlackDetail agent={agent} trigger={trigger} />
      ) : (
        <StripeDetail agent={agent} trigger={trigger} />
      )}
    </div>
  );
}

async function SlackDetail({
  agent,
  trigger,
}: {
  agent: Awaited<ReturnType<typeof getAgent>> & object;
  trigger: Trigger | null;
}) {
  if (!trigger) {
    return (
      <p className="mt-8 rounded-xl border border-dashed px-6 py-16 text-center text-sm text-muted-foreground">
        This agent has no Slack trigger.
      </p>
    );
  }

  const missing = agent.slackInstalledAt ? missingScopes(trigger.events, agent.slackBotScopes) : [];

  return (
    <>
      <dl className="mt-8 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-[1fr_2fr]">
        <Field label="Status">
          {agent.slackInstalledAt ? (
            missing.length > 0 ? (
              <Dot tone="amber">Reinstall needed</Dot>
            ) : (
              <Dot tone="emerald">Active</Dot>
            )
          ) : (
            <Dot tone="amber">Waiting for install</Dot>
          )}
        </Field>
        <Field label="Webhook">
          <span className="font-mono text-xs break-all">{slackEventsUrl(trigger.id)}</span>
        </Field>
        <Field label="Last event">
          {trigger.lastEventAt ? (
            <>
              <code className="font-mono text-xs">{trigger.lastEventType}</code>{" "}
              <span className="text-muted-foreground">· {formatTime(trigger.lastEventAt)}</span>
            </>
          ) : (
            <span className="text-muted-foreground">None yet</span>
          )}
        </Field>
        <Field label="Slack app">
          {agent.slackAppId ? (
            <a
              href={`https://api.slack.com/apps/${agent.slackAppId}/event-subscriptions`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs underline-offset-4 hover:underline"
            >
              {agent.slackAppId}
            </a>
          ) : (
            <span className="text-muted-foreground">Not created</span>
          )}
        </Field>
      </dl>

      {missing.length > 0 ? (
        <Notice icon={CircleAlert}>
          The events need permissions the install didn&apos;t grant ({missing.join(", ")}).
          Reinstall the app from the agent&apos;s page so Slack asks for them.
        </Notice>
      ) : null}

      <h2 className="mt-10 text-lg font-semibold tracking-tight">Events</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Slack sends these to the webhook. @{agent.handle} answers mentions and DMs; the rest
        are received and, for now, only noted.
      </p>
      <TriggerEventsForm
        agentId={agent.id}
        kind="slack"
        options={SLACK_EVENTS.map(({ id, name, description, required }) => ({
          id,
          name,
          description,
          required,
        }))}
        selected={trigger.events}
        granted={agent.slackBotScopes}
      />
    </>
  );
}

async function StripeDetail({
  agent,
  trigger,
}: {
  agent: Awaited<ReturnType<typeof getAgent>> & object;
  trigger: Trigger | null;
}) {
  if (!isStripeConfigured()) {
    return (
      <section className="mt-8 rounded-xl border border-dashed px-6 py-10 text-sm">
        <h2 className="font-medium">Stripe isn&apos;t configured on this deployment</h2>
        <p className="mt-2 max-w-xl text-muted-foreground">
          Accounts connect by installing this deployment&apos;s Stripe App (one that
          authenticates with OAuth). The environment needs:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <code className="font-mono text-xs">STRIPE_SECRET_KEY</code> — the app developer
            account&apos;s secret key, in the same mode as the install link.
          </li>
          <li>
            <code className="font-mono text-xs">STRIPE_INSTALL_LINK</code> — an install link
            copied from the app&apos;s External test tab (test mode while testing), used as is.
          </li>
        </ul>
        <p className="mt-3 max-w-xl text-muted-foreground">
          The app manifest must list{" "}
          <code className="font-mono text-xs break-all">{stripeConnectRedirectUri()}</code> in{" "}
          <code className="font-mono text-xs">allowed_redirect_uris</code>, and grant{" "}
          <code className="font-mono text-xs">event_read</code> plus a permission per event
          object.
        </p>
      </section>
    );
  }

  const connected = trigger?.status === "active" && trigger.accountId;

  if (!connected) {
    return (
      <section className="mt-8 rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-indigo-50 via-sky-50/60 to-violet-50/50 px-6 py-8 sm:px-8 dark:border-indigo-900/50 dark:from-indigo-950/40 dark:via-sky-950/20 dark:to-violet-950/10">
        <h2 className="text-lg font-semibold tracking-tight">Connect a Stripe account</h2>
        <p className="mt-1 max-w-lg text-sm text-muted-foreground">
          Stripe will ask you to pick the account and approve the app&apos;s permissions. After
          that you choose which of its events @{agent.handle} should hear about.
          {trigger?.status === "disconnected"
            ? " The previous connection was revoked from Stripe's side."
            : null}
        </p>
        <div className="mt-5">
          <ConnectStripeButton agentId={agent.id} />
        </div>
      </section>
    );
  }

  const endpoint = await getStripeEndpoint();

  return (
    <>
      <dl className="mt-8 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-[1fr_2fr]">
        <Field label="Status">
          <Dot tone="emerald">Connected</Dot>
        </Field>
        <Field label="Stripe account">
          <a
            href={`https://dashboard.stripe.com/${trigger.accountId}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            {trigger.accountId}
          </a>
        </Field>
        <Field label="Last event">
          {trigger.lastEventAt ? (
            <>
              <code className="font-mono text-xs">{trigger.lastEventType}</code>{" "}
              <span className="text-muted-foreground">· {formatTime(trigger.lastEventAt)}</span>
            </>
          ) : (
            <span className="text-muted-foreground">None yet</span>
          )}
        </Field>
        <Field label="Webhook">
          <span className="font-mono text-xs break-all">{stripeEventsUrl()}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {endpoint
              ? `Registered at Stripe as ${endpoint.endpointId}${endpoint.livemode ? "" : " (test mode)"}.`
              : "Registered at Stripe the first time events are saved."}
          </span>
        </Field>
      </dl>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">Events</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Stripe sends these for the connected account.
        {trigger.events.length > 0 ? (
          <>
            {" "}
            Listening for{" "}
            {trigger.events.map((event) => (
              <Badge key={event} variant="outline" className="mr-1 font-mono text-[10px]">
                {event}
              </Badge>
            ))}
          </>
        ) : (
          " Nothing yet — pick some below."
        )}
      </p>
      <TriggerEventsForm
        agentId={agent.id}
        kind="stripe"
        options={STRIPE_EVENTS.map(({ id, name, description }) => ({ id, name, description }))}
        selected={trigger.events}
      />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-card px-5 py-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function Dot({ tone, children }: { tone: "emerald" | "amber"; children: React.ReactNode }) {
  const color =
    tone === "emerald"
      ? "text-emerald-700 dark:text-emerald-400"
      : "text-amber-700 dark:text-amber-400";
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${color}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

function Notice({
  icon: Icon,
  tone = "info",
  children,
}: {
  icon: typeof CircleCheck;
  tone?: "info" | "error";
  children: React.ReactNode;
}) {
  return (
    <p
      role="status"
      className={`animate-in fade-in mt-6 flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${
        tone === "error" ? "border-destructive/30 bg-destructive/5 text-destructive" : "bg-card"
      }`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
