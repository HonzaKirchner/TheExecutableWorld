import type { RunProgress } from "@/lib/agent/run";

export type ProgressEntry = { label: string; status: "running" | "ok" | "error" };

/**
 * The live-progress message's text, in Slack's own mrkdwn — this never goes
 * through `toMrkdwn`, since it's written for Slack directly rather than being
 * the model's markdown.
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
 * Turns a run's `onProgress` events into a message that stays up to date.
 *
 * `publish` is expected to swallow its own failures — a rate-limited or
 * otherwise dropped update should not stop the run, just leave the message a
 * step behind. Updates are serialised through `publish` in the order they
 * were handled, so a slow request can't land after a later one and show a
 * stale state.
 */
export function createProgressTracker(publish: (text: string) => Promise<void>) {
  const entries: ProgressEntry[] = [];
  const indexByCallId = new Map<string, number>();
  let chain = Promise.resolve();

  function flush() {
    const text = renderProgress(entries);
    chain = chain.then(() => publish(text));
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
