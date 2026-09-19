"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";

import {
  installSlackAppAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";
import { Button } from "@/components/ui/button";

export function InstallSlackButton({
  agentId,
  reinstall,
}: {
  agentId: string;
  /** The app is already installed; offer to run the install again. */
  reinstall?: boolean;
}) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    installSlackAppAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="agentId" value={agentId} />
      <Button
        type="submit"
        variant={reinstall ? "outline" : "default"}
        disabled={pending}
        className="gap-2"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {pending
          ? "Opening Slack…"
          : reinstall
            ? "Reinstall"
            : "Install to Slack"}
      </Button>
      {state.error ? (
        <p aria-live="polite" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
