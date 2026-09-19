import Link from "next/link";
import { Bot } from "lucide-react";

import { auth } from "@/auth";
import { listAgents } from "@/lib/agents";
import { NewAgentDialog } from "@/components/new-agent-dialog";
import { Badge } from "@/components/ui/badge";

export default async function AgentsPage() {
  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  const agents = workspaceId ? await listAgents(workspaceId) : [];

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 duration-500">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The AI coworkers you&apos;ve created.
          </p>
        </div>
        <NewAgentDialog />
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
          <div className="mt-6">
            <NewAgentDialog />
          </div>
        </div>
      ) : (
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {agents.map((agent, i) => (
            <li
              key={agent.id}
              className="animate-in fade-in slide-in-from-bottom-1 duration-500 [animation-fill-mode:backwards]"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <Link
                href={`/app/${agent.id}`}
                className="group flex h-full flex-col rounded-xl border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-border/80 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-medium transition-colors group-hover:text-foreground">
                      {agent.name}
                    </h2>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      @{agent.handle}
                    </p>
                  </div>
                  <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                    {agent.model}
                  </Badge>
                </div>

                {agent.description ? (
                  <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                    {agent.description}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
