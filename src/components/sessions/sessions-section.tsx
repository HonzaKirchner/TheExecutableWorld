import Link from "next/link";
import { ChevronRight, History } from "lucide-react";

import { sessionPath, type SessionSummary } from "@/lib/sessions";
import { Badge } from "@/components/ui/badge";

/**
 * The agent's recent runs. Each row links to the transcript, which lives
 * outside the signed-in app and needs no account to read — that's what makes
 * it shareable with whoever asked what the agent did.
 */
export function SessionsSection({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold tracking-tight">Sessions</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every run, with a transcript you can share — the link needs no sign-in.
      </p>

      {sessions.length === 0 ? (
        <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center">
          <div className="flex size-10 items-center justify-center rounded-full border bg-card text-muted-foreground">
            <History className="size-4" />
          </div>
          <p className="mt-4 text-sm font-medium">No runs yet</p>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            The next time a trigger fires, the run will show up here.
          </p>
        </div>
      ) : (
        <ul className="mt-6 overflow-hidden rounded-xl border bg-card">
          {sessions.map((session, i) => (
            <li key={session.id} className={i > 0 ? "border-t" : ""}>
              <Link
                href={sessionPath(session.id)}
                className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-muted/40"
              >
                <Dot status={session.status} />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {session.title ?? "Run"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(session.startedAt).toLocaleString()} ·{" "}
                    {session.eventCount}{" "}
                    {session.eventCount === 1 ? "entry" : "entries"}
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
      )}
    </section>
  );
}

function Dot({ status }: { status: SessionSummary["status"] }) {
  const color =
    status === "running"
      ? "bg-emerald-600"
      : status === "failed"
        ? "bg-rose-600"
        : "bg-muted-foreground/40";
  return (
    <span className="relative flex size-2 shrink-0" title={status}>
      {status === "running" ? (
        <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${color}`} />
      ) : null}
      <span className={`relative inline-flex size-2 rounded-full ${color}`} />
    </span>
  );
}
