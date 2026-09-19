import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { Agent } from "@/lib/agents";
import {
  describeCatalogServer,
  describeConnection,
  FEATURED_SERVERS,
  isCustomServerId,
  MORE_SERVERS,
  type McpServerInfo,
} from "@/lib/mcp/catalog";
import type { McpConnectionSummary } from "@/lib/mcp/connections";
import { CollapsibleServers } from "@/components/access/collapsible-servers";
import { ConnectServerCard } from "@/components/access/connect-server-card";
import { CustomServerDialog } from "@/components/access/custom-server-dialog";
import { ServerMark } from "@/components/access/server-mark";

/**
 * Up front: the featured catalog servers and any custom servers already
 * added — those are this agent's own, so they aren't tucked away. The rest of
 * the catalog sits half-hidden below; new custom servers come from the button
 * by the heading.
 */
export function AccessSection({
  agent,
  connections,
}: {
  agent: Agent;
  connections: McpConnectionSummary[];
}) {
  const byServer = new Map(connections.map((connection) => [connection.serverId, connection]));
  const custom = connections
    .filter((connection) => isCustomServerId(connection.serverId))
    .map((connection) => describeConnection(connection))
    .filter((server): server is McpServerInfo => server !== undefined);

  let index = 0;
  const card = (server: McpServerInfo) => {
    const connection = byServer.get(server.id);
    return (
      <Item key={server.id} index={index++}>
        {connection?.status === "authorized" ? (
          <ConnectedServerCard agentId={agent.id} server={server} connection={connection} />
        ) : (
          <ConnectServerCard agentId={agent.id} server={server} removable={server.custom} />
        )}
      </Item>
    );
  };

  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Access</h2>
          <p className="mt-1 text-sm text-muted-foreground">The tools this coworker may use.</p>
        </div>
        <CustomServerDialog agentId={agent.id} />
      </div>

      <CollapsibleServers
        moreCount={MORE_SERVERS.length}
        more={MORE_SERVERS.map((server) => card(describeCatalogServer(server)))}
      >
        {FEATURED_SERVERS.map((server) => card(describeCatalogServer(server)))}
        {custom.map(card)}
      </CollapsibleServers>
    </section>
  );
}

function Item({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <li
      className="animate-in fade-in slide-in-from-bottom-1 duration-500 [animation-fill-mode:backwards]"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      {children}
    </li>
  );
}

function ConnectedServerCard({
  agentId,
  server,
  connection,
}: {
  agentId: string;
  server: McpServerInfo;
  connection: McpConnectionSummary;
}) {
  return (
    <Link
      href={`/app/${agentId}/access/${server.id}`}
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
  );
}

function summarize(connection: McpConnectionSummary) {
  if (connection.toolCount === 0) return "No tools reported yet.";
  const parts = [`${connection.allowedCount} of ${connection.toolCount} tools allowed`];
  if (connection.approvalCount > 0) parts.push(`${connection.approvalCount} need approval`);
  return parts.join(" · ");
}
