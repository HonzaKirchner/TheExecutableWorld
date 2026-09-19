import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Zap } from "lucide-react";

import { getSession, listSessionEvents } from "@/lib/sessions";
import { SessionTranscript } from "@/components/sessions/session-transcript";
import { Badge } from "@/components/ui/badge";

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

  const events = await listSessionEvents(sessionId);

  return (
    <main className="animate-in fade-in mx-auto w-full max-w-3xl px-6 py-12 duration-500 sm:py-16">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Session
        </span>
        <Badge variant="outline" className="gap-1 text-xs">
          <Zap className="size-3" />
          {session.triggerKind}
        </Badge>
      </div>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        <span className="text-muted-foreground">@</span>
        {session.agentHandle}
      </h1>
      {session.title ? (
        <p className="mt-1.5 text-sm text-muted-foreground">{session.title}</p>
      ) : null}

      <p className="mt-3 text-xs text-muted-foreground">
        <Started at={session.startedAt} />
        {session.endedAt ? <> · {duration(session.startedAt, session.endedAt)}</> : null}
      </p>

      {session.error ? (
        <p className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
          {session.error}
        </p>
      ) : null}

      <SessionTranscript
        sessionId={session.id}
        status={session.status}
        events={events}
      />

      <p className="mt-10 border-t pt-4 text-xs text-muted-foreground">
        Read-only view. Anyone with this link can read this transcript.
        <br />
        <span className="font-mono">{session.id}</span>
      </p>
    </main>
  );
}

/** As with the transcript's timestamps, the reader's locale, not the server's. */
function Started({ at }: { at: string }) {
  return (
    <time dateTime={at} suppressHydrationWarning>
      {new Date(at).toLocaleString()}
    </time>
  );
}

function duration(startedAt: string, endedAt: string) {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${Math.max(ms, 0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}
