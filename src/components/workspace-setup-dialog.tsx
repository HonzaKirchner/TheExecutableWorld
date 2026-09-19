"use client";

import { useActionState, useId, useSyncExternalStore } from "react";
import { KeyRound, Loader2 } from "lucide-react";

import { saveConfigTokenAction, type ConfigTokenState } from "@/app/app/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CONFIG_TOKEN_URL = "https://api.slack.com/apps";

const INITIAL_STATE: ConfigTokenState = {};

/**
 * Shown right after sign-in to a workspace that has no app configuration
 * token on file. Coworkers are created as Slack apps *in* the person's own
 * workspace, and the Manifest API that does that authenticates with a
 * configuration token — which only a member of the workspace can generate,
 * by hand, at api.slack.com. So this asks for it up front rather than in the
 * middle of creating the first agent (the "New agent" dialog still asks, for
 * anyone who chose "Later").
 *
 * Open unless dismissed for this tab or just saved. Saving also revalidates
 * the layout, which stops rendering the dialog at all once the token is on
 * file.
 */
export function WorkspaceSetupDialog({ teamName }: { teamName?: string }) {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, readDismissedOnServer);
  const [state, formAction, pending] = useActionState(saveConfigTokenAction, INITIAL_STATE);
  const tokenId = useId();

  const open = !dismissed && !state.saved;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) markDismissed();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-amber-600 dark:text-amber-500" />
            Set up {teamName ?? "this workspace"}
          </DialogTitle>
          <DialogDescription>
            Your coworkers are created as Slack apps in your own workspace. Slack lets us do
            that with an{" "}
            <span className="font-medium text-foreground">app configuration token</span>, which
            you generate once and paste here.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="grid gap-5">
          <ol className="grid gap-2.5 text-sm">
            <Step n={1}>
              Open{" "}
              <a
                href={CONFIG_TOKEN_URL}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline underline-offset-2 hover:text-foreground"
              >
                api.slack.com/apps
              </a>{" "}
              while signed in to this workspace.
            </Step>
            <Step n={2}>
              Scroll to <span className="font-medium">Your App Configuration Tokens</span>,
              click <span className="font-medium">Generate Token</span> and pick this workspace.
            </Step>
            <Step n={3}>
              Copy the <span className="font-medium">Refresh Token</span> (it starts with{" "}
              <code className="font-mono text-xs">xoxe-1-</code>) and paste it below. The
              access token isn&apos;t needed — the app rotates the pair itself from here on.
            </Step>
          </ol>

          <div className="grid gap-2">
            <Label htmlFor={tokenId}>Refresh token</Label>
            <Input
              id={tokenId}
              name="configToken"
              type="password"
              placeholder="xoxe-1-…"
              required
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              className="font-mono"
              aria-invalid={Boolean(state.error)}
            />
            {state.error ? (
              <p aria-live="polite" className="animate-in fade-in text-xs text-destructive">
                {state.error}
              </p>
            ) : null}
          </div>

          <p className="rounded-lg border bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Why the copy-and-paste?</span> This
            is a temporary step. Slack can grant the same permission through its usual OAuth
            flow, but that grant isn&apos;t self-service — it has to be arranged with
            Slack&apos;s support first. Until that is in place, the token is the only way to
            create apps in your workspace. It&apos;s stored encrypted and never shown again.
          </p>

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={markDismissed}>
              Later
            </Button>
            <Button type="submit" disabled={pending} className="gap-2">
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {pending ? "Checking with Slack…" : "Save token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border bg-card font-mono text-[11px] text-muted-foreground">
        {n}
      </span>
      <span className="text-muted-foreground [&_.font-medium]:text-foreground">{children}</span>
    </li>
  );
}

/*
 * "Later" is remembered per tab, in sessionStorage, so the dialog doesn't
 * come back on every page until the person signs in again. Read through
 * useSyncExternalStore: the server, which has no storage, renders the dialog
 * closed, and the client corrects that after hydration without a mismatch.
 */

const DISMISSED_KEY = "workspace-setup-dismissed";

/** For a tab whose storage is blocked: still closes for this page load. */
let dismissedInMemory = false;

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readDismissed() {
  if (dismissedInMemory) return true;
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // Storage may be unavailable; asking again is the safe side.
    return false;
  }
}

function readDismissedOnServer() {
  return true;
}

function markDismissed() {
  dismissedInMemory = true;
  try {
    sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Nothing to do — the dialog simply comes back on the next page.
  }
  for (const listener of listeners) listener();
}
