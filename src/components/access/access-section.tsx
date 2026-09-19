import Link from "next/link";
import { ChevronRight, Hash } from "lucide-react";

import type { Agent } from "@/lib/agents";
import { MCP_SERVERS } from "@/lib/mcp/catalog";
import type { McpConnectionSummary } from "@/lib/mcp/connections";
import { ConnectServerCard } from "@/components/access/connect-server-card";
import { InstallSlackButton } from "@/components/access/install-slack-button";
import { ServerMark } from "@/components/access/server-mark";
import { Badge } from "@/components/ui/badge";

export function AccessSection({
  agent,
  connections,
}: {
  agent: Agent;
  connections: McpConnectionSummary[];
}) {
  const byServer = new Map(connections.map((connection) => [connection.serverId, connection]));
  const installed = Boolean(agent.slackInstalledAt);

  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Access</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect the tools this coworker may use, then install it to Slack.
          </p>
        </div>
      </div>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {MCP_SERVERS.map((server, i) => {
          const connection = byServer.get(server.id);
          return (
            <li
              key={server.id}
              className="animate-in fade-in slide-in-from-bottom-1 duration-500 [animation-fill-mode:backwards]"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              {connection?.status === "authorized" ? (
                <Link
                  href={`/app/${agent.id}/access/${server.id}`}
                  className="group flex h-full flex-col rounded-xl border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-border/80 hover:shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <ServerMark name={server.name} />
                    <span className="flex items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                      Manage
                      <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                  <h3 className="mt-4 font-medium">{server.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {summarize(connection)}
                  </p>
                </Link>
              ) : (
                <ConnectServerCard agentId={agent.id} server={server} />
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card px-5 py-4">
        <div className="flex items-center gap-4">
          <span className="flex size-9 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
            <Hash className="size-4" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-medium">Slack</h3>
              {installed ? (
                <Badge variant="secondary" className="text-[10px]">
                  Installed
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {installed
                ? `@${agent.handle} has been in your workspace since ${formatDate(agent.slackInstalledAt!)}.`
                : `Not installed yet — installing brings @${agent.handle} into your workspace.`}
            </p>
          </div>
        </div>
        <InstallSlackButton agentId={agent.id} reinstall={installed} />
      </div>
    </section>
  );
}

function summarize(connection: McpConnectionSummary) {
  if (connection.toolCount === 0) return "No tools reported yet.";
  const parts = [
    `${connection.allowedCount} of ${connection.toolCount} tools allowed`,
  ];
  if (connection.approvalCount > 0) parts.push(`${connection.approvalCount} need approval`);
  return parts.join(" · ");
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
