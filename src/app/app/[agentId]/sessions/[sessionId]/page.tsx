import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft } from "lucide-react";

import { auth } from "@/auth";
import { getAgent } from "@/lib/agents";
import { agentSessionsPath, getAgentSession, listSessionEvents } from "@/lib/sessions";
import { SessionView } from "@/components/sessions/session-view";
import { ShareSessionLink } from "@/components/sessions/share-session-link";

export async function generateMetadata({
  params,
}: PageProps<"/app/[agentId]/sessions/[sessionId]">): Promise<Metadata> {
  const { agentId } = await params;
  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  const agent = workspaceId ? await getAgent(workspaceId, agentId) : null;
  return { title: agent ? `@${agent.handle} — session` : "Session" };
}

/**
 * One run, inside the app. Scoped to the workspace like every other page
 * under /app; the same transcript is readable by anyone at the public link,
 * which is what the share button hands out.
 */
export default async function AgentSessionPage({
  params,
}: PageProps<"/app/[agentId]/sessions/[sessionId]">) {
  const { agentId, sessionId } = await params;

  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  const agent = workspaceId ? await getAgent(workspaceId, agentId) : null;
  if (!agent) notFound();

  await connection();
  const run = await getAgentSession(agent.id, sessionId);
  if (!run) notFound();

  const events = await listSessionEvents(run.id);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 mx-auto max-w-3xl duration-500">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={agentSessionsPath(agent.id)}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Sessions
        </Link>
        <ShareSessionLink sessionId={run.id} />
      </div>

      <div className="mt-6">
        <SessionView session={run} events={events} />
      </div>
    </div>
  );
}
