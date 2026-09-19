"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "cn";

import {
  installSlackAppAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";

/**
 * The Slack trigger's card while the agent's app isn't installed. Rather than
 * open a page that can't do anything yet, the whole card is a submit button
 * that starts the install; Slack sends the person back to the trigger's page,
 * where choosing events is the next step. Mirrors ConnectServerCard.
 */
export function InstallSlackTriggerCard({
  agentId,
  className,
  children,
}: {
  agentId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    installSlackAppAction,
    {},
  );

  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="returnTo" value="trigger" />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className={cn(
          className,
          "w-full text-left outline-none hover:-translate-y-0.5 hover:border-border/80 hover:shadow-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-progress disabled:hover:translate-y-0",
        )}
      >
        {children}
      </button>
      {state.error ? (
        <p aria-live="polite" className="animate-in fade-in -mt-1 text-xs text-destructive sm:col-span-2">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** The card's footer line; inside the form, so it knows when the install is starting. */
export function InstallSlackTriggerLabel() {
  const { pending } = useFormStatus();
  return (
    <span className="mt-3 flex items-center gap-0.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
      {pending ? (
        <>
          <Loader2 className="mr-1 size-3.5 animate-spin" />
          Opening Slack…
        </>
      ) : (
        <>
          Install to Slack
          <ChevronRight className="size-3.5" />
        </>
      )}
    </span>
  );
}
