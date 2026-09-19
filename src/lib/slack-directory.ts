import { getAgentBotToken, type Agent } from "@/lib/agents";
import { slackPost } from "@/lib/slack";

/**
 * The channels the agent's bot is in and the people of its workspace, as
 * the Approvals form offers them in a dropdown. Read with the bot token, so
 * only after the app is installed and only as far as the install's scopes
 * reach: people need `users:read`, which every install has; channels need
 * `channels:read` (public) and `groups:read` (private), which an install
 * only grants once a tool or event that needs them has been chosen. What
 * the scopes don't cover comes back empty and the form falls back to typing
 * the id.
 */

export type SlackChannelOption = { id: string; name: string; private: boolean };
export type SlackUserOption = { id: string; name: string; handle: string };

export type SlackDirectory = {
  /** Null when the install can't list channels at all. */
  channels: SlackChannelOption[] | null;
  /** Null when people couldn't be listed. */
  users: SlackUserOption[] | null;
};

const EMPTY: SlackDirectory = { channels: null, users: null };

export async function loadSlackDirectory(agent: Agent): Promise<SlackDirectory> {
  if (!agent.slackInstalledAt) return EMPTY;
  const token = await getAgentBotToken(agent.id);
  if (!token) return EMPTY;

  const granted = new Set(agent.slackBotScopes ?? []);
  const types = [
    granted.has("channels:read") ? "public_channel" : null,
    granted.has("groups:read") ? "private_channel" : null,
  ].filter((type): type is string => Boolean(type));

  const [channels, users] = await Promise.all([
    types.length > 0 ? listBotChannels(token, types).catch(swallow("channels")) : null,
    granted.has("users:read") ? listPeople(token).catch(swallow("users")) : null,
  ]);
  return { channels, users };
}

type RawChannel = { id: string; name?: string; is_private?: boolean; is_archived?: boolean };
type RawMember = {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: { display_name?: string; real_name?: string };
};

/** Only conversations the bot is a member of: approvals can't be posted anywhere else. */
async function listBotChannels(token: string, types: string[]): Promise<SlackChannelOption[]> {
  const raw = await paginate<RawChannel>(token, "users.conversations", "channels", {
    types: types.join(","),
    exclude_archived: "true",
  });
  return raw
    .filter((channel) => channel.name && !channel.is_archived)
    .map((channel) => ({ id: channel.id, name: channel.name!, private: Boolean(channel.is_private) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listPeople(token: string): Promise<SlackUserOption[]> {
  const raw = await paginate<RawMember>(token, "users.list", "members", {});
  return raw
    .filter((member) => !member.deleted && !member.is_bot && !member.is_app_user && member.id !== "USLACKBOT")
    .map((member) => ({
      id: member.id,
      name: member.profile?.display_name || member.real_name || member.profile?.real_name || member.name || member.id,
      handle: member.name ?? member.id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Slack pages at most this far through a list. Bigger workspaces get the first pages. */
const MAX_PAGES = 5;

async function paginate<T>(
  token: string,
  method: string,
  key: string,
  form: Record<string, string>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await slackPost<{
      ok: true;
      response_metadata?: { next_cursor?: string };
      [key: string]: unknown;
    }>(method, { token, form: { ...form, limit: "200", ...(cursor ? { cursor } : {}) } });
    const batch = response[key];
    if (Array.isArray(batch)) items.push(...(batch as T[]));
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return items;
}

function swallow(what: string) {
  return (error: unknown) => {
    console.error(`Could not list Slack ${what} for the Approvals form`, error);
    return null;
  };
}
