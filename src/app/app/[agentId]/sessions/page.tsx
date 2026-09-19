import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft } from "lucide-react";

import { auth } from "@/auth";
import { getAgent } from "@/lib/agents";
import { listAgentSessions } from "@/lib/sessions";
import { SessionList } from "@/components/sessions/sessions-section";

/** How many runs the page lists. Older ones fall off the end for now. */
const PAGE_SIZE = 100;

/** Every run of one agent, newest first. */
export default async function AgentSessionsPage({
  params,
}: PageProps<"/app/[agentId]/sessions">) {
  const { agentId } = await params;

  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  const agent = workspaceId ? await getAgent(workspaceId, agentId) : null;
  if (!agent) notFound();

  // A running session changes by the second; never serve this from a cache.
  await connection();
  const sessions = await listAgentSessions(agent.id, PAGE_SIZE);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 duration-500">
      <Link
        href={`/app/${agent.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        @{agent.handle}
      </Link>

      <div className="mt-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every run of @{agent.handle}, newest first. Open one for its transcript.
        </p>
      </div>

      <SessionList agentId={agent.id} sessions={sessions} className="mt-8" />

      {sessions.length >= PAGE_SIZE ? (
        <p className="mt-3 text-xs text-muted-foreground">Showing the latest {PAGE_SIZE}.</p>
      ) : null}
    </div>
  );
}
