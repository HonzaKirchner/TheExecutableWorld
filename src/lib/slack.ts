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
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
    this.method = method;
    this.code = code;
    this.details = details;
  }
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
    throw new SlackApiError(
      method,
      payload.error ?? "unknown_error",
      payload.errors,
    );
  }

  return payload;
}
