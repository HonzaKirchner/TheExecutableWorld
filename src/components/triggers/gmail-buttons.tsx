"use client";

import { useActionState } from "react";
import { Loader2, Mail, Plug, Unplug } from "lucide-react";

import {
  connectMcpServerAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";
import {
  startGmailWatchAction,
  stopGmailWatchAction,
  type TriggerActionState,
} from "@/app/app/[agentId]/triggers/actions";
import { Button } from "@/components/ui/button";

const ACCENT =
  "gap-2 bg-rose-600 text-white shadow-sm hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-400";

/**
 * Sends the person to Google to grant the agent its Gmail connection — the
 * same step as the Gmail card under Access, offered here because the trigger
 * can't exist without it. Google lands them on the connection's tool page.
 */
export function ConnectGmailButton({ agentId }: { agentId: string }) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    connectMcpServerAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="serverId" value="gmail" />
      <Button type="submit" size="lg" disabled={pending} className={ACCENT}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
        {pending ? "Opening Google…" : "Connect Gmail"}
      </Button>
      {state.error ? (
        <p aria-live="polite" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function StartGmailWatchButton({ agentId }: { agentId: string }) {
  const [state, formAction, pending] = useActionState<TriggerActionState, FormData>(
    startGmailWatchAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name="agentId" value={agentId} />
      <Button type="submit" size="lg" disabled={pending} className={ACCENT}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
        {pending ? "Asking Gmail…" : "Start listening"}
      </Button>
      {state.error ? (
        <p aria-live="polite" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function StopGmailWatchButton({ agentId }: { agentId: string }) {
  const [state, formAction, pending] = useActionState<TriggerActionState, FormData>(
    stopGmailWatchAction,
    {},
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!confirm("Stop listening to this mailbox? The agent keeps its Gmail tools.")) {
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
