import { timingSafeEqual } from "node:crypto";

import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import { baseUrl, publicBaseUrl } from "@/lib/base-url";
import { GMAIL_MCP_PATH } from "@/lib/mcp/catalog";
import { loadCredentials, updateCredentials } from "@/lib/mcp/connections";

/**
 * Google, for Gmail — both halves of it:
 *
 * - The Gmail MCP server this app hosts (src/lib/gmail/mcp-server.ts) is an
 *   OAuth resource server whose authorization server is Google itself. An
 *   agent "connects to Gmail" the way it connects to any catalog server; the
 *   tokens that come back are Google tokens, stored on the connection like
 *   everyone else's.
 * - The Gmail trigger (src/lib/gmail/watch.ts) borrows those same tokens to
 *   watch the mailbox, so a Google account is granted once per agent.
 *
 * Google doesn't register OAuth clients dynamically, so the deployment brings
 * its own: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from a Cloud project
 * with the Gmail API enabled and `<base URL>/api/mcp/callback` among the
 * client's redirect URIs.
 *
 * The endpoints can be pointed elsewhere for tests against a stand-in.
 */
export const GOOGLE_ISSUER = process.env.GOOGLE_ISSUER_URL ?? "https://accounts.google.com";
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
export const GOOGLE_TOKENINFO_URL =
  process.env.GOOGLE_TOKENINFO_URL ?? "https://oauth2.googleapis.com/tokeninfo";
export const GMAIL_API_URL = process.env.GMAIL_API_URL ?? "https://gmail.googleapis.com/gmail/v1";

/** Everything the tools and the watch need, short of permanent deletion. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export const GMAIL_PUBSUB_PATH = "/api/gmail/events";

export const GOOGLE_CLIENT_ENV = { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" } as const;

/** Where the app's own Gmail MCP server lives; what the agent connects to. */
export function gmailMcpUrl() {
  return `${baseUrl()}${GMAIL_MCP_PATH}`;
}

/** Where Pub/Sub pushes Gmail notifications. Internet-reachable, like Slack's. */
export function gmailPushUrl() {
  return `${publicBaseUrl()}${GMAIL_PUBSUB_PATH}`;
}

export function googleClient() {
  const clientId = clean(process.env[GOOGLE_CLIENT_ENV.id]);
  const clientSecret = clean(process.env[GOOGLE_CLIENT_ENV.secret]);
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** The Pub/Sub topic Gmail publishes to: `projects/<project>/topics/<topic>`. */
export function gmailPubSubTopic() {
  return clean(process.env.GMAIL_PUBSUB_TOPIC);
}

/**
 * Whether the trigger can be offered: a Google client for the tokens and a
 * topic for the notifications. The MCP server alone needs only the client.
 */
export function isGmailTriggerConfigured() {
  return Boolean(googleClient() && gmailPubSubTopic() && clean(process.env.GMAIL_PUBSUB_TOKEN));
}

/**
 * The push subscription carries this token in its URL; it's the only proof a
 * request came from our subscription and not from anyone who found the path.
 */
export function verifyPubSubToken(candidate: string | null) {
  const expected = clean(process.env.GMAIL_PUBSUB_TOKEN);
  if (!expected || !candidate) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What Google says about an access token. */
export type TokenInfo = {
  aud: string;
  scope: string;
  /** Seconds since the epoch. */
  exp: number;
  email?: string;
};

/**
 * Asks Google whether a token is good and whom it was issued to. The MCP
 * server accepts only tokens minted for this deployment's client that carry
 * the Gmail scope — a token some other app obtained is no good here.
 */
export async function introspectToken(token: string): Promise<TokenInfo | null> {
  const client = googleClient();
  if (!client) return null;

  const url = new URL(GOOGLE_TOKENINFO_URL);
  url.searchParams.set("access_token", token);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return null;

  const info = (await response.json()) as Partial<TokenInfo> & { expires_in?: string | number };
  if (info.aud !== client.clientId || typeof info.scope !== "string") return null;
  if (!info.scope.split(" ").includes(GMAIL_SCOPE)) return null;

  const exp = Number(info.exp ?? Math.floor(Date.now() / 1000) + Number(info.expires_in ?? 0));
  return { aud: info.aud, scope: info.scope, exp, email: info.email };
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/**
 * Something that can call the Gmail API as one account. The MCP server gets
 * one from the bearer token on the request; the trigger from the stored
 * connection, which is also able to refresh.
 */
export type Bearer = {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
};

export function bearerFromToken(token: string): Bearer {
  return {
    fetch: (input, init) => fetch(input, withToken(init, token)),
  };
}

/**
 * The connection's stored tokens, refreshed when Google says they've run out.
 * Google's refresh tokens don't rotate, so this and the SDK's own refresh
 * (which happens while listing tools) can't invalidate each other.
 */
export function bearerFromConnection(connectionId: string): Bearer {
  let access: Promise<string> | undefined;
  const current = () => (access ??= currentAccessToken(connectionId));

  return {
    async fetch(input, init) {
      const first = await fetch(input, withToken(init, await current()));
      if (first.status !== 401) return first;
      access = refreshAccessToken(connectionId);
      return fetch(input, withToken(init, await access));
    },
  };
}

async function currentAccessToken(connectionId: string) {
  const { tokens } = await loadCredentials(connectionId);
  if (!tokens?.access_token) {
    throw new GoogleAuthError("This Gmail connection has no tokens. Connect it again.");
  }
  return tokens.access_token;
}

async function refreshAccessToken(connectionId: string) {
  const client = googleClient();
  if (!client) throw new GoogleAuthError("Google client credentials are not configured.");

  const credentials = await loadCredentials(connectionId);
  const refreshToken = credentials.tokens?.refresh_token;
  if (!refreshToken) {
    throw new GoogleAuthError("Google issued no refresh token for this connection. Connect it again.");
  }

  // The SDK saved Google's metadata during authorization; trust it over the
  // default, which is what a test stand-in would differ in.
  const tokenUrl = credentials.discovery?.authorizationServerMetadata?.token_endpoint ?? GOOGLE_TOKEN_URL;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<OAuthTokens> & {
    error?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new GoogleAuthError(
      `Google refused to refresh the Gmail tokens (${payload.error ?? response.status}). Connect Gmail again.`,
    );
  }

  const tokens: OAuthTokens = {
    access_token: payload.access_token,
    token_type: payload.token_type ?? "Bearer",
    expires_in: payload.expires_in,
    scope: payload.scope,
    refresh_token: payload.refresh_token ?? refreshToken,
  };
  await updateCredentials(connectionId, { tokens });
  return tokens.access_token;
}

function withToken(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers, cache: "no-store" };
}

/** `vercel env pull` writes "[sensitive]" for variables it may not read. */
function clean(value: string | undefined) {
  return value && value !== "[sensitive]" ? value : undefined;
}
