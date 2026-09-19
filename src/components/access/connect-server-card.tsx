"use client";

import { useActionState } from "react";
import { Loader2, Plug } from "lucide-react";

import {
  connectMcpServerAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";
import type { McpServerDefinition } from "@/lib/mcp/catalog";
import { ServerMark } from "@/components/access/server-mark";

/**
 * A catalog entry the agent isn't connected to yet. The whole card is the
 * submit button: one click starts the authorization.
 */
export function ConnectServerCard({
  agentId,
  server,
}: {
  agentId: string;
  server: McpServerDefinition;
}) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    connectMcpServerAction,
    {},
  );

  return (
    <form action={formAction} className="h-full">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="serverId" value={server.id} />
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="group flex h-full w-full flex-col rounded-xl border border-dashed bg-card/50 p-5 text-left transition-all outline-none hover:-translate-y-0.5 hover:border-border hover:bg-card hover:shadow-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-progress disabled:hover:translate-y-0"
      >
        <div className="flex items-start justify-between gap-3">
          <ServerMark name={server.name} muted />
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
            {pending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Connecting…
              </>
            ) : (
              <>
                <Plug className="size-3.5" />
                Connect
              </>
            )}
          </span>
        </div>
        <h3 className="mt-4 font-medium">{server.name}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {server.description}
        </p>
        {state.error ? (
          <p
            aria-live="polite"
            className="animate-in fade-in mt-3 text-xs text-destructive"
          >
            {state.error}
          </p>
        ) : null}
      </button>
    </form>
  );
}
