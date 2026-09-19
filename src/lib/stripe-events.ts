/**
 * Stripe events worth offering by name. Anything else Stripe emits can be
 * typed in — the full list runs to several hundred and changes with every API
 * release, so the catalog is a starting point rather than a boundary.
 *
 * Each entry names the Stripe App permission that lets the app receive it
 * (https://docs.stripe.com/stripe-apps/reference/permissions). Stripe only
 * delivers events for objects the installed app may read, so the manifest has
 * to grant these — the UI shows what a choice needs.
 *
 * Client-safe.
 */
export type StripeEventDefinition = {
  id: string;
  name: string;
  description: string;
  permission: string;
};

/** Needed by any app that receives events at all. */
export const STRIPE_BASE_PERMISSIONS: readonly string[] = ["event_read"];

export const STRIPE_EVENTS: readonly StripeEventDefinition[] = [
  {
    id: "refund.created",
    name: "Refund created",
    description: "A refund was requested on a charge.",
    permission: "charge_read",
  },
  {
    id: "refund.updated",
    name: "Refund updated",
    description: "A refund changed status — succeeded, failed, cancelled.",
    permission: "charge_read",
  },
  {
    id: "charge.refunded",
    name: "Charge refunded",
    description: "A charge was refunded, in full or in part.",
    permission: "charge_read",
  },
  {
    id: "charge.failed",
    name: "Charge failed",
    description: "A charge attempt failed.",
    permission: "charge_read",
  },
  {
    id: "charge.dispute.created",
    name: "Dispute opened",
    description: "A customer disputed a charge with their bank.",
    permission: "dispute_read",
  },
  {
    id: "payment_intent.succeeded",
    name: "Payment succeeded",
    description: "A payment went through.",
    permission: "payment_intent_read",
  },
  {
    id: "payment_intent.payment_failed",
    name: "Payment failed",
    description: "A payment could not be completed.",
    permission: "payment_intent_read",
  },
  {
    id: "checkout.session.completed",
    name: "Checkout completed",
    description: "A customer finished a Checkout session.",
    permission: "checkout_session_read",
  },
  {
    id: "customer.subscription.created",
    name: "Subscription started",
    description: "A customer signed up for a plan.",
    permission: "subscription_read",
  },
  {
    id: "customer.subscription.updated",
    name: "Subscription changed",
    description: "A subscription changed plan, quantity or status.",
    permission: "subscription_read",
  },
  {
    id: "customer.subscription.deleted",
    name: "Subscription ended",
    description: "A subscription was cancelled or ran out.",
    permission: "subscription_read",
  },
  {
    id: "customer.subscription.trial_will_end",
    name: "Trial ending soon",
    description: "Three days before a trial ends.",
    permission: "subscription_read",
  },
  {
    id: "invoice.paid",
    name: "Invoice paid",
    description: "An invoice was paid.",
    permission: "invoice_read",
  },
  {
    id: "invoice.payment_failed",
    name: "Invoice payment failed",
    description: "An invoice payment attempt failed.",
    permission: "invoice_read",
  },
  {
    id: "customer.created",
    name: "Customer created",
    description: "A new customer record was created.",
    permission: "customer_read",
  },
];

/** `object.verb`, possibly nested — `charge.dispute.created`. */
const EVENT_TYPE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const EVENT_TYPE_MAX = 100;

export function isStripeEventType(value: string) {
  return value.length <= EVENT_TYPE_MAX && EVENT_TYPE_RE.test(value);
}

export function getStripeEvent(id: string) {
  return STRIPE_EVENTS.find((event) => event.id === id);
}

/** Dedupes, drops anything that isn't shaped like an event type, sorts. */
export function normalizeStripeEvents(ids: Iterable<string>): string[] {
  const clean = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (isStripeEventType(id)) clean.add(id);
  }
  return [...clean].sort();
}

/**
 * The app permissions a set of events needs, as far as the catalog knows.
 * Event types outside the catalog are returned separately: their permission
 * has to be looked up by hand.
 */
export function permissionsFor(eventIds: Iterable<string>) {
  const permissions = new Set(STRIPE_BASE_PERMISSIONS);
  const unknown: string[] = [];
  for (const id of eventIds) {
    const event = getStripeEvent(id);
    if (event) permissions.add(event.permission);
    else unknown.push(id);
  }
  return { permissions: [...permissions].sort(), unknown };
}
