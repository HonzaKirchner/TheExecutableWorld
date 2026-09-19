"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAgent } from "@/app/app/require-agent";
import { getAgentSlackCredentials, setSlackInstallState, type Agent } from "@/lib/agents";
import { getMcpServer } from "@/lib/mcp/catalog";
import { connectAndListTools } from "@/lib/mcp/client";
import {
  deleteConnection,
  getConnection,
  listTools,
  saveToolAccess,
  syncTools,
  upsertConnection,
} from "@/lib/mcp/connections";
import { suggestApproval } from "@/lib/mcp/tools";
import { botScopesFor, DEFAULT_SLACK_EVENTS } from "@/lib/slack-events-catalog";
import { buildInstallUrl, newInstallState } from "@/lib/slack-install";
import { getTrigger } from "@/lib/triggers";

export type AccessActionState = { error?: string };

/**
 * Points the agent at an MCP server. Ends in one of two places: on the
 * server's authorization page if it wants the person to sign in, or on the
 * tool list if the stored tokens (or no auth at all) were enough.
 */
export async function connectMcpServerAction(
  _previous: AccessActionState,
  formData: FormData,
): Promise<AccessActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const server = getMcpServer(str(formData.get("serverId")));
  if (!server) return { error: "That server isn't supported." };

  const connection = await upsertConnection({
    agentId: agent.id,
    serverId: server.id,
    serverUrl: server.url,
  });

  let result;
  try {
    result = await connectAndListTools(connection);
  } catch (error) {
    return { error: connectionFailureMessage(server.name, error) };
  }

  if (result.status === "redirect") {
    redirect(result.url.toString());
  }

  await syncTools(connection.id, result.tools, suggestApproval);
  revalidatePath(`/app/${agent.id}`);
  redirect(`/app/${agent.id}/access/${server.id}`);
}

export async function disconnectMcpServerAction(
  _previous: AccessActionState,
  formData: FormData,
): Promise<AccessActionState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return agent;

  const serverId = str(formData.get("serverId"));
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
