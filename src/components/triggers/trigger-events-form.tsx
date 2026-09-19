"use client";

import { useActionState, useId, useMemo, useState } from "react";
import { Loader2, Lock } from "lucide-react";

import {
  saveGmailEventsAction,
  saveSlackEventsAction,
  saveStripeEventsAction,
  type TriggerActionState,
} from "@/app/app/[agentId]/triggers/actions";
import { botScopesFor } from "@/lib/slack-events-catalog";
import { isStripeEventType } from "@/lib/stripe-events";
import type { TriggerKind } from "@/lib/triggers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SAVE_ACTIONS = {
  slack: saveSlackEventsAction,
  stripe: saveStripeEventsAction,
  gmail: saveGmailEventsAction,
} satisfies Record<TriggerKind, unknown>;

const FOOTNOTES: Record<TriggerKind, string> = {
  slack: "Saved to the app's manifest at Slack.",
  stripe: "Only these events reach the agent; everything else Stripe sends is dropped here.",
  gmail: "Saving asks Gmail to watch the labels these need.",
};

export type EventOption = {
  id: string;
  name: string;
  description: string;
  required?: boolean;
};

/**
 * Which events a trigger listens for. The catalog is a checklist; Stripe's
 * also takes event types typed in, since its catalog is only a selection.
 * For Slack the bot scopes the choice needs are shown live, because a new
 * scope means the app has to be installed again.
 */
export function TriggerEventsForm({
  agentId,
  kind,
  options,
  selected,
  granted,
  allowedTools = [],
}: {
  agentId: string;
  kind: TriggerKind;
  options: EventOption[];
  selected: string[];
  /** Slack: scopes the current install granted, to point out new ones. */
  granted?: string[] | null;
  /** Slack: the tools allowed under Access, whose scopes the install needs as well. */
  allowedTools?: string[];
}) {
  const [state, formAction, pending] = useActionState<TriggerActionState, FormData>(
    SAVE_ACTIONS[kind],
    {},
  );

  const known = useMemo(() => new Set(options.map((option) => option.id)), [options]);
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set([...selected, ...options.filter((o) => o.required).map((o) => o.id)]),
  );
  // Event types the trigger already has that aren't in the catalog.
  const [custom, setCustom] = useState(() =>
    selected.filter((id) => !known.has(id)).join(" "),
  );
  const customId = useId();

  const customTypes = custom.split(/[\s,]+/).filter(Boolean);
  const invalidCustom = customTypes.filter((type) => !isStripeEventType(type.toLowerCase()));

  const scopes = kind === "slack" ? botScopesFor(chosen, allowedTools) : [];
  const grantedSet = new Set(granted ?? []);
  const newScopes = granted ? scopes.filter((scope) => !grantedSet.has(scope)) : [];

  return (
    <form action={formAction} className="mt-8">
      <input type="hidden" name="agentId" value={agentId} />

      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {options.map((option) => {
          const checked = chosen.has(option.id);
          const inputId = `${customId}-${option.id}`;
          return (
            <li key={option.id} className="flex items-start gap-3 px-4 py-3">
              <Checkbox
                id={inputId}
                name="events"
                value={option.id}
                checked={checked}
                disabled={option.required}
                onCheckedChange={(next) =>
                  setChosen((current) => {
                    const copy = new Set(current);
                    if (next === true) copy.add(option.id);
                    else copy.delete(option.id);
                    return copy;
                  })
                }
                className="mt-0.5"
              />
              {/* A disabled checkbox isn't submitted; the required event still has to be. */}
              {option.required ? <input type="hidden" name="events" value={option.id} /> : null}
              <label htmlFor={inputId} className="flex min-w-0 flex-1 cursor-pointer flex-col">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{option.name}</span>
                  <code className="font-mono text-[11px] text-muted-foreground">{option.id}</code>
                  {option.required ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <Lock className="size-3" />
                      always on
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 text-sm text-muted-foreground">{option.description}</span>
              </label>
            </li>
          );
        })}
      </ul>

      {kind === "stripe" ? (
        <div className="mt-6 grid gap-2">
          <Label htmlFor={customId}>Other event types</Label>
          <Input
            id={customId}
            name="custom"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="payout.failed charge.dispute.closed"
            spellCheck={false}
            autoCapitalize="none"
            className="font-mono text-sm"
            aria-invalid={invalidCustom.length > 0}
          />
          <p className="text-xs text-muted-foreground">
            Any event Stripe sends, separated by spaces — see{" "}
            <a
              href="https://docs.stripe.com/api/events/types"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4 hover:text-foreground"
            >
              the full list
            </a>
            .
          </p>
          {invalidCustom.length > 0 ? (
            <p className="text-xs text-destructive">
              Not event types: {invalidCustom.join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {kind === "slack" ? (
        <div className="mt-6 rounded-xl border bg-muted/30 px-4 py-3">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Bot permissions these need
            {allowedTools.length > 0 ? " (with the Slack tools allowed under Access)" : null}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {scopes.map((scope) => (
              <Badge
                key={scope}
                variant="outline"
                className={`font-mono text-[10px] ${
                  newScopes.includes(scope)
                    ? "border-amber-400/70 bg-amber-50 text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-300"
                    : ""
                }`}
              >
                {scope}
              </Badge>
            ))}
          </div>
          {newScopes.length > 0 ? (
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
              The highlighted permissions aren&apos;t granted yet. Save, then reinstall the app
              so Slack asks for them.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {FOOTNOTES[kind]}
        </p>
        <div className="flex items-center gap-3">
          {state.error ? (
            <p aria-live="polite" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending || invalidCustom.length > 0} className="gap-2">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {pending ? "Saving…" : "Save events"}
          </Button>
        </div>
      </div>
    </form>
  );
}
