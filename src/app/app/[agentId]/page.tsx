import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, CircleAlert, CircleCheck } from "lucide-react";

import { auth } from "@/auth";
import { getAgent } from "@/lib/agents";
import { listConnections } from "@/lib/mcp/connections";
import { listTriggers } from "@/lib/triggers";
import { AccessSection } from "@/components/access/access-section";
import { InstallSlackPanel } from "@/components/access/install-slack-panel";
import { FlashToast } from "@/components/flash-toast";
import { TriggersSection } from "@/components/triggers-section";
import { Badge } from "@/components/ui/badge";

/**
 * The OAuth callbacks land back here and can only say what happened through
 * the URL. Codes rather than text, so nothing in the query string is rendered
 * as-is. Things that went wrong stay on the page; things the person chose to
 * cancel only get a passing toast.
 */
const ERRORS: Record<string, string> = {
  mcp_failed: "Authorizing the server didn't finish. Try connecting again.",
  slack_failed: "Slack didn't complete the install. Try again.",
  slack_wrong_workspace:
    "The app was installed into a different Slack workspace than this agent belongs to, so the install was undone. Pick this workspace when Slack asks.",
};

const CANCELLATIONS: Record<string, string> = {
  mcp_denied: "Authorization was declined — nothing was connected.",
  slack_denied: "The Slack install was cancelled.",
};

export default async function AgentDetailPage({
  params,
  searchParams,
}: PageProps<"/app/[agentId]">) {
  const [{ agentId }, query] = await Promise.all([params, searchParams]);

  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  const agent = workspaceId ? await getAgent(workspaceId, agentId) : null;

  if (!agent) notFound();

  const [connections, triggers] = await Promise.all([
    listConnections(agent.id),
    listTriggers(agent.id),
  ]);
  const installed = query.installed === "1";
  const code = typeof query.error === "string" ? query.error : undefined;
  const error = code ? ERRORS[code] : undefined;
  const cancelled = code ? CANCELLATIONS[code] : undefined;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 duration-500">
      <Link
        href="/app"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Agents
      </Link>

      <div className="mt-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="text-muted-foreground">@</span>
            {agent.handle}
          </h1>
          {agent.slackInstalledAt ? (
            <Badge variant="outline" className="gap-1 text-xs">
              <CircleCheck className="size-3" />
              In Slack
            </Badge>
          ) : null}
        </div>
        {agent.description ? (
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            {agent.description}
          </p>
        ) : null}
      </div>

      {installed ? (
        <Notice icon={CircleCheck}>
          Installed. @{agent.handle} is now in your Slack workspace.
        </Notice>
      ) : null}
      {error ? (
        <Notice icon={CircleAlert} tone="error">
          {error}
        </Notice>
      ) : null}
      {cancelled ? <FlashToast message={cancelled} /> : null}

      <section className="mt-8 overflow-hidden rounded-xl border bg-card">
        <div className="p-6 sm:p-7">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Instructions
          </h2>
          <p className="mt-3 max-w-3xl text-[15px] leading-7 whitespace-pre-wrap">
            {agent.instructions ?? "No instructions yet."}
          </p>
        </div>

        <dl className="grid gap-px border-t bg-border sm:grid-cols-3">
        <Field label="Model" value={agent.model} mono />
        <Field
          label="Created"
          value={new Date(agent.createdAt).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        />
        <Field
          label="Slack app"
          value={agent.slackAppId ?? "Not created"}
          mono={Boolean(agent.slackAppId)}
          // Slack's own configuration page for the app — scopes, event
          // subscriptions, credentials.
          href={agent.slackAppId ? `https://api.slack.com/apps/${agent.slackAppId}` : undefined}
        />
        </dl>
      </section>

      <TriggersSection agent={agent} triggers={triggers} />

      <AccessSection agent={agent} connections={connections} />

      <InstallSlackPanel agent={agent} />
    </div>
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
        tone === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "bg-card"
      }`}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Field({
  label,
  value,
  mono,
  href,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** Makes the value a link, opened in a new tab. */
  href?: string;
}) {
  const className = `mt-1 truncate text-sm ${mono ? "font-mono text-xs" : ""}`;
  return (
    <div className="bg-card px-5 py-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={className} title={value}>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1 underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            <span className="truncate">{value}</span>
            <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
