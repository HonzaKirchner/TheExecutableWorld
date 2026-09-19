"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAgent } from "@/app/app/require-agent";
import { getAgentSlackCredentials, setSlackInstallState, type Agent } from "@/lib/agents";
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
import {
  deleteConnection,
  getConnection,
  listTools,
  saveToolAccess,
  syncTools,
  upsertConnection,
  type McpConnection,
} from "@/lib/mcp/connections";
import { suggestApproval } from "@/lib/mcp/tools";
import { stopGmailWatch } from "@/lib/gmail/watch";
import { botScopesFor, DEFAULT_SLACK_EVENTS } from "@/lib/slack-events-catalog";
import { buildInstallUrl, newInstallState } from "@/lib/slack-install";
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

  const connection = await upsertConnection({
    agentId: agent.id,
    serverId: server.id,
    serverUrl: server.url,
  });

  const failure = await establish(agent, connection, server);
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
async function establish(agent: Agent, connection: McpConnection, server: McpServerInfo) {
  let result;
  try {
    result = await connectAndListTools(connection);
  } catch (error) {
    return connectionFailureMessage(server.name, error);
  }

  if (result.status === "redirect") {
    redirect(result.url.toString());
  }

  await syncTools(connection.id, result.tools, suggestApproval);
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}/access/${server.id}`);
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
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/**
 * Records which tools the agent may call and which of those need a human's
 * approval. Installing to Slack is a separate step on the agent's page.
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

  await saveToolAccess(connection.id, allowed, approval);
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}`);
}

/** Sends the person to Slack to install the agent's app into their workspace. */
export async function installSlackAppAction(
  _previous: AccessActionState,
  formData: FormData,
): Promise<AccessActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  let url;
  try {
    url = await beginSlackInstall(agent);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not start the install." };
  }
  redirect(url);
}

async function beginSlackInstall(agent: Agent) {
  const credentials = await getAgentSlackCredentials(agent.id);
  if (!credentials) {
    throw new Error("This agent has no Slack app to install.");
  }

  // The scopes asked for have to match the manifest's, which follow from the
  // events the agent's Slack trigger listens for.
  const trigger = await getTrigger(agent.id, "slack");
  const scopes = botScopesFor(trigger?.events ?? DEFAULT_SLACK_EVENTS);

  const state = newInstallState();
  await setSlackInstallState(agent.id, state);
  return buildInstallUrl({
    clientId: credentials.clientId,
    workspaceId: agent.workspaceId,
    state,
    scopes,
  });
}

function connectionFailureMessage(serverName: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not reach ${serverName}: ${detail}`;
}

function str(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function strings(values: FormDataEntryValue[]) {
  return values.filter((value): value is string => typeof value === "string");
}
