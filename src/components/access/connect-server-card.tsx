"use client";

import { useActionState } from "react";
import { Loader2, Plug, X } from "lucide-react";

import {
  connectMcpServerAction,
  disconnectMcpServerAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";
import type { McpServerInfo } from "@/lib/mcp/catalog";
import { ServerMark } from "@/components/access/server-mark";

/**
 * A server the agent isn't connected to yet. The whole card is the submit
 * button: one click starts the authorization.
 *
 * Custom servers whose authorization never finished are removable from here,
 * since there's no other page for them until they're connected.
 */
export function ConnectServerCard({
  agentId,
  server,
  removable,
}: {
  agentId: string;
  server: McpServerInfo;
  removable?: boolean;
}) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    connectMcpServerAction,
    {},
  );

  return (
    <div className="relative h-full">
      <form action={formAction} className="h-full">
        <input type="hidden" name="agentId" value={agentId} />
        <input type="hidden" name="serverId" value={server.id} />
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="group flex h-full w-full gap-4 rounded-xl border border-dashed bg-card/50 p-4 text-left transition-all outline-none hover:-translate-y-0.5 hover:border-border hover:bg-card hover:shadow-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-progress disabled:hover:translate-y-0"
        >
          <ServerMark name={server.name} muted className="size-10" />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-3">
              <h3 className="truncate font-medium">{server.name}</h3>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
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
            <p
              className={`mt-1 line-clamp-2 text-sm text-muted-foreground ${
                server.custom ? "font-mono text-xs leading-5 break-all" : ""
              }`}
            >
              {server.description}
            </p>
            {state.error ? (
              <p aria-live="polite" className="animate-in fade-in mt-2 text-xs text-destructive">
                {state.error}
              </p>
            ) : null}
          </div>
        </button>
      </form>
      {removable ? <RemoveButton agentId={agentId} server={server} /> : null}
    </div>
  );
}

function RemoveButton({ agentId, server }: { agentId: string; server: McpServerInfo }) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    disconnectMcpServerAction,
    {},
  );

  return (
    <form action={formAction} className="absolute -top-2 -right-2">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="serverId" value={server.id} />
      <button
        type="submit"
        disabled={pending}
        title={state.error ?? `Remove ${server.name}`}
        aria-label={`Remove ${server.name}`}
        className="flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
      </button>
    </form>
  );
}
