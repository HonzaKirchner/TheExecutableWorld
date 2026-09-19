import { auth } from "@/auth";
import { getAgent, type Agent } from "@/lib/agents";

/**
 * For Server Actions: every one of them is a POST endpoint reachable without
 * the page, so each re-derives the agent from the session rather than
 * trusting the form. Returns an error message instead of throwing so the
 * action can hand it to the form.
 */
export async function requireAgent(formData: FormData): Promise<Agent | { error: string }> {
  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  if (!workspaceId) {
    return { error: "Your session has expired. Sign in again." };
  }

  const agentId = formData.get("agentId");
  const agent = typeof agentId === "string" ? await getAgent(workspaceId, agentId.trim()) : null;
  return agent ?? { error: "This agent no longer exists." };
}
