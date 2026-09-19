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
      <p className="mt-1 text-sm text-muted-foreground">
        What makes this coworker act.
      </p>

      <ul className="mt-6 grid gap-3 sm:grid-cols-2">
        {TRIGGERS.map((definition, i) => {
          const trigger = byKind.get(definition.id);
          return (
            <li
              key={definition.id}
              data-available={definition.available}
              className="flex h-full flex-col rounded-xl border bg-card p-5 animate-in fade-in slide-in-from-bottom-1 duration-500 [animation-fill-mode:backwards] data-[available=false]:border-dashed data-[available=false]:bg-card/50 data-[available=false]:opacity-60"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
                  <Zap className="size-4" />
                </span>
                {!definition.available ? (
                  <Badge variant="outline" className="text-[10px]">
                    Not implemented yet
                  </Badge>
                ) : trigger ? (
                  <Badge
                    variant={installed ? "secondary" : "outline"}
                    className="text-[10px]"
                  >
                    {installed ? "Active" : "Waiting for install"}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px]">
                    Not added
                  </Badge>
                )}
              </div>
              <h3 className="mt-4 font-medium">{definition.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {definition.description}
              </p>

              {trigger && definition.id === "slack" ? (
                <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t pt-4">
                  {BOT_EVENTS.map((event) => (
                    <Badge
                      key={event}
                      variant="outline"
                      className="font-mono text-[10px]"
                    >
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
                      <TooltipContent
                        side="bottom"
                        align="end"
                        className="max-w-[90vw]"
                      >
                        <span className="font-mono text-[11px] break-all">
                          {slackEventsUrl(trigger.id)}
                        </span>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
