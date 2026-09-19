import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ArrowLeft } from "lucide-react";

import { auth } from "@/auth";
import {
  agentSessionsPath,
  getSession,
  getSessionAgentId,
  listSessionEvents,
} from "@/lib/sessions";
import { SessionView } from "@/components/sessions/session-view";

/**
 * A session transcript, readable by anyone with the link — this route is
 * outside the gate in src/proxy.ts on purpose, so that a run can be shared
 * with someone who has no account here.
 *
 * Read-only: there is nothing to submit on this page, and the queries behind
 * it only select. What it shows is whatever the run recorded, which is only
 * ever text meant to be read (see src/lib/sessions.ts).
 */

export async function generateMetadata({
  params,
}: PageProps<"/s/[sessionId]">): Promise<Metadata> {
  const { sessionId } = await params;
  const session = await getSession(sessionId);
  return {
    title: session ? `@${session.agentHandle} — session` : "Session not found",
    // The id is unguessable, not secret — but a link that lands in a search
    // index stops being unguessable.
    robots: { index: false, follow: false },
  };
}

export default async function SessionPage({ params }: PageProps<"/s/[sessionId]">) {
  const { sessionId } = await params;

  // A transcript is never worth serving from a cache — a running one changes
  // by the second, and a finished one is read once.
  await connection();

  const session = await getSession(sessionId);
  if (!session) notFound();

  // Someone who followed the link out of Slack and is signed in here should
  // be able to get to the rest of the agent's runs, not just this one. The
  // link only appears when the agent is in their workspace; the transcript
  // itself is shown to everyone regardless.
  const viewer = await auth();
  const workspaceId = viewer?.slack?.teamId;
  const [events, agentId] = await Promise.all([
    listSessionEvents(sessionId),
    workspaceId ? getSessionAgentId(sessionId, workspaceId) : Promise.resolve(null),
  ]);

  return (
    <main className="animate-in fade-in mx-auto w-full max-w-3xl px-6 py-12 duration-500 sm:py-16">
      {agentId ? (
        <Link
          href={agentSessionsPath(agentId)}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Sessions
        </Link>
      ) : null}

      <SessionView session={session} events={events} />

      <p className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Read-only view. Anyone with this link can read this transcript.
        <br />
        <span className="font-mono">{session.id}</span>
      </p>
    </main>
  );
}
