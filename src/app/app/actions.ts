"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import {
  DESCRIPTION_MAX,
  HANDLE_MAX,
  INSTRUCTIONS_MAX,
} from "@/lib/agent-limits";
import { createAgent, isHandleTaken } from "@/lib/agents";
import { isModelId } from "@/lib/models";
import { describeSlackErrors, SlackApiError } from "@/lib/slack";
import {
  SlackConfigTokenError,
  hasConfigToken,
  saveConfigRefreshToken,
} from "@/lib/slack-config-token";
import { createSlackApp, deleteSlackApp } from "@/lib/slack-apps";

export type CreateAgentField =
  | "configToken"
  | "handle"
  | "description"
  | "model"
  | "instructions";

/** Everything but the token, which is a secret and never goes back to the client. */
type CreateAgentValueField = Exclude<CreateAgentField, "configToken">;

export type CreateAgentState = {
  status: "idle" | "error";
  message?: string;
  errors?: Partial<Record<CreateAgentField, string>>;
  /**
   * Echoed back on failure. React resets a form once its action resolves, so
   * without this the fields would revert to empty and the person would have to
   * retype everything to fix one mistake.
   */
  values?: Record<CreateAgentValueField, string>;
  /**
   * Set once this workspace's configuration token is stored, so a form that
   * asked for one stops asking — the rest of the attempt may still have failed
   * validation, and the pasted token is spent by then.
   */
  tokenAccepted?: boolean;
};

/** Slack's bot_user.display_name character set. */
const HANDLE_RE = /^[a-z0-9._-]+$/;

export type ConfigTokenState = { error?: string; saved?: boolean };

/**
 * Stores the workspace's app configuration token on its own — the setup
 * dialog that opens after sign-in. Saving rotates the token at Slack, which
 * both checks it and spends what was pasted (see `saveConfigRefreshToken`).
 */
export async function saveConfigTokenAction(
  _previous: ConfigTokenState,
  formData: FormData,
): Promise<ConfigTokenState> {
  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  if (!workspaceId) {
    return { error: "Your session has expired. Sign in again." };
  }

  const configToken = str(formData.get("configToken"));
  if (!configToken) return { error: "Paste the refresh token." };

  try {
    await saveConfigRefreshToken(workspaceId, configToken);
  } catch (error) {
    return { error: configTokenFailureMessage(error) };
  }

  // The layout decides whether to show the dialog, so it has to see the change.
  revalidatePath("/app", "layout");
  return { saved: true };
}

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

  const handle = str(formData.get("handle")).replace(/^@/, "").toLowerCase();
  const description = str(formData.get("description"));
  const model = str(formData.get("model"));
  const instructions = str(formData.get("instructions"));
  const configToken = str(formData.get("configToken"));

  const values = { handle, description, model, instructions };
  const errors: Partial<Record<CreateAgentField, string>> = {};

  // The app is created in whichever workspace the configuration token came
  // from, so this workspace needs one of its own before it can have agents.
  // The form asks for it when it's missing; `tokenAccepted` tells the form to
  // stop asking, because storing it spends what was pasted.
  let tokenAccepted = false;
  const configured = await hasConfigToken(workspaceId);
  if (!configured && !configToken) {
    errors.configToken = "Paste an app configuration token to create agents here.";
  }

  if (!handle) errors.handle = "Pick a Slack handle.";
  else if (handle.length > HANDLE_MAX)
    errors.handle = `Slack caps app names at ${HANDLE_MAX} characters.`;
  else if (!HANDLE_RE.test(handle))
    errors.handle = "Use lowercase letters, numbers, and . _ - only.";

  if (description.length > DESCRIPTION_MAX)
    errors.description = `Slack caps app descriptions at ${DESCRIPTION_MAX} characters.`;

  if (!isModelId(model)) errors.model = "Choose a model.";

  if (!instructions)
    errors.instructions = "Tell your coworker what to do and how to behave.";
  else if (instructions.length > INSTRUCTIONS_MAX)
    errors.instructions = `Keep the instructions under ${INSTRUCTIONS_MAX} characters.`;

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

  // Stored only once the rest of the form is known good: the first rotation
  // invalidates the pasted token, so a form that still has mistakes in it
  // shouldn't be allowed to spend one.
  if (!configured) {
    try {
      await saveConfigRefreshToken(workspaceId, configToken);
      tokenAccepted = true;
    } catch (error) {
      return {
        status: "error",
        errors: { configToken: configTokenFailureMessage(error) },
        values,
      };
    }
  }

  // The app starts out subscribed to nothing and asking for the base scopes
  // only. Events and tools are the person's choices, made on the agent's
  // page; each one changes the manifest when it's made.
  let slackApp;
  try {
    slackApp = await createSlackApp(workspaceId, {
      handle,
      description: description || null,
      tools: [],
    });
  } catch (error) {
    // A token that died between the check above and here is a field problem,
    // not a Slack outage — the form asks for a new one rather than telling
    // the person to try again.
    if (error instanceof SlackConfigTokenError) {
      return {
        status: "error",
        errors: { configToken: error.message },
        values,
        tokenAccepted: false,
      };
    }
    return { status: "error", message: slackAppFailureMessage(error), values, tokenAccepted };
  }

  let agent;
  try {
    agent = await createAgent({
      workspaceId,
      handle,
      description: description || null,
      instructions,
      model,
      slackApp,
    });
  } catch (error) {
    // The Slack app exists but nothing points at it any more. Clean it up so
    // the handle stays free and the workspace doesn't collect orphans.
    await deleteSlackApp(workspaceId, slackApp.appId).catch(() => {});
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

function configTokenFailureMessage(error: unknown) {
  if (error instanceof SlackConfigTokenError) return error.message;
  return error instanceof Error ? error.message : "That token could not be saved.";
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
      return `Slack rejected the app manifest: ${describeSlackErrors(error.details) || "no details given."}`;
    case "invalid_auth":
    case "not_authed":
    case "token_expired":
      return "The Slack app configuration token was rejected. Generate a new one at https://api.slack.com/apps.";
    default:
      return `Slack could not create the app (${error.code}).`;
  }
}

