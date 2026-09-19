import type { RunProgress } from "@/lib/agent/run";
import type { SlackBlock } from "@/lib/slack-events";

export type ProgressEntry = { label: string; status: "running" | "ok" | "error" };

/** The header shown above the list of tool calls. */
const PLAN_TITLE = "Working on the request";

/**
 * The live-progress message's text, in Slack's own mrkdwn — this never goes
 * through `toMrkdwn`, since it's written for Slack directly rather than being
 * the model's markdown. Doubles as the notification text for the `plan`
 * block below, and as the whole message if that block fails to render.
 */
export function renderProgress(entries: readonly ProgressEntry[]): string {
  if (entries.length === 0) return "_Working on it…_";
  return entries
    .map((entry) => {
      if (entry.status === "running") return `⏳ _${entry.label}…_`;
      if (entry.status === "error") return `⚠️ ${entry.label}`;
      return `✅ ${entry.label}`;
    })
    .join("\n");
}

/**
 * The same entries as Slack's own `plan`/`task` block kit, so the message
 * renders as a live checklist (Slack's agentic-app UI) rather than plain
 * text. One task per tool call — no nested sub-steps.
 *
 * `sessionUrl`, when given, is appended as a context line under the
 * checklist — Slack's small print, in `mrkdwn` since a context block's text
 * objects don't take anything else.
 */
export function buildProgressBlocks(
  entries: readonly ProgressEntry[],
  sessionUrl?: string,
): SlackBlock[] {
  return [
    {
      type: "plan",
      title: PLAN_TITLE,
      tasks: entries.map((entry, index) => ({
        task_id: `task-${index}`,
        title: entry.label,
        status: entry.status === "running" ? "in_progress" : entry.status === "error" ? "error" : "complete",
      })),
    },
    ...(sessionUrl
      ? [
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `<${sessionUrl}|Full session>` }],
          },
        ]
      : []),
  ];
}

/**
 * Turns a run's `onProgress` events into a message that stays up to date.
 *
 * `publish` is expected to swallow its own failures — a rate-limited or
 * otherwise dropped update should not stop the run, just leave the message a
 * step behind. Updates are serialised through `publish` in the order they
 * were handled, so a slow request can't land after a later one and show a
 * stale state.
 */
export function createProgressTracker(
  publish: (update: { text: string; blocks: SlackBlock[] }) => Promise<void>,
  options?: { sessionUrl?: string },
) {
  const entries: ProgressEntry[] = [];
  const indexByCallId = new Map<string, number>();
  let chain = Promise.resolve();

  function flush() {
    const text = renderProgress(entries);
    const blocks = buildProgressBlocks(entries, options?.sessionUrl);
    chain = chain.then(() => publish({ text, blocks }));
  }

  return {
    handle(event: RunProgress) {
      if (event.type === "tool-start") {
        indexByCallId.set(event.callId, entries.length);
        entries.push({ label: event.label, status: "running" });
      } else {
        const index = indexByCallId.get(event.callId);
        // Not found only if the run somehow ends a call it never started —
        // nothing to update in that case.
        if (index !== undefined) {
          entries[index] = { label: event.label, status: event.ok ? "ok" : "error" };
        }
      }
      flush();
    },
    /** Waits for every update handed to `publish` so far to have run. */
    settle: () => chain,
  };
}
