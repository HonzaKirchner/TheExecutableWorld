"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CornerDownRight,
  Info,
  MessageSquare,
  Sparkles,
  Wrench,
  Zap,
} from "lucide-react";

import type { SessionEvent, SessionEventType, SessionStatus } from "@/lib/sessions";

/**
 * The transcript, and the polling that keeps it live.
 *
 * Polling rather than a stream: this runs on serverless functions against a
 * database over HTTP, where a held-open SSE connection costs a function
 * invocation for the whole run. A cursor poll is one small query, and the
 * page still works with JavaScript off — the server rendered the transcript
 * as it stood.
 */

/** How long to keep asking a quiet session before assuming its run died. */
const IDLE_POLLS_BEFORE_GIVING_UP = 60;

export function SessionTranscript({
  sessionId,
  status: initialStatus,
  events: initialEvents,
}: {
  sessionId: string;
  status: SessionStatus;
  events: SessionEvent[];
}) {
  const [events, setEvents] = useState(initialEvents);
  const [status, setStatus] = useState(initialStatus);
  const [stalled, setStalled] = useState(false);

  // The cursor lives in a ref so that arriving events don't restart the loop.
  const cursor = useRef(initialEvents.at(-1)?.seq ?? 0);

  useEffect(() => {
    // A paused run is still going, just waiting on a person — the view keeps
    // polling so an approval elsewhere shows up here without a reload.
    if (status !== "running" && status !== "paused") return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let idle = 0;

    const poll = async () => {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/events?after=${cursor.current}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as {
          status: SessionStatus;
          events: SessionEvent[];
        };
        if (cancelled) return;

        if (data.events.length > 0) {
          idle = 0;
          cursor.current = data.events[data.events.length - 1].seq;
          setEvents((previous) => [...previous, ...data.events]);
        } else {
          idle += 1;
        }

        setStatus(data.status);
        if (data.status !== "running" && data.status !== "paused") return;
      } catch {
        // A failed poll is usually a lost network, not a finished session.
        // Count it as quiet and try again a little later.
        idle += 1;
      }

      if (cancelled) return;
      if (idle > IDLE_POLLS_BEFORE_GIVING_UP) {
        setStalled(true);
        return;
      }
      // Fast while something is happening, slower once it clearly isn't.
      timer = setTimeout(poll, idle < 10 ? 1000 : 3000);
    };

    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, status]);

  return (
    <>
      <div className="mt-6 flex items-center justify-between gap-3 border-b pb-3">
        <StatusPill status={status} stalled={stalled} />
        <span className="text-xs text-muted-foreground">
          {events.length} {events.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      <ol className="mt-1">
        {events.map((event) => (
          <EventRow key={event.seq} event={event} />
        ))}
      </ol>

      {events.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          Nothing recorded yet.
        </p>
      ) : null}

      {stalled ? (
        <p className="mt-4 rounded-lg border border-dashed px-3.5 py-2.5 text-sm text-muted-foreground">
          No updates for a while — the run may have stopped without finishing.
          Reload to check again.
        </p>
      ) : null}
    </>
  );
}

function StatusPill({
  status,
  stalled,
}: {
  status: SessionStatus;
  stalled: boolean;
}) {
  if (status === "running") {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <span className="relative flex size-2">
          {stalled ? null : (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
          )}
          <span className="relative inline-flex size-2 rounded-full bg-current" />
        </span>
        {stalled ? "No longer updating" : "Live"}
      </span>
    );
  }

  if (status === "paused") {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        <span className="size-2 rounded-full bg-current" />
        Waiting for approval
      </span>
    );
  }

  const failed = status === "failed";
  return (
    <span
      className={`flex items-center gap-2 text-xs font-medium ${
        failed ? "text-rose-700 dark:text-rose-400" : "text-muted-foreground"
      }`}
    >
      <span className="size-2 rounded-full bg-current" />
      {failed ? "Failed" : status === "stopped" ? "Stopped" : "Finished"}
    </span>
  );
}

const ICONS: Record<SessionEventType, typeof Zap> = {
  trigger: Zap,
  message: MessageSquare,
  thought: Sparkles,
  tool_call: Wrench,
  tool_result: CornerDownRight,
  reply: MessageSquare,
  error: AlertTriangle,
  note: Info,
};

function EventRow({ event }: { event: SessionEvent }) {
  const Icon = ICONS[event.type] ?? Info;
  const emphasis = event.type === "message" || event.type === "reply";
  const failed = event.type === "error";

  return (
    <li className="animate-in fade-in slide-in-from-bottom-1 flex gap-3 py-3.5 duration-300">
      <span
        className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border ${
          failed
            ? "border-destructive/30 bg-destructive/5 text-destructive"
            : event.type === "reply"
              ? "border-emerald-700/20 bg-emerald-600 text-white"
              : "bg-muted text-muted-foreground"
        }`}
      >
        <Icon className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium">{label(event)}</span>
          <Timestamp value={event.createdAt} />
        </div>

        {event.body ? (
          <p
            className={`mt-1 break-words whitespace-pre-wrap ${
              emphasis ? "text-[15px] leading-6" : "text-sm text-muted-foreground"
            } ${failed ? "text-destructive" : ""}`}
          >
            {event.body}
          </p>
        ) : null}

        {isThreadContext(event.data) ? (
          <details className="group mt-2">
            <summary className="w-fit cursor-pointer list-none text-xs text-muted-foreground transition-colors hover:text-foreground">
              <span className="group-open:hidden">Show full context</span>
              <span className="hidden group-open:inline">Hide full context</span>
            </summary>
            <ol className="mt-2 space-y-2 rounded-lg border bg-muted/40 p-3">
              {event.data.thread.map((turn, index) => (
                <li key={index} className="text-[13px] leading-5">
                  <span className="font-medium text-muted-foreground">
                    {turn.role === "assistant" ? "Agent" : "Message"}:{" "}
                  </span>
                  <span className="break-words whitespace-pre-wrap">
                    {typeof turn.content === "string"
                      ? turn.content
                      : JSON.stringify(turn.content)}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        ) : event.data && Object.keys(event.data).length > 0 ? (
          <details className="group mt-2">
            <summary className="w-fit cursor-pointer list-none text-xs text-muted-foreground transition-colors hover:text-foreground">
              <span className="group-open:hidden">Show details</span>
              <span className="hidden group-open:inline">Hide details</span>
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-5">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

type ThreadTurn = { role: string; content: unknown };

/**
 * The one shape of `data` that gets its own rendering: the full thread a
 * message event's reply was built from, attached by `buildMessages` in
 * `src/lib/agent/slack.ts` so a reply that clearly used earlier context
 * doesn't look like it came out of nowhere.
 */
function isThreadContext(
  data: SessionEvent["data"],
): data is { thread: ThreadTurn[] } {
  return (
    data != null &&
    Array.isArray((data as { thread?: unknown }).thread) &&
    (data as { thread: unknown[] }).thread.every(
      (turn) => typeof turn === "object" && turn != null && "role" in turn,
    )
  );
}

function label(event: SessionEvent) {
  switch (event.type) {
    case "trigger":
      return "Triggered";
    case "message":
      return event.role === "agent" ? "Agent" : "Message";
    case "thought":
      return "Thinking";
    case "tool_call":
      return "Tool call";
    case "tool_result":
      return "Tool result";
    case "reply":
      return "Reply";
    case "error":
      return "Error";
    default:
      return "Note";
  }
}

/**
 * Formatted in the reader's own locale and time zone, which the server can't
 * know — so the first paint differs from the server's and React is told to
 * expect that rather than warn about it.
 */
function Timestamp({ value }: { value: string }) {
  return (
    <time
      dateTime={value}
      suppressHydrationWarning
      className="font-mono text-[11px] text-muted-foreground"
      title={new Date(value).toISOString()}
    >
      {new Date(value).toLocaleTimeString()}
    </time>
  );
}
