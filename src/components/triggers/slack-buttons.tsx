"use client";

import { useActionState } from "react";
import { Loader2, Unplug } from "lucide-react";

import {
  stopSlackEventsAction,
  type TriggerActionState,
} from "@/app/app/[agentId]/triggers/actions";
import { Button } from "@/components/ui/button";

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
