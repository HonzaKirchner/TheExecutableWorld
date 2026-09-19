/**
 * The Slack events an agent can subscribe to, and the bot scopes each one
 * needs. Client-safe: no I/O, imported by the trigger page's form as well as
 * by the manifest builder.
 *
 * Scope names follow https://api.slack.com/events/<event>.
 */
export type SlackEventDefinition = {
  id: string;
  name: string;
  description: string;
  scopes: readonly string[];
  /** Always on: the agent can't do its job without it, so it isn't a choice. */
  required?: boolean;
};

export const SLACK_EVENTS: readonly SlackEventDefinition[] = [
  {
    id: "app_mention",
    name: "Mentioned",
    description: "Someone @mentions the agent in a channel it's in.",
    scopes: ["app_mentions:read"],
    required: true,
  },
  {
    id: "message.im",
    name: "Direct message",
    description: "Someone sends the agent a DM.",
    scopes: ["im:history"],
    required: true,
  },
  {
    id: "message.channels",
    name: "Public channel message",
    description:
      "Every message in a public channel the agent is in. Needed to follow a thread someone started by calling on the agent; which of these it acts on is decided in code, not by subscribing to fewer of them.",
    scopes: ["channels:history"],
    required: true,
  },
  {
    id: "message.groups",
    name: "Private channel message",
    description: "Every message in a private channel the agent is in, for the same reason.",
    scopes: ["groups:history"],
    required: true,
  },
  {
    id: "message.mpim",
    name: "Group DM message",
    description: "Every message in a group DM the agent is part of, for the same reason.",
    scopes: ["mpim:history"],
    required: true,
  },
  {
    id: "reaction_added",
    name: "Reaction added",
    description: "Someone reacts to a message in a channel the agent is in.",
    scopes: ["reactions:read"],
  },
  {
    id: "member_joined_channel",
    name: "Someone joins a channel",
    description: "A person joins a channel the agent is in.",
    scopes: ["channels:read", "groups:read"],
  },
  {
    id: "app_home_opened",
    name: "App Home opened",
    description: "Someone opens the agent's Home or Messages tab in Slack.",
    scopes: [],
  },
];

/** What every agent listens for until someone changes it. */
export const DEFAULT_SLACK_EVENTS: readonly string[] = ["app_mention", "message.im"];

/**
 * Needed regardless of events: posting replies, opening DMs, looking up who is
 * talking, and reading the thread the agent was spoken to in.
 *
 * The four history scopes are the last of those. `conversations.replies` wants
 * the one matching the conversation's type, and an agent can be @mentioned in
 * any of them — so answering in context needs all four, whatever the agent
 * subscribes to. They used to arrive only with the matching `message.*` event,
 * which meant an agent that just listened for mentions could never read the
 * thread it was mentioned in. Slack has no narrower scope for "this one
 * thread": reading a thread means being allowed to read the conversation.
 */
export const BASE_BOT_SCOPES: readonly string[] = [
  "chat:write",
  "im:write",
  "im:read",
  "users:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
];

export function getSlackEvent(id: string) {
  return SLACK_EVENTS.find((event) => event.id === id);
}

/**
 * Drops unknown ids and makes sure the required ones are present, in catalog
 * order — so two agents with the same choices produce the same manifest.
 */
export function normalizeSlackEvents(ids: Iterable<string>): string[] {
  const chosen = new Set(ids);
  return SLACK_EVENTS.filter((event) => event.required || chosen.has(event.id)).map(
    (event) => event.id,
  );
}

/**
 * The bot scopes a manifest (and an install) needs for these events.
 *
 * Normalised first, so a trigger whose stored events predate an event becoming
 * required still accounts for it — the manifest subscribes to the required
 * ones either way, and asking for fewer scopes than that would break them.
 */
export function botScopesFor(eventIds: Iterable<string>): string[] {
  const scopes = new Set(BASE_BOT_SCOPES);
  for (const id of normalizeSlackEvents(eventIds)) {
    for (const scope of getSlackEvent(id)?.scopes ?? []) scopes.add(scope);
  }
  return [...scopes].sort();
}

/** Scopes the events need that the last install did not grant. */
export function missingScopes(eventIds: Iterable<string>, granted: readonly string[] | null) {
  if (!granted) return [];
  const have = new Set(granted);
  return botScopesFor(eventIds).filter((scope) => !have.has(scope));
}
