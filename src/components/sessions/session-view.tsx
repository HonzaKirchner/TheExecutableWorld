import { Zap } from "lucide-react";

import type { AgentSession, SessionEvent } from "@/lib/sessions";
import { SessionTranscript } from "@/components/sessions/session-transcript";
import { Badge } from "@/components/ui/badge";

/**
 * One run, as both the signed-in page and the public link show it: what
 * woke the agent, when, how long it took, what went wrong, and the
 * transcript — live while the run is on. The pages around it differ only in
 * their chrome.
 */
export function SessionView({
  session,
  events,
}: {
  session: AgentSession;
  events: SessionEvent[];
}) {
  return (
    <>
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

      <SessionTranscript sessionId={session.id} status={session.status} events={events} />
    </>
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
