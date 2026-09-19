"use client";

import { useActionState, useState } from "react";
import { Hash, Loader2, Lock, ShieldAlert, X } from "lucide-react";

import {
  saveAuditSettingsAction,
  type AccessActionState,
} from "@/app/app/[agentId]/access/actions";
import type { Agent } from "@/lib/agents";
import type { SlackChannelOption, SlackDirectory, SlackUserOption } from "@/lib/slack-directory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Where a gated tool call goes to wait for a person, and who's allowed to
 * decide it. Every agent shares one channel and one whitelist — a tool's own
 * classifier is the finer-grained control, set alongside it in Access.
 *
 * Once the app is installed the channel and the people are picked from what
 * Slack lists for the bot (`directory`); before that, or where the install's
 * scopes don't reach, the ids are typed in as they always were.
 */
export function AuditSettingsForm({
  agent,
  directory,
}: {
  agent: Agent;
  directory: SlackDirectory;
}) {
  const [state, formAction, pending] = useActionState<AccessActionState, FormData>(
    saveAuditSettingsAction,
    {},
  );

  return (
    <section className="mt-12">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-1 size-4 text-muted-foreground" />
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Approvals</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Where @{agent.handle} asks a person before running a tool marked{" "}
            <span className="font-medium text-foreground">Needs approval</span>.
          </p>
        </div>
      </div>

      <form action={formAction} className="mt-5 max-w-lg space-y-5 rounded-xl border bg-card p-5">
        <input type="hidden" name="agentId" value={agent.id} />

        {directory.channels ? (
          <ChannelPicker channels={directory.channels} initial={agent.auditChannelId} />
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="auditChannelId">Slack channel ID</Label>
            <Input
              id="auditChannelId"
              name="auditChannelId"
              defaultValue={agent.auditChannelId ?? ""}
              placeholder="C0123456789"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              The bot must already be in this channel. Find the ID in Slack under &ldquo;Copy
              channel ID&rdquo;.{" "}
              {agent.slackInstalledAt
                ? `To pick from a list instead, give @${agent.handle} the List channels tool and reinstall.`
                : "Install the app to pick from a list."}
            </p>
          </div>
        )}

        {directory.users ? (
          <PeoplePicker users={directory.users} initial={agent.approvalWhitelist ?? []} />
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="approvalWhitelist">Who may decide</Label>
            <Input
              id="approvalWhitelist"
              name="approvalWhitelist"
              defaultValue={agent.approvalWhitelist?.join(", ") ?? ""}
              placeholder="U0123456789, U0987654321"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Slack user IDs, comma-separated. Left blank, anyone in the channel can approve,
              decline or stop.
              {agent.slackInstalledAt ? "" : " Install the app to pick people by name."}
            </p>
          </div>
        )}

        {state.error ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {state.error}
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" disabled={pending} className="gap-2">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Radix's Select can't carry an empty value, so "no channel" is this and the hidden input sends "". */
const NONE = "__none__";

function ChannelPicker({
  channels,
  initial,
}: {
  channels: SlackChannelOption[];
  initial: string | null;
}) {
  const [value, setValue] = useState(initial ?? NONE);
  // A saved channel the bot has since left still has to be shown, or saving
  // anything else on the form would silently drop it.
  const options =
    initial && !channels.some((channel) => channel.id === initial)
      ? [...channels, { id: initial, name: `${initial} (no longer listed)`, private: false }]
      : channels;

  return (
    <div className="space-y-1.5">
      <Label htmlFor="auditChannel">Slack channel</Label>
      <input type="hidden" name="auditChannelId" value={value === NONE ? "" : value} />
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger id="auditChannel" className="w-full">
          <SelectValue placeholder="Choose a channel" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>
            <span className="text-muted-foreground">Not set</span>
          </SelectItem>
          {options.map((channel) => (
            <SelectItem key={channel.id} value={channel.id}>
              <span className="flex items-center gap-1.5">
                {channel.private ? (
                  <Lock className="size-3.5 text-muted-foreground" />
                ) : (
                  <Hash className="size-3.5 text-muted-foreground" />
                )}
                {channel.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Only channels the bot is in are listed. Invite it to a channel to see it here.
      </p>
    </div>
  );
}

function PeoplePicker({ users, initial }: { users: SlackUserOption[]; initial: string[] }) {
  const [chosen, setChosen] = useState<string[]>(initial);
  const byId = new Map(users.map((user) => [user.id, user]));
  const remaining = users.filter((user) => !chosen.includes(user.id));

  return (
    <div className="space-y-1.5">
      <Label htmlFor="approvalPerson">Who may decide</Label>
      {chosen.map((id) => (
        <input key={id} type="hidden" name="approvalWhitelist" value={id} />
      ))}

      {chosen.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5 pb-1">
          {chosen.map((id) => {
            const user = byId.get(id);
            return (
              <li
                key={id}
                className="inline-flex items-center gap-1 rounded-full border bg-background py-0.5 pr-1 pl-2.5 text-sm"
              >
                <span>{user?.name ?? id}</span>
                {user ? (
                  <span className="text-xs text-muted-foreground">@{user.handle}</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => setChosen(chosen.filter((other) => other !== id))}
                  aria-label={`Remove ${user?.name ?? id}`}
                  className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Uncontrolled with a changing key: the trigger resets to the placeholder after each add. */}
      <Select
        key={chosen.length}
        onValueChange={(id) => setChosen([...chosen, id])}
        disabled={remaining.length === 0}
      >
        <SelectTrigger id="approvalPerson" className="w-full">
          <SelectValue
            placeholder={
              remaining.length === 0 ? "Everyone in the workspace is listed" : "Add a person…"
            }
          />
        </SelectTrigger>
        <SelectContent>
          {remaining.map((user) => (
            <SelectItem key={user.id} value={user.id}>
              <span className="flex items-baseline gap-1.5">
                {user.name}
                <span className="text-xs text-muted-foreground">@{user.handle}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        With nobody chosen, anyone in the channel can approve, decline or stop.
      </p>
    </div>
  );
}
