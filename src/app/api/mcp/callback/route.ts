import type { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { connectAndListTools, finishAuthorization } from "@/lib/mcp/client";
import { getConnectionByState, syncTools } from "@/lib/mcp/connections";
import { suggestApproval } from "@/lib/mcp/tools";

/**
 * Where MCP authorization servers send people back to. Not behind the route
 * gate in src/proxy.ts (that only covers /app), so the session is checked
 * here — and matched against the agent the `state` belongs to, so a code
 * meant for one workspace can't be redeemed from another.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state");
  const code = params.get("code");

  const connection = state ? await getConnectionByState(state) : null;
  if (!connection) {
    return new Response("Unknown or expired authorization.", { status: 400 });
  }

  const back = `/app/${connection.agentId}`;

  const session = await auth();
  if (session?.slack?.teamId !== connection.workspaceId) {
    return new Response("This authorization belongs to another workspace.", { status: 403 });
  }

  if (params.get("error") || !code) {
    // Declined, or the server had a problem. Either way nothing was granted.
    return redirectTo(request, back, {
      error: params.get("error") === "access_denied" ? "mcp_denied" : "mcp_failed",
    });
  }

  try {
    await finishAuthorization(connection, code);
    const result = await connectAndListTools(connection);
    if (result.status !== "authorized") {
      throw new Error("The server asked for another authorization.");
    }
    await syncTools(connection.id, result.tools, suggestApproval);
  } catch (error) {
    console.error(`MCP authorization for ${connection.serverId} failed`, error);
    return redirectTo(request, back, { error: "mcp_failed" });
  }

  revalidatePath(back);
  return redirectTo(request, `${back}/access/${connection.serverId}`);
}

function redirectTo(request: NextRequest, path: string, query?: Record<string, string>) {
  const url = new URL(path, request.nextUrl.origin);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return Response.redirect(url, 303);
}
