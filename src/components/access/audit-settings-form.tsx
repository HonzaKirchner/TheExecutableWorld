"use client";

import { useActionState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";

import {
  saveAuditSettingsAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";
import type { Agent } from "@/lib/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Where a gated tool call goes to wait for a person, and who's allowed to
 * decide it. Every agent shares one channel and one whitelist — a tool's own
 * classifier is the finer-grained control, set alongside it in Access.
 */
export function AuditSettingsForm({ agent }: { agent: Agent }) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    saveAuditSettingsAction,
    {},
  );

  return (
    <section className="mt-12">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-1 size-4 text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Approvals</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Where @{agent.handle} asks a person before running a tool marked{" "}
            <span className="font-medium text-foreground">Needs approval</span>.
          </p>
        </div>
      </div>

      <form action={formAction} className="mt-5 max-w-lg space-y-4 rounded-xl border bg-card p-5">
        <input type="hidden" name="agentId" value={agent.id} />

        <div className="space-y-1.5">
          <Label htmlFor="auditChannelId">Slack channel ID</Label>
          <Input
            id="auditChannelId"
            name="auditChannelId"
            defaultValue={agent.auditChannelId ?? ""}
            placeholder="C0123456789"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            The bot must already be in this channel. Find the ID in Slack under &ldquo;Copy
            channel ID&rdquo;.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="approvalWhitelist">Who may decide</Label>
          <Input
            id="approvalWhitelist"
            name="approvalWhitelist"
            defaultValue={agent.approvalWhitelist?.join(", ") ?? ""}
            placeholder="U0123456789, U0987654321"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Slack user IDs, comma-separated. Left blank, anyone in the channel can approve,
            decline or stop.
          </p>
        </div>

        {state.error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {state.error}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={pending} className="gap-2">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </section>
  );
}
