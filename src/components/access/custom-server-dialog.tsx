"use client";

import { useActionState, useId, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import {
  connectCustomMcpServerAction,
  type CustomServerState,
} from "@/app/app/[agentId]/access/actions";
import { CUSTOM_SERVER_NAME_MAX } from "@/lib/mcp/catalog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The button for servers the catalog doesn't know. Opens a dialog asking for
 * a name and the server's URL; connecting then runs exactly as it does for a
 * catalog server.
 */
export function CustomServerDialog({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  // Bumped on close so a reopened dialog starts from a blank form rather than
  // the errors left over from the last attempt.
  const [formKey, setFormKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFormKey((key) => key + 1);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3.5" />
          Custom
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect a custom server</DialogTitle>
          <DialogDescription>
            Any MCP server that speaks Streamable HTTP, by its URL. If it asks for sign-in,
            you&apos;ll be sent there to authorize and brought back.
          </DialogDescription>
        </DialogHeader>

        <CustomServerForm key={formKey} agentId={agentId} />
      </DialogContent>
    </Dialog>
  );
}

function CustomServerForm({ agentId }: { agentId: string }) {
  // On success the action redirects — to the server's tool list or its
  // authorization page — so the only state that comes back here is an error.
  const [state, formAction, pending] = useActionState<CustomServerState, FormData>(
    connectCustomMcpServerAction,
    {},
  );

  const nameId = useId();
  const urlId = useId();

  return (
    <form action={formAction} className="grid gap-5">
      <input type="hidden" name="agentId" value={agentId} />

      <div className="grid gap-2">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          name="name"
          defaultValue={state.values?.name}
          placeholder="Internal wiki"
          maxLength={CUSTOM_SERVER_NAME_MAX}
          autoFocus
          required
          aria-invalid={Boolean(state.errors?.name)}
        />
        <Hint error={state.errors?.name}>How it&apos;ll be labelled on this page.</Hint>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={urlId}>Server URL</Label>
        <Input
          id={urlId}
          name="url"
          type="url"
          inputMode="url"
          defaultValue={state.values?.url}
          placeholder="https://mcp.example.com/mcp"
          required
          spellCheck={false}
          autoCapitalize="none"
          className="font-mono text-sm"
          aria-invalid={Boolean(state.errors?.url)}
        />
        <Hint error={state.errors?.url}>
          The MCP endpoint itself, https only. Plain http works for localhost.
        </Hint>
      </div>

      {state.error ? (
        <p
          aria-live="polite"
          className="animate-in fade-in rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {state.error}
        </p>
      ) : null}

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="ghost" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={pending} className="gap-2">
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {pending ? "Connecting…" : "Connect"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Hint({ error, children }: { error?: string; children: React.ReactNode }) {
  return error ? (
    <p className="animate-in fade-in text-xs text-destructive">{error}</p>
  ) : (
    <p className="text-xs text-muted-foreground">{children}</p>
  );
}
