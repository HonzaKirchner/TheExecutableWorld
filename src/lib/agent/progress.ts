import type { RunProgress } from "@/lib/agent/run";
import type { SlackBlock } from "@/lib/slack-events";

export type ProgressEntry = { label: string; status: "running" | "ok" | "error" };

/** The header shown on the collapsible summary once the run is done. */
const PLAN_TITLE = "Working on the request";

/** One entry, in Slack's own mrkdwn — shared by the text fallback and the live list. */
function lineFor(entry: ProgressEntry): string {
  if (entry.status === "running") return `⏳ _${entry.label}…_`;
  if (entry.status === "error") return `⚠️ ${entry.label}`;
  return `✅ ${entry.label}`;
}

/**
 * The live-progress message's text, in Slack's own mrkdwn — this never goes
 * through `toMrkdwn`, since it's written for Slack directly rather than being
 * the model's markdown. Doubles as the notification text for the blocks
 * below, and as the whole message if those fail to render.
 */
export function renderProgress(entries: readonly ProgressEntry[]): string {
  if (entries.length === 0) return "_Working on it…_";
  return entries.map(lineFor).join("\n");
}

/** The small-print transcript link, shared by both block layouts below. */
function contextBlock(sessionUrl: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: `<${sessionUrl}|Full session>` }] };
}

/**
 * Each tool call as its own top-level block — nothing nested under a
 * collapsible header — so a run in progress reads as a plain, growing list
 * rather than something tucked away behind a disclosure a person has to open.
 * Used for every update while the run is still going.
 */
export function buildListBlocks(entries: readonly ProgressEntry[], sessionUrl?: string): SlackBlock[] {
  const rows: SlackBlock[] =
    entries.length === 0
      ? [{ type: "section", text: { type: "mrkdwn", text: "_Working on it…_" } }]
      : entries.map((entry) => ({ type: "section", text: { type: "mrkdwn", text: lineFor(entry) } }));
  return sessionUrl ? [...rows, contextBlock(sessionUrl)] : rows;
}

/**
 * The same entries collapsed into Slack's own `plan`/`task` block kit, so the
 * finished run reads as one tidy, collapsible checklist instead of a list of
 * bullets left sitting in the thread. Used once, when the run has nothing
 * left to report.
 */
export function buildPlanBlocks(entries: readonly ProgressEntry[], sessionUrl?: string): SlackBlock[] {
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
    ...(sessionUrl ? [contextBlock(sessionUrl)] : []),
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

  function flush(blocks: SlackBlock[]) {
    const text = renderProgress(entries);
    chain = chain.then(() => publish({ text, blocks }));
  }

  return {
    handle(event: RunProgress) {
      if (event.type === "tool-start") {
        const existing = indexByCallId.get(event.callId);
        if (existing !== undefined) {
          // The same call id starting again — an internal retry the run
          // callbacks don't otherwise surface. Reused in place, or the first
          // attempt's entry would be orphaned "running" forever once the
          // retry's own id took over the slot.
          entries[existing] = { label: event.label, status: "running" };
        } else {
          indexByCallId.set(event.callId, entries.length);
          entries.push({ label: event.label, status: "running" });
        }
      } else {
        const index = indexByCallId.get(event.callId);
        // Not found only if the run somehow ends a call it never started —
        // nothing to update in that case.
        if (index !== undefined) {
          entries[index] = { label: event.label, status: event.ok ? "ok" : "error" };
        }
      }
      flush(buildListBlocks(entries, options?.sessionUrl));
    },
    /**
     * Called once, when there is nothing left to report — the run finished,
     * failed, paused for approval, or decided to stay silent. Any entry still
     * "running" at that point (a call whose end was never reported) is
     * settled as done rather than left spinning forever, since nothing
     * updates this message again after this. Collapses the flat list into
     * Slack's own checklist summary and waits for every update queued so far,
     * this one included, to have gone out.
     */
    finish() {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].status === "running") entries[i] = { ...entries[i], status: "ok" };
      }
      flush(buildPlanBlocks(entries, options?.sessionUrl));
      return chain;
    },
  };
}
