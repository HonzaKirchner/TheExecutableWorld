/**
 * Stripe events worth offering by name. Anything else Stripe emits can be
 * typed in — the full list runs to several hundred and changes with every API
 * release, so the catalog is a starting point rather than a boundary.
 *
 * The Stripe App holds read permissions across the board and the webhook
 * endpoint subscribes to everything, so any event type is fair game; what a
 * trigger picks is filtered on our side. Client-safe.
 */
export type StripeEventDefinition = {
  id: string;
  name: string;
  description: string;
};

export const STRIPE_EVENTS: readonly StripeEventDefinition[] = [
  {
    id: "refund.created",
    name: "Refund created",
    description: "A refund was requested on a charge.",
  },
  {
    id: "refund.updated",
    name: "Refund updated",
    description: "A refund changed status — succeeded, failed, cancelled.",
  },
  {
    id: "charge.refunded",
    name: "Charge refunded",
    description: "A charge was refunded, in full or in part.",
  },
  {
    id: "charge.failed",
    name: "Charge failed",
    description: "A charge attempt failed.",
  },
  {
    id: "charge.dispute.created",
    name: "Dispute opened",
    description: "A customer disputed a charge with their bank.",
  },
  {
    id: "payment_intent.succeeded",
    name: "Payment succeeded",
    description: "A payment went through.",
  },
  {
    id: "payment_intent.payment_failed",
    name: "Payment failed",
    description: "A payment could not be completed.",
  },
  {
    id: "checkout.session.completed",
    name: "Checkout completed",
    description: "A customer finished a Checkout session.",
  },
  {
    id: "customer.subscription.created",
    name: "Subscription started",
    description: "A customer signed up for a plan.",
  },
  {
    id: "customer.subscription.updated",
    name: "Subscription changed",
    description: "A subscription changed plan, quantity or status.",
  },
  {
    id: "customer.subscription.deleted",
    name: "Subscription ended",
    description: "A subscription was cancelled or ran out.",
  },
  {
    id: "customer.subscription.trial_will_end",
    name: "Trial ending soon",
    description: "Three days before a trial ends.",
  },
  {
    id: "invoice.paid",
    name: "Invoice paid",
    description: "An invoice was paid.",
  },
  {
    id: "invoice.payment_failed",
    name: "Invoice payment failed",
    description: "An invoice payment attempt failed.",
  },
  {
    id: "customer.created",
    name: "Customer created",
    description: "A new customer record was created.",
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
