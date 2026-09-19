"use client";

import { useActionState, useId, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Search, ShieldCheck } from "lucide-react";

import {
  saveToolAccessAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";
import type { McpTool } from "@/lib/mcp/connections";
import { toolTraits, type ToolTrait } from "@/lib/mcp/tools";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

type Choice = { allowed: boolean; requiresApproval: boolean };

export function ToolAccessForm({
  agentId,
  serverId,
  serverName,
  agentHandle,
  tools,
}: {
  agentId: string;
  serverId: string;
  serverName: string;
  agentHandle: string;
  tools: McpTool[];
}) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    saveToolAccessAction,
    {},
  );

  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        { allowed: tool.allowed, requiresApproval: tool.requiresApproval },
      ]),
    ),
  );
  const [query, setQuery] = useState("");
  const searchId = useId();

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tools;
    return tools.filter((tool) =>
      [tool.name, tool.title, tool.description].some((text) =>
        text?.toLowerCase().includes(needle),
      ),
    );
  }, [tools, query]);

  const allowedCount = tools.filter((tool) => choices[tool.name]?.allowed).length;

  function update(name: string, patch: Partial<Choice>) {
    setChoices((current) => ({ ...current, [name]: { ...current[name], ...patch } }));
  }

  function setAll(allowed: boolean) {
    setChoices((current) =>
      Object.fromEntries(
        Object.entries(current).map(([name, choice]) => [name, { ...choice, allowed }]),
      ),
    );
  }

  return (
    <form action={formAction} className="mt-8">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="serverId" value={serverId} />
      {/*
        The submitted values live here rather than on the controls, so a tool
        hidden by the filter still gets sent — an unmounted control would
        silently drop its choice.
      */}
      {tools.map((tool) => {
        const choice = choices[tool.name];
        if (!choice?.allowed) return null;
        return (
          <span key={tool.name} hidden>
            <input type="hidden" name="allowed" value={tool.name} />
            {choice.requiresApproval ? (
              <input type="hidden" name="approval" value={tool.name} />
            ) : null}
          </span>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{allowedCount}</span> of{" "}
          {tools.length} tools allowed
        </p>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setAll(true)}>
            Allow all
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAll(false)}>
            Allow none
          </Button>
        </div>
      </div>

      {tools.length > 8 ? (
        <div className="relative mt-4">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Filter ${serverName} tools`}
            aria-label="Filter tools"
            className="pl-8"
          />
        </div>
      ) : null}

      <ul className="mt-4 divide-y overflow-hidden rounded-xl border bg-card">
        {visible.map((tool) => {
          const choice = choices[tool.name] ?? { allowed: false, requiresApproval: true };
          return (
            <ToolRow
              key={tool.name}
              tool={tool}
              choice={choice}
              onChange={(patch) => update(tool.name, patch)}
            />
          );
        })}
        {visible.length === 0 ? (
          <li className="px-5 py-10 text-center text-sm text-muted-foreground">
            No tools match &ldquo;{query}&rdquo;.
          </li>
        ) : null}
      </ul>

      <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Tools marked <span className="font-medium text-foreground">Needs approval</span>{" "}
          pause for a human&apos;s go-ahead before running. The suggestions come from
          what {serverName} says about each tool — anything not declared read-only
          starts out needing approval.
        </span>
      </p>

      {state.error ? (
        <p
          aria-live="polite"
          className="animate-in fade-in mt-6 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {state.error}
        </p>
      ) : null}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <p className="text-xs text-muted-foreground">
          Changes apply the next time @{agentHandle} picks a tool.
        </p>
        <div className="flex items-center gap-2">
          <Button asChild type="button" variant="ghost" disabled={pending}>
            <Link href={`/app/${agentId}`}>Cancel</Link>
          </Button>
          <Button type="submit" disabled={pending} className="gap-2">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {pending ? "Saving…" : "Save access"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function ToolRow({
  tool,
  choice,
  onChange,
}: {
  tool: McpTool;
  choice: Choice;
  onChange: (patch: Partial<Choice>) => void;
}) {
  const checkboxId = useId();
  const switchId = useId();
  const title = tool.title && tool.title !== tool.name ? tool.title : null;

  return (
    <li
      data-allowed={choice.allowed}
      className="flex items-start gap-4 px-5 py-4 transition-colors data-[allowed=false]:bg-muted/30"
    >
      <Checkbox
        id={checkboxId}
        checked={choice.allowed}
        onCheckedChange={(checked) => onChange({ allowed: checked === true })}
        className="mt-1"
      />
      <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{title ?? tool.name}</span>
          {title ? (
            <span className="font-mono text-xs text-muted-foreground">{tool.name}</span>
          ) : null}
          {toolTraits(tool.annotations).map((trait) => (
            <TraitBadge key={trait} trait={trait} />
          ))}
        </div>
        {tool.description ? (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground" title={tool.description}>
            {tool.description}
          </p>
        ) : null}
      </label>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <label
          htmlFor={switchId}
          className={`text-xs transition-colors ${
            choice.allowed ? "text-muted-foreground" : "text-muted-foreground/40"
          }`}
        >
          Needs approval
        </label>
        <Switch
          id={switchId}
          checked={choice.requiresApproval}
          disabled={!choice.allowed}
          onCheckedChange={(checked) => onChange({ requiresApproval: checked })}
        />
      </div>
    </li>
  );
}

function TraitBadge({ trait }: { trait: ToolTrait }) {
  switch (trait) {
    case "read-only":
      return <Badge variant="secondary" className="text-[10px]">Read-only</Badge>;
    case "destructive":
      return <Badge variant="destructive" className="text-[10px]">Destructive</Badge>;
    case "open-world":
      return <Badge variant="outline" className="text-[10px]">Open world</Badge>;
  }
}
