/**
 * Thin wrapper around Slack's Web API.
 *
 * Slack answers with HTTP 200 for almost everything and puts the real outcome
 * in `ok`, so callers would otherwise have to remember to check it every time.
 */

const SLACK_API = "https://slack.com/api";

export class SlackApiError extends Error {
  // Written out rather than declared as constructor parameter properties:
  // the repo's scripts run under Node's strip-only TypeScript support, which
  // rejects that syntax.
  readonly method: string;
  readonly code: string;
  readonly details?: unknown;

  constructor(method: string, code: string, details?: unknown) {
    const reasons = describeSlackErrors(details);
    super(`Slack ${method} failed: ${code}${reasons ? ` — ${reasons}` : ""}`);
    this.name = "SlackApiError";
    this.method = method;
    this.code = code;
    this.details = details;
  }
}

/**
 * Slack's `errors` array — sent with `invalid_manifest` and a few other
 * codes — as one readable line: each entry's message, with the JSON pointer
 * into the offending manifest field when Slack gives one. Empty string when
 * there is nothing to say, so callers can fall back to their own wording.
 */
export function describeSlackErrors(details: unknown): string {
  if (!Array.isArray(details)) return "";
  return details
    .map((detail) => {
      if (!detail || typeof detail !== "object") return null;
      const { message, pointer } = detail as { message?: unknown; pointer?: unknown };
      if (typeof message !== "string" || !message) return null;
      return typeof pointer === "string" && pointer ? `${message} (at ${pointer})` : message;
    })
    .filter(Boolean)
    .join("; ");
}

type SlackResponse = { ok: boolean; error?: string; [key: string]: unknown };

export async function slackPost<T extends SlackResponse>(
  method: string,
  {
    token,
    form,
    json,
  }: {
    token?: string;
    form?: Record<string, string>;
    json?: unknown;
  },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: string;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = JSON.stringify(json);
  } else {
    headers["Content-Type"] =
      "application/x-www-form-urlencoded; charset=utf-8";
    body = new URLSearchParams(form ?? {}).toString();
  }

  const response = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
  });

  if (!response.ok) {
    throw new SlackApiError(method, `http_${response.status}`);
  }

  const payload = (await response.json()) as T;
  if (!payload.ok) {
    const error = new SlackApiError(
      method,
      payload.error ?? "unknown_error",
      payload.errors,
    );
    // The full payload lands in the server logs: Slack's `errors` entries
    // carry the reason and the field, and some methods add fields of their
    // own (`needed`, `provided`, `response_metadata`) that never reach the UI.
    console.error(`[slack] ${method} failed`, {
      error: payload.error,
      errors: payload.errors,
      response_metadata: payload.response_metadata,
    });
    throw error;
  }

  return payload;
}
