"use client";

import { useActionState } from "react";
import { Loader2, Unplug } from "lucide-react";

import {
  disconnectMcpServerAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";
import { Button } from "@/components/ui/button";

export function DisconnectServerButton({
  agentId,
  serverId,
  serverName,
}: {
  agentId: string;
  serverId: string;
  serverName: string;
}) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    disconnectMcpServerAction,
    {},
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!confirm(`Disconnect ${serverName}? The agent loses access to all of its tools.`)) {
          event.preventDefault();
        }
      }}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="serverId" value={serverId} />
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      <Button type="submit" variant="ghost" size="sm" disabled={pending} className="gap-1.5 text-muted-foreground">
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Unplug className="size-3.5" />}
        Disconnect
      </Button>
    </form>
  );
}
