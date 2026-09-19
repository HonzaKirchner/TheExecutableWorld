import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight, CircleAlert, CircleCheck, Zap } from "lucide-react";

import { auth } from "@/auth";
import { getAgent } from "@/lib/agents";
import { gmailPushUrl, isGmailTriggerConfigured } from "@/lib/gmail/google";
import { GMAIL_EVENTS } from "@/lib/gmail-events";
import { getConnection, listTools } from "@/lib/mcp/connections";
import { MCP_CALLBACK_PATH } from "@/lib/mcp/oauth-provider";
import { baseUrl } from "@/lib/base-url";
import { missingScopes, SLACK_EVENTS } from "@/lib/slack-events-catalog";
import { isStripeConfigured, stripeConnectRedirectUri, stripeEventsUrl } from "@/lib/stripe";
import { STRIPE_EVENTS } from "@/lib/stripe-events";
import { getStripeEndpoint } from "@/lib/stripe-webhook";
import {
  getTrigger,
  getTriggerDefinition,
  gmailWatchLapsed,
  isTriggerKind,
  slackEventsUrl,
  type Trigger,
} from "@/lib/triggers";
import { FlashToast } from "@/components/flash-toast";
import {
  ConnectGmailButton,
  StartGmailWatchButton,
  StopGmailWatchButton,
} from "@/components/triggers/gmail-buttons";
import {
  ConnectStripeButton,
  ConnectStripeToolsButton,
  DisconnectStripeButton,
} from "@/components/triggers/stripe-buttons";
import { TriggerEventsForm } from "@/components/triggers/trigger-events-form";
import { InstallSlackButton } from "@/components/access/install-slack-button";
import { Badge } from "@/components/ui/badge";

/** The tool on Stripe's MCP server that performs every write, refunds included. */
const STRIPE_WRITE_TOOL = "stripe_api_write";

const ERRORS: Record<string, string> = {
  stripe_failed: "Stripe didn't complete the connection. Try again.",
  stripe_wrong_workspace:
    "That connection was started from another workspace's session, so it was ignored.",
  slack_failed: "Slack didn't complete the install. Try again.",
  slack_wrong_workspace:
    "The app was installed into a different Slack workspace than this agent belongs to, so the install was undone. Pick this workspace when Slack asks.",
};

const CANCELLATIONS: Record<string, string> = {
  stripe_denied: "The Stripe connection was cancelled.",
  slack_denied: "The Slack install was cancelled.",
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
                : kind === "stripe"
                  ? `Which Stripe events reach @${agent.handle}. They come from the Stripe account you connect here.`
                  : `What in Gmail wakes @${agent.handle}. Notifications come from the Google account connected under Access.`}
            </p>
          </div>
        </div>
        {kind === "stripe" && trigger ? <DisconnectStripeButton agentId={agent.id} /> : null}
        {kind === "gmail" && trigger ? <StopGmailWatchButton agentId={agent.id} /> : null}
      </div>

      {query.connected === "1" ? (
        <Notice icon={CircleCheck}>Stripe account connected. Now pick the events to listen for.</Notice>
      ) : null}
      {query.installed === "1" ? (
        <Notice icon={CircleCheck}>
          Installed. @{agent.handle} is in your Slack workspace — now choose the events it
          listens for.
        </Notice>
      ) : null}
      {query.started === "1" ? (
        <Notice icon={CircleCheck}>Listening. New mail in the inbox now reaches @{agent.handle}.</Notice>
      ) : null}
      {error ? (
        <Notice icon={CircleAlert} tone="error">
          {error}
        </Notice>
      ) : null}
      {cancelled ? <FlashToast message={cancelled} /> : null}

      {kind === "slack" ? (
        <SlackDetail agent={agent} trigger={trigger} />
      ) : kind === "stripe" ? (
        <StripeDetail agent={agent} trigger={trigger} />
      ) : (
        <GmailDetail agent={agent} trigger={trigger} />
      )}
    </div>
  );
}

async function GmailDetail({
  agent,
  trigger,
}: {
  agent: Awaited<ReturnType<typeof getAgent>> & object;
  trigger: Trigger | null;
}) {
  if (!isGmailTriggerConfigured()) {
    return (
      <section className="mt-8 rounded-xl border border-dashed px-6 py-10 text-sm">
        <h2 className="font-medium">Gmail isn&apos;t configured on this deployment</h2>
        <p className="mt-2 max-w-xl text-muted-foreground">
          Mailboxes are watched through Gmail&apos;s push notifications, which arrive over a
          Google Cloud Pub/Sub topic. The environment needs:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <code className="font-mono text-xs">GOOGLE_CLIENT_ID</code> /{" "}
            <code className="font-mono text-xs">GOOGLE_CLIENT_SECRET</code> — an OAuth client in a
            Cloud project with the Gmail API enabled, allowing the redirect URI{" "}
            <code className="font-mono text-xs break-all">{`${baseUrl()}${MCP_CALLBACK_PATH}`}</code>.
          </li>
          <li>
            <code className="font-mono text-xs">GMAIL_PUBSUB_TOPIC</code> — a Pub/Sub topic
            (<code className="font-mono text-xs">projects/…/topics/…</code>) that{" "}
            <code className="font-mono text-xs">gmail-api-push@system.gserviceaccount.com</code> may
            publish to.
          </li>
          <li>
            <code className="font-mono text-xs">GMAIL_PUBSUB_TOKEN</code> — a random secret. Give the
            topic a push subscription to{" "}
            <code className="font-mono text-xs break-all">{gmailPushUrl()}?token=&lt;that secret&gt;</code>.
          </li>
        </ul>
      </section>
    );
  }

  const connection = await getConnection(agent.id, "gmail");
  if (connection?.status !== "authorized") {
    return (
      <section className="mt-8 rounded-2xl border border-rose-200/70 bg-gradient-to-br from-rose-50 via-orange-50/60 to-amber-50/50 px-6 py-8 sm:px-8 dark:border-rose-900/50 dark:from-rose-950/40 dark:via-orange-950/20 dark:to-amber-950/10">
        <h2 className="text-lg font-semibold tracking-tight">Connect Gmail first</h2>
        <p className="mt-1 max-w-lg text-sm text-muted-foreground">
          The trigger listens on the Google account @{agent.handle} has under Access — the same
          grant that gives it its Gmail tools. Google will ask you to approve; afterwards, come
          back here to start listening.
        </p>
        <div className="mt-5">
          <ConnectGmailButton agentId={agent.id} />
        </div>
      </section>
    );
  }

  if (!trigger || trigger.status !== "active") {
    return (
      <section className="mt-8 rounded-2xl border border-rose-200/70 bg-gradient-to-br from-rose-50 via-orange-50/60 to-amber-50/50 px-6 py-8 sm:px-8 dark:border-rose-900/50 dark:from-rose-950/40 dark:via-orange-950/20 dark:to-amber-950/10">
        <h2 className="text-lg font-semibold tracking-tight">Start listening to the inbox</h2>
        <p className="mt-1 max-w-lg text-sm text-muted-foreground">
          Gmail will notify this deployment whenever mail arrives, and @{agent.handle} hears
          about it. You can add starred mail as a second event afterwards.
          {trigger?.status === "disconnected"
            ? " The previous watch stopped because Google no longer honoured the tokens; the connection has since been renewed."
            : null}
        </p>
        <div className="mt-5">
          <StartGmailWatchButton agentId={agent.id} />
        </div>
      </section>
    );
  }

  const lapsed = gmailWatchLapsed(trigger);

  return (
    <>
      <dl className="mt-8 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-[1fr_2fr]">
        <Field label="Status">
          {lapsed ? <Dot tone="amber">Renewal due</Dot> : <Dot tone="emerald">Listening</Dot>}
        </Field>
        <Field label="Mailbox">
          <span className="font-mono text-xs">{trigger.accountId}</span>
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
        <Field label="Watch">
          {trigger.watchExpiresAt ? (
            <>
              {lapsed ? "Lapsed" : "Renews before"} {formatTime(trigger.watchExpiresAt)}
              <span className="mt-1 block text-xs text-muted-foreground">
                Gmail forgets a watch after seven days; it&apos;s renewed daily and whenever a
                notification arrives.
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Unknown</span>
          )}
        </Field>
        <Field label="Push endpoint" className="sm:col-span-2">
          <span className="font-mono text-xs break-all">{gmailPushUrl()}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            The Pub/Sub subscription pushes here, with the deployment&apos;s token in the query.
          </span>
        </Field>
      </dl>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">Events</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        What in the mailbox @{agent.handle} hears about. Saving re-issues the watch with the
        labels these need{lapsed ? ", which also renews it" : ""}.
      </p>
      <TriggerEventsForm
        agentId={agent.id}
        kind="gmail"
        options={GMAIL_EVENTS.map(({ id, name, description, required }) => ({
          id,
          name,
          description,
          required,
        }))}
        selected={trigger.events}
      />
    </>
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
      {agent.slackInstalledAt ? null : (
        <section className="mt-8 rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50 via-fuchsia-50/60 to-rose-50/50 px-6 py-8 sm:px-8 dark:border-violet-900/50 dark:from-violet-950/40 dark:via-fuchsia-950/20 dark:to-rose-950/10">
          <h2 className="text-lg font-semibold tracking-tight">Install @{agent.handle} to Slack first</h2>
          <p className="mt-1 max-w-lg text-sm text-muted-foreground">
            Nothing reaches the agent until its app is in the workspace. Slack will ask you to
            approve the app&apos;s permissions; afterwards you land back here to choose the
            events.
          </p>
          <div className="mt-5">
            <InstallSlackButton agentId={agent.id} accent returnTo="trigger" align="start" />
          </div>
        </section>
      )}

      <dl className="mt-8 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-[1fr_2fr]">
        <Field label="Status">
          {agent.slackInstalledAt ? (
            missing.length > 0 ? (
              <Dot tone="amber">Reinstall needed</Dot>
            ) : (
              <Dot tone="emerald">Active</Dot>
            )
          ) : (
            <Dot tone="amber">Not installed</Dot>
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
          <code className="font-mono text-xs">allowed_redirect_uris</code>.
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

  const [endpoint, tools] = await Promise.all([getStripeEndpoint(), getConnection(agent.id, "stripe")]);

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
              : "Registered at Stripe when an account connects."}
          </span>
        </Field>
      </dl>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">Events</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Stripe sends the connected account&apos;s events to one shared webhook; only the types
        chosen here reach @{agent.handle}.
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

      <StripeActions agent={agent} connection={tools} />
    </>
  );
}

/**
 * Hearing about payments and acting on them are two separate grants: events
 * come from the Stripe App installed above, actions — refunds first among
 * them — from Stripe's own MCP server, connected like any server under
 * Access. This is the same card, placed where the question comes up.
 *
 * Stripe's server has no per-object tools: every write, refunds included,
 * goes through `stripe_api_write`, so that one tool is what "may refund"
 * comes down to. Stripe adds its own check on top — a refund asked for over
 * OAuth stops until a person approves it at a link Stripe hands back.
 */
async function StripeActions({
  agent,
  connection,
}: {
  agent: Awaited<ReturnType<typeof getAgent>> & object;
  connection: Awaited<ReturnType<typeof getConnection>>;
}) {
  const authorized = connection?.status === "authorized";
  const tools = authorized ? await listTools(connection.id) : [];
  const allowed = tools.filter((tool) => tool.allowed);
  const write = tools.find((tool) => tool.name === STRIPE_WRITE_TOOL);

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight">Actions</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Events only tell @{agent.handle} what happened. To let it act — refund a payment, look
        up a customer, cancel a subscription — connect Stripe&apos;s own MCP server, the same as
        any server under Access. Stripe asks which account to grant. Each tool is off until you
        allow it; refunds and every other change go through the one write tool, and Stripe
        itself holds a refund until someone approves it at a link it sends back.
      </p>

      {authorized ? (
        <Link
          href={`/app/${agent.id}/access/stripe`}
          className="group mt-4 flex items-center justify-between gap-4 rounded-xl border border-emerald-300/70 bg-emerald-50/40 px-5 py-4 transition-all hover:-translate-y-0.5 hover:border-emerald-400/80 hover:shadow-sm dark:border-emerald-800/60 dark:bg-emerald-950/20"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Dot tone="emerald">Stripe tools connected</Dot>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {tools.length === 0
                ? "No tools reported yet."
                : `${allowed.length} of ${tools.length} tools allowed`}
              {write
                ? write.allowed
                  ? write.requiresApproval
                    ? " · may refund, with approval"
                    : " · may refund without approval"
                  : " · read-only: refunds not allowed yet"
                : null}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-800 dark:text-emerald-300">
            Manage tools
            <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      ) : (
        <div className="mt-4">
          <ConnectStripeToolsButton agentId={agent.id} />
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-card px-5 py-4 ${className}`}>
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
