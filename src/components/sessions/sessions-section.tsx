import Link from "next/link";
import { ChevronRight, History } from "lucide-react";

import { agentSessionPath, agentSessionsPath, type SessionSummary } from "@/lib/sessions";
import { Badge } from "@/components/ui/badge";

/**
 * The agent's most recent runs, on its page, with the way to the full list.
 * Each row opens the run inside the app; the shareable link is on that page.
 */
export function SessionsSection({
  agentId,
  sessions,
  limit,
}: {
  agentId: string;
  sessions: SessionSummary[];
  /** How many the page asked for: when that many came back, there may be more. */
  limit: number;
}) {
  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Sessions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The latest runs. Each one has a transcript you can share.
          </p>
        </div>
        {sessions.length > 0 ? (
          <Link
            href={agentSessionsPath(agentId)}
            className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            All sessions
            <ChevronRight className="size-4" />
          </Link>
        ) : null}
      </div>

      <SessionList agentId={agentId} sessions={sessions} className="mt-6" />

      {sessions.length >= limit ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the latest {limit}.{" "}
          <Link
            href={agentSessionsPath(agentId)}
            className="underline underline-offset-4 hover:text-foreground"
          >
            See every run
          </Link>
          .
        </p>
      ) : null}
    </section>
  );
}

/** The rows themselves, shared by the agent's page and the sessions page. */
export function SessionList({
  agentId,
  sessions,
  className = "",
}: {
  agentId: string;
  sessions: SessionSummary[];
  className?: string;
}) {
  if (sessions.length === 0) {
    return (
      <div
        className={`flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center ${className}`}
      >
        <div className="flex size-10 items-center justify-center rounded-full border bg-card text-muted-foreground">
          <History className="size-4" />
        </div>
        <p className="mt-4 text-sm font-medium">No runs yet</p>
        <p className="mt-1 max-w-xs text-sm text-muted-foreground">
          The next time a trigger fires, the run will show up here.
        </p>
      </div>
    );
  }

  return (
    <ul className={`overflow-hidden rounded-xl border bg-card ${className}`}>
      {sessions.map((session, i) => (
        <li key={session.id} className={i > 0 ? "border-t" : ""}>
          <Link
            href={agentSessionPath(agentId, session.id)}
            className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-muted/40"
          >
            <Dot status={session.status} />

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{session.title ?? "Run"}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <time dateTime={session.startedAt} suppressHydrationWarning>
                  {new Date(session.startedAt).toLocaleString()}
                </time>{" "}
                · {session.eventCount} {session.eventCount === 1 ? "entry" : "entries"}
              </p>
            </div>

            <Badge variant="outline" className="shrink-0 text-[10px]">
              {session.triggerKind}
            </Badge>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Dot({ status }: { status: SessionSummary["status"] }) {
  const color =
    status === "running"
      ? "bg-emerald-600"
      : status === "paused"
        ? "bg-amber-500"
        : status === "failed"
          ? "bg-rose-600"
          : "bg-muted-foreground/40";
  return (
    <span className="relative flex size-2 shrink-0" title={status}>
      {status === "running" ? (
        <span
          className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${color}`}
        />
      ) : null}
      <span className={`relative inline-flex size-2 rounded-full ${color}`} />
    </span>
  );
}
