import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { db, ensureSchema } from "@/lib/db";
import {
  STRIPE_DEAUTHORIZED_EVENT,
  createConnectWebhookEndpoint,
  stripeEventsUrl,
  updateWebhookEndpointEvents,
  type StripeWebhookEndpoint,
} from "@/lib/stripe";
import { allStripeEventTypes } from "@/lib/triggers";

/**
 * The platform's one Connect webhook endpoint at Stripe (see src/lib/stripe.ts
 * for why there is one and not one per account). Created on demand and kept
 * subscribed to exactly the events some trigger wants, plus the
 * deauthorization notice.
 */
const ROW_ID = "default";

type EndpointRow = {
  endpoint_id: string;
  url: string;
  secret: string;
  enabled_events: string[];
  livemode: boolean;
};

export type StoredEndpoint = {
  endpointId: string;
  url: string;
  enabledEvents: string[];
  livemode: boolean;
};

export async function getStripeEndpoint(): Promise<StoredEndpoint | null> {
  const row = await readRow();
  return row
    ? {
        endpointId: row.endpoint_id,
        url: row.url,
        enabledEvents: row.enabled_events,
        livemode: row.livemode,
      }
    : null;
}

/** The signing secret, decrypted. For the events route only. */
export async function getStripeEndpointSecret(): Promise<string | null> {
  const row = await readRow();
  return row ? decryptSecret(row.secret) : null;
}

/**
 * Brings Stripe's endpoint in line with what triggers listen for. Called
 * after every change to a Stripe trigger's events. Creating happens once;
 * after that only `enabled_events` changes, and only when it has to.
 */
export async function syncStripeEndpoint() {
  const wanted = [...new Set([STRIPE_DEAUTHORIZED_EVENT, ...(await allStripeEventTypes())])].sort();
  const current = await readRow();

  if (!current) {
    const created = await createConnectWebhookEndpoint(wanted);
    await writeRow(created, created.secret);
    return;
  }

  const unchanged =
    current.url === stripeEventsUrl() &&
    current.enabled_events.length === wanted.length &&
    current.enabled_events.every((event, i) => event === wanted[i]);
  if (unchanged) return;

  const updated = await updateWebhookEndpointEvents(current.endpoint_id, wanted);
  await writeRow(updated, null);
}

async function readRow(): Promise<EndpointRow | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select endpoint_id, url, secret, enabled_events, livemode
    from stripe_webhook_endpoint
    where id = ${ROW_ID}
    limit 1
  `) as EndpointRow[];
  return rows[0] ?? null;
}

async function writeRow(endpoint: StripeWebhookEndpoint, secret: string | null) {
  const sql = db();
  const events = [...endpoint.enabled_events].sort();
  if (secret) {
    await sql`
      insert into stripe_webhook_endpoint (id, endpoint_id, url, secret, enabled_events, livemode)
      values (${ROW_ID}, ${endpoint.id}, ${endpoint.url}, ${encryptSecret(secret)}, ${events}, ${endpoint.livemode})
      on conflict (id) do update
        set endpoint_id    = excluded.endpoint_id,
            url            = excluded.url,
            secret         = excluded.secret,
            enabled_events = excluded.enabled_events,
            livemode       = excluded.livemode,
            updated_at     = now()
    `;
  } else {
    await sql`
      update stripe_webhook_endpoint
      set enabled_events = ${events}, url = ${endpoint.url}, updated_at = now()
      where id = ${ROW_ID}
    `;
  }
}
