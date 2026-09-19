/**
 * What in a Gmail inbox an agent can be woken by. Client-safe: no I/O.
 *
 * Both come from the same mailbox watch; the label each one maps to is what
 * the watch is asked to report on, and what the notification handler looks
 * for in the history.
 */
export type GmailEventDefinition = {
  id: string;
  name: string;
  description: string;
  /** The Gmail label whose changes carry this event. */
  labelId: string;
  /** Always on: it's what the trigger is for. */
  required?: boolean;
};

export const GMAIL_EVENTS: readonly GmailEventDefinition[] = [
  {
    id: "message.received",
    name: "Email received",
    description: "A new message arrives in the inbox.",
    labelId: "INBOX",
    required: true,
  },
  {
    id: "message.starred",
    name: "Email starred",
    description: "Someone stars a message — a way to hand one to the agent by hand.",
    labelId: "STARRED",
  },
];

export const DEFAULT_GMAIL_EVENTS: readonly string[] = ["message.received"];

export function getGmailEvent(id: string) {
  return GMAIL_EVENTS.find((event) => event.id === id);
}

/** Drops unknown ids and keeps the required ones, in catalog order. */
export function normalizeGmailEvents(ids: Iterable<string>): string[] {
  const chosen = new Set(ids);
  return GMAIL_EVENTS.filter((event) => event.required || chosen.has(event.id)).map(
    (event) => event.id,
  );
}

/** The labels a watch has to cover for these events. */
export function gmailLabelIdsFor(eventIds: Iterable<string>): string[] {
  const labels = new Set<string>();
  for (const id of eventIds) {
    const label = getGmailEvent(id)?.labelId;
    if (label) labels.add(label);
  }
  return [...labels].sort();
}
