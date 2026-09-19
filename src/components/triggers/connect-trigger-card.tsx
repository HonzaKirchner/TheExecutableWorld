"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { ChevronRight, Loader2 } from "lucide-react";
import { cn } from "cn";

type ActionState = { error?: string };
type Action = (previous: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * A trigger's card while it isn't connected yet. Rather than open a page
 * whose only button would be "connect", the whole card is a submit button
 * that starts the connection — installing the Slack app, sending the person
 * to Stripe or Google, or asking Gmail to start watching. Each of those ends
 * on the trigger's page, where choosing events is the next step. Mirrors
 * ConnectServerCard under Access.
 *
 * `fields` are the hidden inputs the action reads beside `agentId`.
 */
export function ConnectTriggerCard({
  action,
  agentId,
  fields = {},
  className,
  children,
}: {
  action: Action;
  agentId: string;
  fields?: Record<string, string>;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {});

  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="agentId" value={agentId} />
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
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

/** The card's footer line; inside the form, so it knows when the connection is starting. */
export function ConnectTriggerLabel({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <span className="mt-3 flex items-center gap-0.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
      {pending ? (
        <>
          <Loader2 className="mr-1 size-3.5 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        <>
          {label}
          <ChevronRight className="size-3.5" />
        </>
      )}
    </span>
  );
}
