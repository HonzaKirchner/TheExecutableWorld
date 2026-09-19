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
  accent,
}: {
  agentId: string;
  /** The app is already installed; offer to run the install again. */
  reinstall?: boolean;
  /** The page's call to action: coloured to match the install panel. */
  accent?: boolean;
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
        size={accent ? "lg" : "default"}
        variant={reinstall && !accent ? "outline" : "default"}
        disabled={pending}
        className={
          accent && reinstall
            ? // Reinstalling for new permissions sits on the amber panel.
              "gap-2 bg-amber-600 text-white shadow-sm hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-400"
            : accent
              ? "gap-2 bg-violet-600 text-white shadow-sm hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-400"
              : "gap-2"
        }
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
