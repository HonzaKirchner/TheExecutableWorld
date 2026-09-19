import type { Agent } from "@/lib/agents";
import type { AgentTools } from "@/lib/agent/tools";

/**
 * Describes what woke the agent up. The harness doesn't care which trigger it
 * was — it only puts this in the prompt — so a new trigger kind needs no
 * change here.
 */
export type TriggerContext = {
  /** One line, e.g. "a Slack message in #support". */
  description: string;
  /** Anything else worth stating as fact, one item per line. */
  facts?: string[];
};

/**
 * The system prompt. Assembled from sections rather than one template so that
 * what the person wrote stays whole and recognisable in the middle of it —
 * and so skills, when they arrive, are one more section rather than a rewrite.
 */
export function buildInstructions(input: {
  agent: Agent;
  trigger: TriggerContext;
  tools: Pick<AgentTools, "withheld" | "unreachable">;
}): string {
  const { agent, trigger, tools } = input;
  const sections: string[] = [];

  sections.push(
    [
      `You are @${agent.handle}, an AI coworker.`,
      agent.description ? `Your job, in one line: ${agent.description}` : null,
      "You work alongside people, so answer as a colleague would: plainly, and only about what you actually know or did.",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  if (agent.instructions?.trim()) {
    sections.push(
      ["## Your instructions", "", agent.instructions.trim()].join("\n"),
    );
  }

  sections.push(
    ["## What's happening", "", `You were woken by ${trigger.description}.`]
      .concat(trigger.facts?.length ? ["", ...trigger.facts.map((f) => `- ${f}`)] : [])
      .join("\n"),
  );

  // Only worth saying when something is off. A list of tools the model can
  // already see in its tool definitions would just be noise.
  const caveats: string[] = [];
  for (const tool of tools.withheld) {
    caveats.push(
      `\`${tool.name}\` (${tool.serverName}) needs a person's approval before it can run, and there is no way to ask yet — treat it as unavailable.`,
    );
  }
  for (const server of tools.unreachable) {
    caveats.push(`${server.serverName} could not be reached (${server.error}).`);
  }
  if (caveats.length > 0) {
    sections.push(
      [
        "## Tools you do not have right now",
        "",
        ...caveats.map((caveat) => `- ${caveat}`),
        "",
        "If one of these is what the task needs, say so instead of guessing at the answer or claiming you did it.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
