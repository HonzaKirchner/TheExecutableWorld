"use client";

import { useActionState } from "react";
import { Loader2, Unplug, Wrench } from "lucide-react";

import {
  connectMcpServerAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";
import {
  stopSlackEventsAction,
  type TriggerActionState,
} from "@/app/app/[agentId]/triggers/actions";
import { Button } from "@/components/ui/button";

/**
 * Gives the agent its Slack *tools* — the same step as the Slack card under
 * Access, offered on the trigger page because being woken by Slack and
 * acting in it are two grants. No authorization to go through: the
 * connection takes the bot token the install granted, and lands on the
 * tool page.
 */
export function ConnectSlackToolsButton({ agentId }: { agentId: string }) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    connectMcpServerAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="serverId" value="slack" />
      <Button type="submit" variant="outline" disabled={pending} className="gap-2">
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Wrench className="size-4" />}
        {pending ? "Connecting…" : "Connect Slack tools"}
      </Button>
      {state.error ? (
        <p aria-live="polite" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** The agent stops listening to Slack. Its app stays installed, its tools keep working. */
export function StopSlackEventsButton({ agentId }: { agentId: string }) {
  const [state, formAction, pending] = useActionState<TriggerActionState, FormData>(
    stopSlackEventsAction,
    {},
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (
          !confirm(
            "Stop listening to Slack? Mentions and messages no longer wake this agent. It stays installed, and its Slack tools keep working.",
          )
        ) {
          event.preventDefault();
        }
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="agentId" value={agentId} />
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={pending}
        className="gap-1.5 text-muted-foreground"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
        Stop listening
      </Button>
    </form>
  );
}
