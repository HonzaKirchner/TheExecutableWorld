"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { createAgent, deleteAgent, isHandleTaken } from "@/lib/agents";
import { isModelId } from "@/lib/models";
import { SlackApiError } from "@/lib/slack";
import { createSlackApp, deleteSlackApp } from "@/lib/slack-apps";
import { createTrigger, slackEventsUrl } from "@/lib/triggers";

export type CreateAgentField = "name" | "handle" | "model" | "persona";

export type CreateAgentState = {
  status: "idle" | "error";
  message?: string;
  errors?: Partial<Record<CreateAgentField, string>>;
  /**
   * Echoed back on failure. React resets a form once its action resolves, so
   * without this the fields would revert to empty and the person would have to
   * retype everything to fix one mistake.
   */
  values?: Record<CreateAgentField, string>;
};

/** Slack's display_information.name limit, which is the tighter of the two. */
const NAME_MAX = 35;
/** Slack's bot_user.display_name limit and character set. */
const HANDLE_MAX = 80;
const HANDLE_RE = /^[a-z0-9._-]+$/;
const PERSONA_MAX = 4000;

export async function createAgentAction(
  _previous: CreateAgentState,
  formData: FormData,
): Promise<CreateAgentState> {
  // The form only renders behind the route gate, but the action is a POST
  // endpoint of its own — so authorize here, not at render time.
  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  if (!workspaceId) {
    return {
      status: "error",
      message: "Your session has expired. Sign in again to create an agent.",
    };
  }

  const name = str(formData.get("name"));
  const handle = str(formData.get("handle")).replace(/^@/, "").toLowerCase();
  const model = str(formData.get("model"));
  const persona = str(formData.get("persona"));

  const values = { name, handle, model, persona };
  const errors: Partial<Record<CreateAgentField, string>> = {};

  if (!name) errors.name = "Give your coworker a name.";
  else if (name.length > NAME_MAX)
    errors.name = `Slack caps app names at ${NAME_MAX} characters.`;

  if (!handle) errors.handle = "Pick a Slack handle.";
  else if (handle.length > HANDLE_MAX)
    errors.handle = `Slack caps handles at ${HANDLE_MAX} characters.`;
  else if (!HANDLE_RE.test(handle))
    errors.handle = "Use lowercase letters, numbers, and . _ - only.";

  if (!isModelId(model)) errors.model = "Choose a model.";

  if (!persona) errors.persona = "Describe how this coworker should behave.";
  else if (persona.length > PERSONA_MAX)
    errors.persona = `Keep the persona under ${PERSONA_MAX} characters.`;

  if (Object.keys(errors).length > 0) {
    return { status: "error", errors, values };
  }

  if (await isHandleTaken(workspaceId, handle)) {
    return {
      status: "error",
      errors: { handle: `@${handle} is already taken in this workspace.` },
      values,
    };
  }

  // The Slack trigger's id is the path of the webhook, and the webhook goes
  // into the app's manifest — so the id has to exist before either row does.
  const triggerId = randomUUID();

  let slackApp;
  try {
    slackApp = await createSlackApp({
      name,
      handle,
      persona,
      eventsUrl: slackEventsUrl(triggerId),
    });
  } catch (error) {
    return { status: "error", message: slackAppFailureMessage(error), values };
  }

  let agent;
  try {
    agent = await createAgent({
      workspaceId,
      name,
      handle,
      description: persona,
      model,
      slackApp,
    });
    try {
      await createTrigger({ id: triggerId, agentId: agent.id, kind: "slack" });
    } catch (error) {
      await deleteAgent(agent.id).catch(() => {});
      throw error;
    }
  } catch (error) {
    // The Slack app exists but nothing points at it any more. Clean it up so
    // the handle stays free and the workspace doesn't collect orphans.
    await deleteSlackApp(slackApp.appId).catch(() => {});
    throw error;
  }

  revalidatePath("/app");
  // Straight to the new agent: giving it access and installing it happen
  // there. (redirect throws, so it stays outside the try above.)
  redirect(`/app/${agent.id}`);
}

function str(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function slackAppFailureMessage(error: unknown) {
  if (!(error instanceof SlackApiError)) {
    return error instanceof Error
      ? error.message
      : "Could not create the Slack app.";
  }

  switch (error.code) {
    case "ratelimited":
      return "Slack is rate limiting app creation. Wait a minute and try again.";
    case "invalid_manifest":
      // One reason Slack gives is that the events URL failed its challenge —
      // which is what happens when the endpoint isn't deployed yet.
      return `Slack rejected the app manifest: ${describe(error.details)}`;
    case "invalid_auth":
    case "not_authed":
    case "token_expired":
      return "The Slack app configuration token was rejected. Generate a new one at https://api.slack.com/apps.";
    default:
      return `Slack could not create the app (${error.code}).`;
  }
}

function describe(details: unknown) {
  if (!Array.isArray(details)) return "no details given.";
  const messages = details
    .map((detail) =>
      detail && typeof detail === "object" && "message" in detail
        ? String((detail as { message: unknown }).message)
        : null,
    )
    .filter(Boolean);
  return messages.length > 0 ? messages.join("; ") : "no details given.";
}
