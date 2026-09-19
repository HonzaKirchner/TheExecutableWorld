import { Link2, Zap } from "lucide-react";

import type { Agent } from "@/lib/agents";
import { BOT_EVENTS } from "@/lib/slack-apps";
import { slackEventsUrl, TRIGGERS, type Trigger } from "@/lib/triggers";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function TriggersSection({
  agent,
  triggers,
}: {
  agent: Agent;
  triggers: Trigger[];
}) {
  const byKind = new Map(triggers.map((trigger) => [trigger.kind, trigger]));
  const installed = Boolean(agent.slackInstalledAt);

  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold tracking-tight">Triggers</h2>
      <p className="mt-1 text-sm text-muted-foreground">What makes this coworker act.</p>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {TRIGGERS.map((definition, i) => {
          const trigger = byKind.get(definition.id);
          const active = Boolean(trigger) && definition.available && installed;
          return (
            <li
              key={definition.id}
              data-available={definition.available}
              data-active={active}
              className="flex h-full gap-4 rounded-xl border bg-card p-4 animate-in fade-in slide-in-from-bottom-1 duration-500 [animation-fill-mode:backwards] data-[active=true]:border-emerald-300/70 data-[active=true]:bg-emerald-50/40 data-[available=false]:border-dashed data-[available=false]:bg-card/50 data-[available=false]:opacity-60 dark:data-[active=true]:border-emerald-800/60 dark:data-[active=true]:bg-emerald-950/20"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <span
                className={`flex size-10 shrink-0 items-center justify-center rounded-lg border ${
                  active
                    ? "border-emerald-700/20 bg-emerald-600 text-white"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                <Zap className="size-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="truncate font-medium">{definition.name}</h3>
                  <Status available={definition.available} added={Boolean(trigger)} active={active} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{definition.description}</p>

                {trigger && definition.id === "slack" ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {BOT_EVENTS.map((event) => (
                      <Badge key={event} variant="outline" className="font-mono text-[10px]">
                        {event}
                      </Badge>
                    ))}
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            <Link2 className="size-3.5" />
                            Webhook
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" align="end" className="max-w-[90vw]">
                          <span className="font-mono text-[11px] break-all">
                            {slackEventsUrl(trigger.id)}
                          </span>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Status({
  available,
  added,
  active,
}: {
  available: boolean;
  added: boolean;
  active: boolean;
}) {
  if (!available) {
    return <span className="shrink-0 text-xs text-muted-foreground">Not implemented yet</span>;
  }
  if (active) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-current" />
        Active
      </span>
    );
  }
  if (added) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
        <span className="size-1.5 rounded-full bg-current" />
        Waiting for install
      </span>
    );
  }
  return <span className="shrink-0 text-xs text-muted-foreground">Not added</span>;
}
