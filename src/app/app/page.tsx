import { Plus, Bot } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function AgentsPage() {
  // No agents yet — this is where the user's list will be rendered.
  const agents: { id: string; name: string }[] = [];

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 duration-500">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The AI coworkers you&apos;ve created.
          </p>
        </div>
        <Button className="gap-2 transition-all active:scale-[0.98]">
          <Plus className="size-4" />
          New agent
        </Button>
      </div>

      {agents.length === 0 ? (
        <div className="mt-8 flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-20 text-center transition-colors hover:border-border/80 hover:bg-muted/30">
          <div className="flex size-11 items-center justify-center rounded-full border bg-card text-muted-foreground">
            <Bot className="size-5" />
          </div>
          <h2 className="mt-5 text-base font-medium">No agents yet</h2>
          <p className="mt-1.5 max-w-xs text-sm text-muted-foreground">
            Create your first AI coworker to get started.
          </p>
        </div>
      ) : null}
    </div>
  );
}
