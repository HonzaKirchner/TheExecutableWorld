import { CircleAlert, CircleCheck, Hash } from "lucide-react";

import type { Agent } from "@/lib/agents";
import { InstallSlackButton } from "@/components/access/install-slack-button";

/**
 * The step that makes an agent real: until its Slack app is installed, no
 * Slack event reaches it and it has no Slack tools. Tinted so it reads as
 * the call to action on the page without shouting.
 */
export function InstallSlackPanel({
  agent,
  missingScopes = [],
  listening,
}: {
  agent: Agent;
  /** Bot scopes the agent's events and tools now need but the install didn't grant. */
  missingScopes?: string[];
  /** Whether the agent has a Slack trigger, i.e. whether anyone can talk to it there. */
  listening: boolean;
}) {
  if (agent.slackInstalledAt && missingScopes.length > 0) {
    return (
      <section className="mt-12 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-amber-200/70 bg-gradient-to-br from-amber-50 to-orange-50/60 px-6 py-5 dark:border-amber-900/50 dark:from-amber-950/40 dark:to-orange-950/20">
        <div className="flex items-center gap-4">
          <span className="flex size-10 items-center justify-center rounded-full bg-amber-600/10 text-amber-700 dark:text-amber-400">
            <CircleAlert className="size-5" />
          </span>
          <div>
            <h2 className="font-medium">@{agent.handle} needs new permissions</h2>
            <p className="mt-0.5 max-w-lg text-sm text-muted-foreground">
              Its events and tools need {formatList(missingScopes)}. Reinstall so Slack asks
              for them.
            </p>
          </div>
        </div>
        <InstallSlackButton agentId={agent.id} reinstall accent />
      </section>
    );
  }

  if (agent.slackInstalledAt) {
    return (
      <section className="mt-12 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-teal-50/60 px-6 py-5 dark:border-emerald-900/50 dark:from-emerald-950/40 dark:to-teal-950/20">
        <div className="flex items-center gap-4">
          <span className="flex size-10 items-center justify-center rounded-full bg-emerald-600/10 text-emerald-700 dark:text-emerald-400">
            <CircleCheck className="size-5" />
          </span>
          <div>
            <h2 className="font-medium">@{agent.handle} is in Slack</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Installed {formatDate(agent.slackInstalledAt)}.{" "}
              {listening
                ? "Mention them or send a DM to try it out."
                : "Choose Slack events under Triggers so people can talk to them."}
            </p>
          </div>
        </div>
        <InstallSlackButton agentId={agent.id} reinstall />
      </section>
    );
  }

  return (
    <section className="mt-12 flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-50 via-fuchsia-50/60 to-rose-50/50 px-6 py-6 sm:px-8 dark:border-violet-900/50 dark:from-violet-950/40 dark:via-fuchsia-950/20 dark:to-rose-950/10">
      <div className="flex items-start gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-violet-600/10 text-violet-700 dark:text-violet-300">
          <Hash className="size-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Bring @{agent.handle} into Slack
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Slack will ask you to approve the app&apos;s permissions. Once it&apos;s in, the
            events you choose under Triggers reach them, and they can use the Slack tools
            you allow under Access.
          </p>
        </div>
      </div>
      <InstallSlackButton agentId={agent.id} accent />
    </section>
  );
}

function formatList(items: string[]) {
  const codes = items.map((item) => `\u2018${item}\u2019`);
  if (codes.length <= 1) return codes.join("");
  return `${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]}`;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
