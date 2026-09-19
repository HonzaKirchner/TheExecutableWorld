"use client";

import { useActionState, useId, useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { createAgentAction, type CreateAgentState } from "@/app/app/actions";
import { DEFAULT_MODEL, MODELS } from "@/lib/models";
import {
  DESCRIPTION_MAX,
  HANDLE_MAX,
  INSTRUCTIONS_MAX,
} from "@/lib/agent-limits";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const INITIAL_STATE: CreateAgentState = { status: "idle" };

export function NewAgentDialog() {
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
        <Button className="gap-2 transition-all active:scale-[0.98]">
          <Plus className="size-4" />
          New agent
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            This creates a Slack app for your coworker. You&apos;ll give it
            access to tools and install it next.
          </DialogDescription>
        </DialogHeader>

        <NewAgentForm key={formKey} />
      </DialogContent>
    </Dialog>
  );
}

function NewAgentForm() {
  // On success the action redirects to the new agent, so the only state that
  // ever comes back here is an error.
  const [state, formAction, pending] = useActionState(
    createAgentAction,
    INITIAL_STATE,
  );

  const handleId = useId();
  const descriptionId = useId();
  const modelId = useId();
  const instructionsId = useId();

  return (
    <form action={formAction} className="grid gap-5">
      <Field
        id={handleId}
        label="Handle"
        error={state.errors?.handle}
        hint="Their name in Slack, and how people will @mention them."
      >
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center font-mono text-sm text-muted-foreground">
            @
          </span>
          <Input
            id={handleId}
            name="handle"
            defaultValue={state.values?.handle}
            placeholder="ada"
            maxLength={HANDLE_MAX}
            autoFocus
            required
            spellCheck={false}
            autoCapitalize="none"
            className="pl-6 font-mono"
            aria-invalid={Boolean(state.errors?.handle)}
          />
        </div>
      </Field>

      <Field
        id={descriptionId}
        label="Short description"
        error={state.errors?.description}
        hint="One line about what they do. Shown in Slack next to the app."
      >
        <Input
          id={descriptionId}
          name="description"
          defaultValue={state.values?.description}
          placeholder="Answers support questions from the docs"
          maxLength={DESCRIPTION_MAX}
          aria-invalid={Boolean(state.errors?.description)}
        />
      </Field>

      <Field id={modelId} label="Model" error={state.errors?.model}>
        <Select
          name="model"
          defaultValue={state.values?.model ?? DEFAULT_MODEL}
          required
        >
          <SelectTrigger
            id={modelId}
            className="w-full"
            aria-invalid={Boolean(state.errors?.model)}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODELS.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        id={instructionsId}
        label="Instructions"
        error={state.errors?.instructions}
        hint="Their job, how they work, what they never do. This is what they'll follow."
      >
        <Textarea
          id={instructionsId}
          name="instructions"
          defaultValue={state.values?.instructions}
          placeholder="You are a meticulous support engineer. Answer in plain language, always link the relevant doc, and escalate anything touching billing."
          maxLength={INSTRUCTIONS_MAX}
          required
          className="min-h-32"
          aria-invalid={Boolean(state.errors?.instructions)}
        />
      </Field>

      {state.status === "error" && state.message ? (
        <p
          aria-live="polite"
          className="animate-in fade-in rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {state.message}
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
          {pending ? "Creating Slack app…" : "Create agent"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="animate-in fade-in text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
