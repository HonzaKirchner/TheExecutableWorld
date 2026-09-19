"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAgent } from "@/app/app/require-agent";
import { setAuditSettings, type Agent } from "@/lib/agents";
import {
  connectionBlocker,
  CUSTOM_SERVER_NAME_MAX,
  describeCatalogServer,
  describeConnection,
  getMcpServer,
  isCustomServerId,
  newCustomServerId,
  type McpServerInfo,
} from "@/lib/mcp/catalog";
import { connectAndListTools } from "@/lib/mcp/client";
import { landingAfterConnect } from "@/lib/mcp/landing";
import { parseMcpReturnTo, type McpReturnTo } from "@/lib/mcp/return-to";
import {
  deleteConnection,
  getConnection,
  listTools,
  saveToolAccess,
  syncTools,
  upsertConnection,
  type ClassifierSettings,
  type McpConnection,
} from "@/lib/mcp/connections";
import { suggestApproval } from "@/lib/mcp/tools";
import { ensureGmailConnection } from "@/lib/gmail/connection";
import { stopGmailWatch } from "@/lib/gmail/watch";
import { SlackApiError } from "@/lib/slack";
import { ensureSlackConnection, syncSlackManifest } from "@/lib/slack-access";
import { SlackConfigTokenError } from "@/lib/slack-config-token";
import { parseInstallReturnTo, startSlackInstall } from "@/lib/slack-install";
import { getTrigger } from "@/lib/triggers";

export type AccessActionState = { error?: string };

export type CustomServerState = {
  error?: string;
  errors?: { name?: string; url?: string };
  values?: { name: string; url: string };
};

/**
 * Points the agent at an MCP server — a catalog entry, or a custom one that
 * was added before and is being connected again. Ends in one of two places:
 * on the server's authorization page if it wants the person to sign in, or
 * on the tool list if the stored tokens (or no auth at all) were enough.
 * `returnTo` says where the person lands once authorized: the tool list by
 * default, or the trigger's page when the connection was started from its
 * card (see `landingAfterConnect`).
 *
 * Slack is the one server with nothing to authorize and nothing to ask: its
 * tool list is a catalog in this codebase and its token is the agent's own
 * bot token, so the connection is made on the spot — installed or not — and
 * the person lands on the tool list. Gmail skips the consent screen too
 * whenever another agent of the workspace already holds a Google grant: the
 * new agent takes that grant over (src/lib/gmail/connection.ts), and only a
 * workspace with none is sent to Google.
 */
export async function connectMcpServerAction(
  _previous: AccessActionState,
  formData: FormData,
): Promise<AccessActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const serverId = str(formData.get("serverId"));
  const catalog = getMcpServer(serverId);
  let server: McpServerInfo | undefined;
  if (catalog) {
    const blocker = connectionBlocker(catalog);
    if (blocker) return { error: blocker };
    server = describeCatalogServer(catalog);
  } else if (isCustomServerId(serverId)) {
    const existing = await getConnection(agent.id, serverId);
    server = existing ? describeConnection(existing) : undefined;
  }
  if (!server) return { error: "That server isn't supported." };

  const returnTo = parseMcpReturnTo(formData.get("returnTo"));
  if (server.id === "slack") {
    await ensureSlackConnection(agent);
    revalidatePath(`/app/${agent.id}`);
    redirect(await landingAfterConnect(agent.id, server.id, returnTo));
  }
  if (server.id === "gmail" && (await ensureGmailConnection(agent.id))) {
    revalidatePath(`/app/${agent.id}`);
    redirect(await landingAfterConnect(agent.id, server.id, returnTo));
  }

  const connection = await upsertConnection({
    agentId: agent.id,
    serverId: server.id,
    serverUrl: server.url,
  });

  const failure = await establish(agent, connection, server, returnTo);
  return failure ? { error: failure } : {};
}

/**
 * Adds a server that isn't in the catalog, by URL, and connects to it. A
 * server that can't be reached at all is dropped again rather than left as a
 * pending card — the URL was most likely mistyped. One that sends the person
 * off to authorize stays, so the callback has something to come back to.
 */
export async function connectCustomMcpServerAction(
  _previous: CustomServerState,
  formData: FormData,
): Promise<CustomServerState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const values = { name: str(formData.get("name")), url: str(formData.get("url")) };
  const errors: CustomServerState["errors"] = {};
  if (!values.name) errors.name = "Give the server a name.";
  else if (values.name.length > CUSTOM_SERVER_NAME_MAX) {
    errors.name = `Keep it under ${CUSTOM_SERVER_NAME_MAX} characters.`;
  }
  const url = parseServerUrl(values.url);
  if (!url) errors.url = "Enter the server's full https:// URL.";
  if (!url || errors.name) return { errors, values };

  const server: McpServerInfo = {
    id: newCustomServerId(),
    name: values.name,
    description: url,
    url,
    custom: true,
  };
  const connection = await upsertConnection({
    agentId: agent.id,
    serverId: server.id,
    serverUrl: server.url,
    name: server.name,
  });

  const failure = await establish(agent, connection, server);
  if (failure) {
    await deleteConnection(agent.id, server.id);
    return { error: failure, values };
  }
  return {};
}

/**
 * The part both connect actions share. Returns a message when the server
 * couldn't be reached; otherwise it doesn't return at all, because both
 * outcomes end in a redirect.
 */
async function establish(
  agent: Agent,
  connection: McpConnection,
  server: McpServerInfo,
  returnTo: McpReturnTo = "access",
) {
  let result;
  try {
    result = await connectAndListTools(connection, { returnTo });
  } catch (error) {
    return connectionFailureMessage(server.name, error);
  }

  if (result.status === "redirect") {
    redirect(result.url.toString());
  }

  await syncTools(connection.id, result.tools, suggestApproval);
  revalidatePath(`/app/${agent.id}`);
  redirect(await landingAfterConnect(agent.id, server.id, returnTo));
}

/**
 * Only http(s) URLs, and plain http only for a server on this machine: the
 * connection carries OAuth tokens, and anything else would send them in the
 * clear. Returns the normalised URL, or nothing if it doesn't qualify.
 */
function parseServerUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return undefined;
  return url.toString();
}

export async function disconnectMcpServerAction(
  _previous: AccessActionState,
  formData: FormData,
): Promise<AccessActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const serverId = str(formData.get("serverId"));

  // The Gmail trigger listens with this connection's tokens; without them it
  // can neither hear nor stop, so it goes first, while the tokens still work.
  if (serverId === "gmail") {
    const trigger = await getTrigger(agent.id, "gmail");
    if (trigger) {
      await stopGmailWatch(agent.id, trigger).catch((error) =>
        console.error(`Could not stop the Gmail trigger for agent ${agent.id}`, error),
      );
    }
  }

  await deleteConnection(agent.id, serverId);

  // The Slack tools' scopes leave the manifest with them. Best effort: the
  // connection is gone either way, and a wider manifest does no harm until
  // the next install.
  if (serverId === "slack") {
    await syncSlackManifest(agent, { tools: [] }).catch((error) =>
      console.error(`Could not update the Slack manifest for agent ${agent.id}`, error),
    );
  }

  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/**
 * Records which tools the agent may call and which of those need a human's
 * approval. Installing to Slack is a separate step on the agent's page.
 *
 * For the Slack server the allowed tools also decide the app's bot scopes,
 * so the manifest at Slack is updated first — as for events — and the
 * choice stored only once that has gone through. Scopes the current install
 * lacks show up on the agent's page as a reinstall.
 */
export async function saveToolAccessAction(
  _previous: AccessActionState,
  formData: FormData,
): Promise<AccessActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const serverId = str(formData.get("serverId"));
  const connection = await getConnection(agent.id, serverId);
  if (!connection || connection.status !== "authorized") {
    return { error: "Connect the server before choosing its tools." };
  }

  // Only names the server actually reported count; anything else in the form
  // body is ignored rather than stored.
  const known = new Set((await listTools(connection.id)).map((tool) => tool.name));
  const allowed = strings(formData.getAll("allowed")).filter((name) => known.has(name));
  const approval = strings(formData.getAll("approval")).filter((name) => known.has(name));

  // A classifier only makes sense for a tool that's gated, so the form only
  // sends these for names in `approval` — read for exactly those.
  const classifierOn = new Set(
    strings(formData.getAll("classifierEnabled")).filter((name) => known.has(name)),
  );
  const classifiers = new Map<string, ClassifierSettings>(
    approval.map((name) => [
      name,
      {
        enabled: classifierOn.has(name),
        systemPrompt: strOrNull(formData.get(`classifierPrompt:${name}`)),
        context: strOrNull(formData.get(`classifierContext:${name}`)),
        autoApproveWhen: strOrNull(formData.get(`classifierAutoApprove:${name}`)),
        escalateWhen: strOrNull(formData.get(`classifierEscalate:${name}`)),
      },
    ]),
  );

  if (serverId === "slack") {
    try {
      await syncSlackManifest(agent, { tools: allowed });
    } catch (error) {
      return { error: slackManifestFailure(error) };
    }
  }

  await saveToolAccess(connection.id, allowed, approval, classifiers);
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/**
 * Where the agent's tool-approval requests go, and who may decide them. A
 * blank whitelist means anyone in the channel can — the channel membership is
 * the access control until someone asks for narrower.
 */
export async function saveAuditSettingsAction(
  _previous: AccessActionState,
  formData: FormData,
): Promise<AccessActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const channelId = str(formData.get("auditChannelId")) || null;
  const whitelist = str(formData.get("approvalWhitelist"))
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);

  await setAuditSettings(agent.id, { channelId, whitelist });

  // Turns Slack interactivity on for the app the first time a channel is set
  // — without this, the buttons on an approval message would have nowhere
  // to be delivered to until something else happened to sync the manifest.
  if (channelId) {
    try {
      await syncSlackManifest(agent);
    } catch (error) {
      return { error: slackManifestFailure(error) };
    }
  }

  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/**
 * Sends the person to Slack to install the agent's app into their workspace.
 * `returnTo` says where the callback should land them: the agent's page by
 * default, or the Slack trigger's page when the install was started from its
 * card, so that choosing events is the very next thing they see.
 */
export async function installSlackAppAction(
  _previous: AccessActionState,
  formData: FormData,
): Promise<AccessActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  let url;
  try {
    url = await startSlackInstall(agent, parseInstallReturnTo(formData.get("returnTo")));
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not start the install." };
  }
  redirect(url);
}

function slackManifestFailure(error: unknown) {
  if (error instanceof SlackConfigTokenError) return error.message;
  if (error instanceof SlackApiError) {
    return `Slack rejected the app's new permissions (${error.code}). Nothing was saved.`;
  }
  return error instanceof Error ? error.message : "Slack could not be updated.";
}

function connectionFailureMessage(serverName: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not reach ${serverName}: ${detail}`;
}

function str(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function strOrNull(value: FormDataEntryValue | null) {
  const trimmed = str(value);
  return trimmed || null;
}

function strings(values: FormDataEntryValue[]) {
  return values.filter((value): value is string => typeof value === "string");
}
