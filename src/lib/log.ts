/**
 * Debug logging for the trigger → run → reply path.
 *
 * A message that gets no answer can die in a dozen places, and almost all of
 * them are silent by design: Slack's webhook answers 200 to everything it
 * doesn't act on, an unverified signature is indistinguishable from a request
 * that never arrived, and a run that fails only shows up in the thread. These
 * lines name the place it stopped.
 *
 * On outside production; set `DEBUG_AGENT=1` to turn it on in a deployment,
 * or `DEBUG_AGENT=0` to silence it locally.
 */
const enabled = process.env.DEBUG_AGENT
  ? process.env.DEBUG_AGENT !== "0"
  : process.env.NODE_ENV !== "production";

/** A scope groups the lines of one subsystem: `slack.webhook`, `agent.run`, … */
export function debug(scope: string, message: string, fields?: Record<string, unknown>) {
  if (!enabled) return;
  const rendered = fields ? ` ${format(fields)}` : "";
  console.log(`[${scope}] ${message}${rendered}`);
}

/** Pre-binds a scope, for a module that logs more than once. */
export function debugScope(scope: string) {
  return (message: string, fields?: Record<string, unknown>) => debug(scope, message, fields);
}

/** `key=value` pairs — greppable, and short enough to stay on one line. */
function format(fields: Record<string, unknown>) {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${render(value)}`)
    .join(" ");
}

function render(value: unknown): string {
  if (value === undefined) return "-";
  if (value === null) return "null";
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "string") return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Enough of a body to tell what the model or a tool said without pasting a
 * page of it into the log.
 */
export function preview(text: string | undefined, limit = 120) {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}
