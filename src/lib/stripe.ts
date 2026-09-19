import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { baseUrl, publicBaseUrl } from "@/lib/base-url";

/**
 * Stripe, through a Stripe App that authenticates with OAuth
 * (https://docs.stripe.com/stripe-apps/api-authentication/oauth):
 *
 * - A person installs the app into their Stripe account from an install link
 *   on marketplace.stripe.com. Stripe hands back an authorization code; the
 *   exchange returns the account id (and tokens, which this app doesn't
 *   need: the developer account's key plus a `Stripe-Account` header act for
 *   an account that installed the app). So nothing per-account is kept but
 *   the id.
 * - Events from every account that installed the app arrive at ONE webhook
 *   endpoint on the developer account, created with `connect=true`. Each
 *   event names the account it came from, which is how it finds its trigger.
 *   The app creates this endpoint itself and keeps its `enabled_events` equal
 *   to the union of what triggers listen for. Stripe only delivers events
 *   the app's manifest holds permissions for (`event_read` plus one per
 *   object) — see src/lib/stripe-events.ts.
 *
 * Needs `STRIPE_SECRET_KEY` (the app developer account's key, or a managed
 * sandbox's) and `STRIPE_INSTALL_LINK`: an install link copied from the app's
 * External test tab (or, once published, its Settings tab). While an app is
 * in external testing its links carry a channel (`chnlink_…`) that a link
 * assembled from the `client_id` alone doesn't have, so the link is used as
 * given and only `redirect_uri` and `state` are set on it. There is one link
 * per mode; the key must be from the same mode.
 */
const MARKETPLACE = "https://marketplace.stripe.com";
const CONNECT = "https://connect.stripe.com";
const API = "https://api.stripe.com/v1";

export const STRIPE_CONNECT_CALLBACK_PATH = "/api/stripe/connect/callback";
export const STRIPE_EVENTS_PATH = "/api/stripe/events";

/** Sent to the platform when an account uninstalls the app; covered by `*`. */
export const STRIPE_DEAUTHORIZED_EVENT = "account.application.deauthorized";

export function isStripeConfigured() {
  return Boolean(secretKey() && (installLink() || clientId()));
}

export class StripeApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`Stripe ${code}: ${message}`);
    this.name = "StripeApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Where Stripe sends people back to. Must be one of the app manifest's
 * `allowed_redirect_uris`.
 */
export function stripeConnectRedirectUri() {
  return `${baseUrl()}${STRIPE_CONNECT_CALLBACK_PATH}`;
}

/** Where Stripe delivers events. Reachable from the internet, like Slack's. */
export function stripeEventsUrl() {
  return `${publicBaseUrl()}${STRIPE_EVENTS_PATH}`;
}

export function newStripeState() {
  return randomBytes(24).toString("base64url");
}

/**
 * The app's OAuth install link with this deployment's callback and a fresh
 * `state`. Built on `STRIPE_INSTALL_LINK` when set; otherwise assembled from
 * `STRIPE_CLIENT_ID` the way Stripe documents it, which works for published
 * apps.
 */
export function buildStripeConnectUrl(input: { state: string }) {
  const link = installLink();
  const url = link ? new URL(link) : new URL(`${MARKETPLACE}/oauth/v2/authorize`);
  if (!link) url.searchParams.set("client_id", requireClientId());
  url.searchParams.set("redirect_uri", stripeConnectRedirectUri());
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Turns the code from the callback into the installing account's id. The
 * key has to match the link's mode: live key for the live link, test key for
 * the test link, a managed sandbox's key for a sandbox link.
 */
export async function exchangeStripeCode(code: string) {
  const response = await stripeRequest<{
    stripe_user_id: string;
    livemode: boolean;
    scope: string;
  }>(`${API}/oauth/token`, {
    grant_type: "authorization_code",
    code,
  });
  return { accountId: response.stripe_user_id, livemode: response.livemode };
}

/**
 * Revokes the app's access to an account. Documented for Connect; for an
 * account that installed a Stripe App the reliable path is uninstalling from
 * their Dashboard, which sends `account.application.deauthorized`. Callers
 * treat a failure here as non-fatal.
 */
export async function deauthorizeStripeAccount(accountId: string) {
  await stripeRequest(`${CONNECT}/oauth/deauthorize`, {
    client_id: requireClientId(),
    stripe_user_id: accountId,
  });
}

export type StripeWebhookEndpoint = {
  id: string;
  url: string;
  enabled_events: string[];
  livemode: boolean;
  status: string;
  /** Only present in the response to `create`. */
  secret?: string;
};

export async function createConnectWebhookEndpoint(events: readonly string[]) {
  const endpoint = await stripeRequest<StripeWebhookEndpoint>(`${API}/webhook_endpoints`, {
    url: stripeEventsUrl(),
    connect: "true",
    description: "Coworkers — events for agents' Stripe triggers",
    "enabled_events[]": [...events],
  });
  if (!endpoint.secret) {
    throw new Error("Stripe created the webhook endpoint without returning its secret.");
  }
  return endpoint as StripeWebhookEndpoint & { secret: string };
}

export async function updateWebhookEndpointEvents(endpointId: string, events: readonly string[]) {
  return stripeRequest<StripeWebhookEndpoint>(`${API}/webhook_endpoints/${endpointId}`, {
    "enabled_events[]": [...events],
  });
}

export async function deleteWebhookEndpoint(endpointId: string) {
  await stripeRequest(`${API}/webhook_endpoints/${endpointId}`, undefined, "DELETE");
}

/** Requests older than this are replays, whatever their signature says. */
const MAX_AGE_SECONDS = 5 * 60;

/**
 * Checks `Stripe-Signature` (`t=<unix>,v1=<hex>[,v1=…]`): HMAC-SHA256 over
 * `${t}.${raw body}` with the endpoint secret, per
 * https://docs.stripe.com/webhooks#verify-manually. Any one `v1` matching is
 * enough — Stripe sends two while a secret is being rolled.
 */
export function verifyStripeSignature(input: {
  secret: string;
  header: string | null;
  body: string;
  now?: number;
}) {
  if (!input.header) return false;

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of input.header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t") timestamp = value;
    else if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const t = Number(timestamp);
  if (!Number.isFinite(t) || Math.abs(now - t) > MAX_AGE_SECONDS) return false;

  const expected = Buffer.from(
    createHmac("sha256", input.secret).update(`${timestamp}.${input.body}`).digest("hex"),
  );
  return signatures.some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/** The parts of an event this app looks at. */
export type StripeEvent = {
  id: string;
  type: string;
  /** The connected account the event came from; absent for the platform's own. */
  account?: string;
  livemode: boolean;
  created: number;
  /** The charge, subscription, invoice … the event is about. */
  data?: { object?: unknown };
};

/*
 * Stripe takes form-encoded bodies (arrays as repeated `key[]`) and answers
 * with JSON. Errors come back as non-2xx with `{ error: { code, message } }`
 * on the API and `{ error, error_description }` on the OAuth endpoints.
 */
type FormValue = string | string[];

async function stripeRequest<T = unknown>(
  url: string,
  form?: Record<string, FormValue>,
  method: "POST" | "DELETE" = "POST",
): Promise<T> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${requireSecretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form ? body.toString() : undefined,
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string | { code?: string; type?: string; message?: string };
    error_description?: string;
  };

  if (!response.ok) {
    const error = payload.error;
    if (typeof error === "string") {
      throw new StripeApiError(response.status, error, payload.error_description ?? error);
    }
    throw new StripeApiError(
      response.status,
      error?.code ?? error?.type ?? `http_${response.status}`,
      error?.message ?? "request failed",
    );
  }

  return payload as T;
}

function secretKey() {
  return clean(process.env.STRIPE_SECRET_KEY);
}

function installLink() {
  const value = clean(process.env.STRIPE_INSTALL_LINK);
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    throw new Error("STRIPE_INSTALL_LINK is not a valid URL.");
  }
}

/** Explicit `STRIPE_CLIENT_ID`, or the `client_id` inside the install link. */
function clientId() {
  const explicit = clean(process.env.STRIPE_CLIENT_ID);
  if (explicit) return explicit;
  const link = installLink();
  return link ? new URL(link).searchParams.get("client_id") ?? undefined : undefined;
}

function requireSecretKey() {
  const value = secretKey();
  if (!value) throw new Error("STRIPE_SECRET_KEY is not set.");
  return value;
}

function requireClientId() {
  const value = clientId();
  if (!value) throw new Error("Neither STRIPE_INSTALL_LINK nor STRIPE_CLIENT_ID is set.");
  return value;
}

/** `vercel env pull` writes "[sensitive]" for variables it may not read. */
function clean(value: string | undefined) {
  return value && value !== "[sensitive]" ? value : undefined;
}
