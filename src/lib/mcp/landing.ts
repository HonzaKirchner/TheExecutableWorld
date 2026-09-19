import { DEFAULT_GMAIL_EVENTS } from "@/lib/gmail-events";
import { startGmailWatch } from "@/lib/gmail/watch";
import type { McpReturnTo } from "@/lib/mcp/return-to";

/** The trigger page the person came from, for a connection started there; otherwise nothing. */
export function triggerPageFor(agentId: string, serverId: string, returnTo: McpReturnTo) {
  return returnTo === "trigger" && serverId === "gmail"
    ? `/app/${agentId}/triggers/${serverId}`
    : undefined;
}

/**
 * The path to send the person to once the connection is authorized: the
 * server's tool page under Access, or — coming from the Gmail trigger's card
 * — the trigger's page. In that case the mailbox watch is started first, with
 * the default events, so the trigger exists by the time its page opens and
 * choosing events is the next thing to do. If Gmail refuses, the page says
 * so and offers to start it again.
 */
export async function landingAfterConnect(
  agentId: string,
  serverId: string,
  returnTo: McpReturnTo,
): Promise<string> {
  const triggerPage = triggerPageFor(agentId, serverId, returnTo);
  if (!triggerPage) return `/app/${agentId}/access/${serverId}`;

  try {
    await startGmailWatch(agentId, DEFAULT_GMAIL_EVENTS);
  } catch (error) {
    console.error(`Could not start the Gmail watch for agent ${agentId} after connecting`, error);
    return `${triggerPage}?error=gmail_watch_failed`;
  }
  return `${triggerPage}?started=1`;
}
