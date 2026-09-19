"use server";

import { revalidatePath } from "next/cache";

import { requireAgent } from "@/app/app/require-agent";
import { DESCRIPTION_MAX, INSTRUCTIONS_MAX } from "@/lib/agent-limits";
import { updateAgentProfile } from "@/lib/agents";
import { isModelId } from "@/lib/models";
import { syncSlackManifest } from "@/lib/slack-access";

export type EditAgentState = {
  status: "idle" | "saved" | "error";
  message?: string;
  errors?: { description?: string; instructions?: string; model?: string };
};

/**
 * Saves new instructions, model and description. The description is also
 * the Slack app's, so the manifest follows — best effort: the agent is what the model
 * reads, and a description that is a step behind at Slack catches up with
 * the next manifest sync.
 */
export async function editAgentAction(
  _previous: EditAgentState,
  formData: FormData,
): Promise<EditAgentState> {
  const agent = await requireAgent(formData);
  if ("error" in agent) return { status: "error", message: agent.error };

  const description = str(formData.get("description"));
  const instructions = str(formData.get("instructions"));
  const model = str(formData.get("model"));

  const errors: EditAgentState["errors"] = {};
  if (!isModelId(model)) errors.model = "Pick a model from the list.";
  if (description.length > DESCRIPTION_MAX) {
    errors.description = `Keep it under ${DESCRIPTION_MAX} characters.`;
  }
  if (!instructions) errors.instructions = "Instructions can't be empty.";
  else if (instructions.length > INSTRUCTIONS_MAX) {
    errors.instructions = `Keep it under ${INSTRUCTIONS_MAX} characters.`;
  }
  if (errors.description || errors.instructions || errors.model) {
    return { status: "error", errors };
  }

  const updated = await updateAgentProfile(agent.id, {
    description: description || null,
    instructions,
    model,
  });
  if (!updated) return { status: "error", message: "This agent no longer exists." };

  if (updated.description !== agent.description) {
    await syncSlackManifest(updated).catch((error) =>
      console.error(`Could not update the Slack app description for agent ${agent.id}`, error),
    );
  }

  revalidatePath(`/app/${agent.id}`);
  return { status: "saved" };
}

function str(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}
