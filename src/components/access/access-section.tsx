import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { Agent } from "@/lib/agents";
import { MCP_SERVERS } from "@/lib/mcp/catalog";
import type { McpConnectionSummary } from "@/lib/mcp/connections";
import { ConnectServerCard } from "@/components/access/connect-server-card";
import { ServerMark } from "@/components/access/server-mark";

export function AccessSection({
  agent,
  connections,
}: {
  agent: Agent;
  connections: McpConnectionSummary[];
}) {
  const byServer = new Map(connections.map((connection) => [connection.serverId, connection]));

  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold tracking-tight">Access</h2>
      <p className="mt-1 text-sm text-muted-foreground">The tools this coworker may use.</p>

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
                  className="group flex h-full gap-4 rounded-xl border border-emerald-300/70 bg-emerald-50/40 p-4 transition-all hover:-translate-y-0.5 hover:border-emerald-400/80 hover:shadow-sm dark:border-emerald-800/60 dark:bg-emerald-950/20"
                >
                  <ServerMark
                    name={server.name}
                    className="size-10 border-emerald-700/20 bg-emerald-600 text-white"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="truncate font-medium">{server.name}</h3>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        <span className="size-1.5 rounded-full bg-current" />
                        Connected
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{summarize(connection)}</p>
                    <span className="mt-3 flex items-center gap-1 text-xs font-medium text-emerald-800 transition-colors group-hover:text-emerald-950 dark:text-emerald-300">
                      Manage tools
                      <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </Link>
              ) : (
                <ConnectServerCard agentId={agent.id} server={server} />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function summarize(connection: McpConnectionSummary) {
  if (connection.toolCount === 0) return "No tools reported yet.";
  const parts = [`${connection.allowedCount} of ${connection.toolCount} tools allowed`];
  if (connection.approvalCount > 0) parts.push(`${connection.approvalCount} need approval`);
  return parts.join(" · ");
}
