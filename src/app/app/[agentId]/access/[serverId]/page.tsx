import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CircleAlert } from "lucide-react";

import { auth } from "@/auth";
import { getAgent } from "@/lib/agents";
import { getMcpServer } from "@/lib/mcp/catalog";
import { connectAndListTools, type ConnectResult } from "@/lib/mcp/client";
import { getConnection, listTools, syncTools } from "@/lib/mcp/connections";
import { suggestApproval } from "@/lib/mcp/tools";
import { DisconnectServerButton } from "@/components/access/disconnect-server-button";
import { ServerMark } from "@/components/access/server-mark";
import { ToolAccessForm } from "@/components/access/tool-access-form";

export default async function ToolAccessPage({
  params,
}: PageProps<"/app/[agentId]/access/[serverId]">) {
  const { agentId, serverId } = await params;

  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  const agent = workspaceId ? await getAgent(workspaceId, agentId) : null;
  const server = getMcpServer(serverId);
  if (!agent || !server) notFound();

  const connection = await getConnection(agent.id, server.id);
  if (!connection) redirect(`/app/${agent.id}`);

  // Ask the server for its current tools each time the page opens: servers
  // add and rename tools, and a stale list would let people allow things that
  // no longer exist. If the server can't be reached, fall back to the last
  // list we saved and say so.
  let result: ConnectResult | undefined;
  let warning: string | undefined;
  try {
    result = await connectAndListTools(connection);
  } catch (error) {
    console.error(`Refreshing tools from ${server.id} failed`, error);
    warning = `${server.name} couldn't be reached just now. This is the list from ${
      connection.toolsSyncedAt ? formatTime(connection.toolsSyncedAt) : "the last sync"
    }.`;
  }

  // The stored tokens no longer work and couldn't be refreshed — send the
  // person back through authorization. (Outside the try: redirect throws.)
  if (result?.status === "redirect") redirect(result.url.toString());
  if (result?.status === "authorized") {
    await syncTools(connection.id, result.tools, suggestApproval);
  }

  const tools = await listTools(connection.id);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 duration-500">
      <Link
        href={`/app/${agent.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {agent.name}
      </Link>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <ServerMark name={server.name} className="size-11 text-base" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{server.name}</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Choose which {server.name} tools @{agent.handle} may call, and which of
              those should wait for someone&apos;s approval.
            </p>
          </div>
        </div>
        <DisconnectServerButton
          agentId={agent.id}
          serverId={server.id}
          serverName={server.name}
        />
      </div>

      {warning ? (
        <p
          role="status"
          className="mt-6 flex items-start gap-2.5 rounded-lg border bg-card px-3.5 py-2.5 text-sm text-muted-foreground"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{warning}</span>
        </p>
      ) : null}

      {tools.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed px-6 py-16 text-center text-sm text-muted-foreground">
          {server.name} reported no tools.
        </p>
      ) : (
        <ToolAccessForm
          agentId={agent.id}
          serverId={server.id}
          serverName={server.name}
          agentHandle={agent.handle}
          tools={tools}
          installed={Boolean(agent.slackInstalledAt)}
        />
      )}
    </div>
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
