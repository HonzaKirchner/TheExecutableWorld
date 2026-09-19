import { GMAIL_API_URL, type Bearer } from "@/lib/gmail/google";

/**
 * The slice of the Gmail REST API this app uses, on behalf of whoever the
 * `Bearer` speaks for. Shapes follow
 * https://developers.google.com/workspace/gmail/api/reference/rest.
 */

export class GmailApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`Gmail ${status}: ${message}`);
    this.name = "GmailApiError";
    this.status = status;
  }
}

type Header = { name: string; value: string };

type MessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: MessagePart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: MessagePart;
};

export type GmailThread = {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
};

export type GmailLabel = {
  id: string;
  name: string;
  type?: "system" | "user";
  messagesUnread?: number;
};

export type GmailProfile = {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
};

export type WatchResponse = {
  historyId: string;
  /** Milliseconds since the epoch, as a string. */
  expiration: string;
};

export type HistoryRecord = {
  id: string;
  messagesAdded?: { message: Pick<GmailMessage, "id" | "threadId" | "labelIds"> }[];
  labelsAdded?: {
    message: Pick<GmailMessage, "id" | "threadId" | "labelIds">;
    labelIds: string[];
  }[];
};

export type HistoryPage = {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId: string;
};

export async function getProfile(bearer: Bearer) {
  return request<GmailProfile>(bearer, "/users/me/profile");
}

export async function searchThreads(bearer: Bearer, query: string, maxResults: number) {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (query) params.set("q", query);
  const page = await request<{ threads?: { id: string; snippet?: string }[] }>(
    bearer,
    `/users/me/threads?${params}`,
  );
  return page.threads ?? [];
}

export async function getThread(bearer: Bearer, threadId: string, format: "full" | "metadata" = "full") {
  const params = new URLSearchParams({ format });
  if (format === "metadata") for (const h of SUMMARY_HEADERS) params.append("metadataHeaders", h);
  return request<GmailThread>(bearer, `/users/me/threads/${encodeURIComponent(threadId)}?${params}`);
}

export async function getMessage(
  bearer: Bearer,
  messageId: string,
  format: "full" | "metadata" = "full",
) {
  const params = new URLSearchParams({ format });
  if (format === "metadata") for (const h of SUMMARY_HEADERS) params.append("metadataHeaders", h);
  return request<GmailMessage>(
    bearer,
    `/users/me/messages/${encodeURIComponent(messageId)}?${params}`,
  );
}

export async function sendMessage(bearer: Bearer, raw: string, threadId?: string) {
  return request<Pick<GmailMessage, "id" | "threadId" | "labelIds">>(
    bearer,
    "/users/me/messages/send",
    { method: "POST", body: JSON.stringify({ raw, threadId }) },
  );
}

export async function createDraft(bearer: Bearer, raw: string, threadId?: string) {
  return request<{ id: string; message: Pick<GmailMessage, "id" | "threadId"> }>(
    bearer,
    "/users/me/drafts",
    { method: "POST", body: JSON.stringify({ message: { raw, threadId } }) },
  );
}

export async function listLabels(bearer: Bearer) {
  const page = await request<{ labels?: GmailLabel[] }>(bearer, "/users/me/labels");
  return page.labels ?? [];
}

export async function modifyMessageLabels(
  bearer: Bearer,
  messageId: string,
  add: string[],
  remove: string[],
) {
  return request<Pick<GmailMessage, "id" | "threadId" | "labelIds">>(
    bearer,
    `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
    { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) },
  );
}

export async function modifyThreadLabels(
  bearer: Bearer,
  threadId: string,
  add: string[],
  remove: string[],
) {
  return request<Pick<GmailThread, "id">>(
    bearer,
    `/users/me/threads/${encodeURIComponent(threadId)}/modify`,
    { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) },
  );
}

/**
 * Asks Gmail to publish a note to the topic whenever a message with one of
 * the labels changes. Has to be repeated within seven days or it lapses.
 */
export async function watch(bearer: Bearer, topicName: string, labelIds: string[]) {
  return request<WatchResponse>(bearer, "/users/me/watch", {
    method: "POST",
    body: JSON.stringify({ topicName, labelIds, labelFilterBehavior: "INCLUDE" }),
  });
}

export async function stopWatch(bearer: Bearer) {
  await request<void>(bearer, "/users/me/stop", { method: "POST" });
}

/**
 * What changed since `startHistoryId`. A 404 means the id is older than
 * Gmail keeps history for; the caller starts over from the present.
 */
export async function listHistory(
  bearer: Bearer,
  startHistoryId: string,
  historyTypes: ("messageAdded" | "labelAdded")[],
): Promise<HistoryRecord[]> {
  const records: HistoryRecord[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ startHistoryId, maxResults: "100" });
    for (const type of historyTypes) params.append("historyTypes", type);
    if (pageToken) params.set("pageToken", pageToken);
    const page = await request<HistoryPage>(bearer, `/users/me/history?${params}`);
    records.push(...(page.history ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && records.length < 1000);
  return records;
}

async function request<T>(bearer: Bearer, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await bearer.fetch(`${GMAIL_API_URL}${path}`, { ...init, headers });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { message?: string } | string;
    };
    const message =
      typeof payload.error === "string"
        ? payload.error
        : payload.error?.message ?? response.statusText;
    throw new GmailApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/*
 * Reading messages: the pieces worth handing to a model, decoded.
 */

const SUMMARY_HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References", "Reply-To"];

export type MessageSummary = {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  labels: string[];
  snippet: string | null;
  /** The text of the message, when a full message was fetched. */
  body?: string;
  attachments?: string[];
};

/** How much of a body a tool result carries; the rest is noted, not sent. */
const BODY_MAX = 20_000;

export function summarizeMessage(message: GmailMessage, includeBody: boolean): MessageSummary {
  const header = (name: string) => findHeader(message.payload?.headers, name);
  const summary: MessageSummary = {
    id: message.id,
    threadId: message.threadId,
    from: header("From"),
    to: header("To"),
    cc: header("Cc"),
    subject: header("Subject"),
    date: header("Date"),
    labels: message.labelIds ?? [],
    snippet: message.snippet ?? null,
  };
  if (includeBody && message.payload) {
    const body = extractBody(message.payload);
    summary.body =
      body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}\n\n[…${body.length - BODY_MAX} more characters]` : body;
    const attachments = attachmentNames(message.payload);
    if (attachments.length > 0) summary.attachments = attachments;
  }
  return summary;
}

export function findHeader(headers: Header[] | undefined, name: string) {
  const lower = name.toLowerCase();
  return headers?.find((header) => header.name.toLowerCase() === lower)?.value ?? null;
}

/** Plain text if the message has it; otherwise the HTML with its tags removed. */
function extractBody(payload: MessagePart) {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data).trim();
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));
  return "";
}

function findPart(part: MessagePart, mimeType: string): MessagePart | undefined {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function attachmentNames(part: MessagePart): string[] {
  const names = part.filename && part.body?.attachmentId ? [part.filename] : [];
  for (const child of part.parts ?? []) names.push(...attachmentNames(child));
  return names;
}

function stripHtml(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeBase64Url(data: string) {
  return Buffer.from(data, "base64url").toString("utf8");
}

/*
 * Writing messages: Gmail takes a whole RFC 5322 message, base64url-encoded.
 */

export type OutgoingMessage = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
};

export function buildRawMessage(message: OutgoingMessage) {
  const lines = [
    `To: ${message.to.join(", ")}`,
    message.cc?.length ? `Cc: ${message.cc.join(", ")}` : null,
    message.bcc?.length ? `Bcc: ${message.bcc.join(", ")}` : null,
    `Subject: ${encodeHeader(message.subject)}`,
    message.inReplyTo ? `In-Reply-To: ${message.inReplyTo}` : null,
    message.references ? `References: ${message.references}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(message.text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ].filter((line): line is string => line !== null);
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** RFC 2047 for anything outside ASCII; plain otherwise. */
function encodeHeader(value: string) {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** `Re: ` once, whatever the casing of one already there. */
export function replySubject(subject: string | null) {
  const base = subject ?? "";
  return /^\s*re:/i.test(base) ? base : `Re: ${base}`;
}
