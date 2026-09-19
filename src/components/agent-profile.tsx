"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { Loader2, Pencil } from "lucide-react";

import { editAgentAction, type EditAgentState } from "@/app/app/[agentId]/actions";
import { DESCRIPTION_MAX, INSTRUCTIONS_MAX } from "@/lib/agent-limits";
import type { Agent } from "@/lib/agents";
import { MODELS } from "@/lib/models";
import { Button } from "@/components/ui/button";
import {
  Dialog,
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

/**
 * The instructions card, with the way to change the agent: Edit opens a
 * dialog for the description, the model and the instructions. `children` is
 * the row of facts under the card (model, created, Slack app), which the
 * page renders.
 */
export function AgentProfile({ agent, children }: { agent: Agent; children?: React.ReactNode }) {
  return (
    <section className="mt-8 overflow-hidden rounded-xl border bg-card">
      <div className="p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Instructions
          </h2>
          <EditAgentDialog agent={agent} />
        </div>
        <p className="mt-3 max-w-3xl text-[15px] leading-7 whitespace-pre-wrap">
          {agent.instructions ?? "No instructions yet."}
        </p>
      </div>
      {children}
    </section>
  );
}

function EditAgentDialog({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  // A fresh form each time the dialog opens: the previous attempt's errors
  // and edits shouldn't be waiting there.
  const [formKey, setFormKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setFormKey((key) => key + 1);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-mt-1.5 -mr-2 gap-1.5 text-muted-foreground"
        >
          <Pencil className="size-3.5" />
          Edit
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit @{agent.handle}</DialogTitle>
          <DialogDescription>
            Changes apply to the next run. The handle stays: it is the app&apos;s name in Slack.
          </DialogDescription>
        </DialogHeader>

        <EditAgentForm key={formKey} agent={agent} onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function EditAgentForm({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const [state, formAction, pending] = useActionState<EditAgentState, FormData>(editAgentAction, {
    status: "idle",
  });
  const descriptionId = useId();
  const modelId = useId();
  const instructionsId = useId();

  // The action's answer is the only sign the save went through; the dialog
  // closes once it has.
  useEffect(() => {
    if (state.status === "saved") onSaved();
  }, [state, onSaved]);

  return (
    <form action={formAction} className="grid gap-5">
      <input type="hidden" name="agentId" value={agent.id} />

      <Field
        id={descriptionId}
        label="Short description"
        error={state.errors?.description}
        hint="One line about what they do. Shown in Slack next to the app."
      >
        <Input
          id={descriptionId}
          name="description"
          defaultValue={agent.description ?? ""}
          placeholder="Answers support questions from the docs"
          maxLength={DESCRIPTION_MAX}
          aria-invalid={Boolean(state.errors?.description)}
        />
      </Field>

      <Field id={modelId} label="Model" error={state.errors?.model}>
        <Select name="model" defaultValue={agent.model} required>
          <SelectTrigger id={modelId} className="w-full" aria-invalid={Boolean(state.errors?.model)}>
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
        hint="Their job, how they work, what they never do. This is what they follow."
      >
        <Textarea
          id={instructionsId}
          name="instructions"
          defaultValue={agent.instructions ?? ""}
          maxLength={INSTRUCTIONS_MAX}
          required
          className="min-h-40"
          aria-invalid={Boolean(state.errors?.instructions)}
        />
      </Field>

      {state.status === "error" && state.message ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onSaved} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} className="gap-2">
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {pending ? "Saving…" : "Save changes"}
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
