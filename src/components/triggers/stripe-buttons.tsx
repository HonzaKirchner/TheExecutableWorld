"use client";

import { useActionState } from "react";
import { Loader2, Plug, Unplug } from "lucide-react";

import {
  connectStripeAction,
  disconnectStripeAction,
  type TriggerActionState,
} from "@/app/app/[agentId]/triggers/actions";
import { Button } from "@/components/ui/button";

export function ConnectStripeButton({ agentId }: { agentId: string }) {
  const [state, formAction, pending] = useActionState<TriggerActionState, FormData>(
    connectStripeAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="agentId" value={agentId} />
      <Button
        type="submit"
        size="lg"
        disabled={pending}
        className="gap-2 bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-400"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
        {pending ? "Opening Stripe…" : "Connect Stripe"}
      </Button>
      {state.error ? (
        <p aria-live="polite" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function DisconnectStripeButton({ agentId }: { agentId: string }) {
  const [state, formAction, pending] = useActionState<TriggerActionState, FormData>(
    disconnectStripeAction,
    {},
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!confirm("Disconnect Stripe? The agent stops receiving its events.")) {
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
        Disconnect
      </Button>
    </form>
  );
}
