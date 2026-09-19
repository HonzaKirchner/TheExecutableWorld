import Link from "next/link";
import { Bot, History } from "lucide-react";

import { auth } from "@/auth";
import { listAgents } from "@/lib/agents";
import { agentSessionsPath } from "@/lib/sessions";
import { hasConfigToken } from "@/lib/slack-config-token";
import { NewAgentDialog } from "@/components/new-agent-dialog";
import { Badge } from "@/components/ui/badge";

export default async function AgentsPage() {
  const session = await auth();
  const workspaceId = session?.slack?.teamId;
  const [agents, configured] = workspaceId
    ? await Promise.all([listAgents(workspaceId), hasConfigToken(workspaceId)])
    : [[], false];

  // Without a token of its own a workspace can't create Slack apps at all, so
  // the dialog asks for one before anything else.
  const needsConfigToken = Boolean(workspaceId) && !configured;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 duration-500">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The AI coworkers you&apos;ve created.
          </p>
        </div>
        <NewAgentDialog needsConfigToken={needsConfigToken} />
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
            <NewAgentDialog needsConfigToken={needsConfigToken} />
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
              {/*
                Two links, side by side rather than nested: the card opens the
                agent, its footer opens the agent's sessions.
              */}
              <div className="flex h-full flex-col overflow-hidden rounded-xl border bg-card transition-all hover:-translate-y-0.5 hover:border-border/80 hover:shadow-sm">
                <Link href={`/app/${agent.id}`} className="group flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="min-w-0 truncate font-medium transition-colors group-hover:text-foreground">
                      <span className="text-muted-foreground">@</span>
                      {agent.handle}
                    </h2>
                    <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                      {agent.model}
                    </Badge>
                  </div>

                  {agent.description ? (
                    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                      {agent.description}
                    </p>
                  ) : null}
                </Link>
                <Link
                  href={agentSessionsPath(agent.id)}
                  className="flex items-center gap-1.5 border-t px-5 py-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                >
                  <History className="size-3.5" />
                  Sessions
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
