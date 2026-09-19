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
  /**
   * Whether the agent is allowed to end without saying anything. Set only when
   * it wasn't spoken to — when it was, silence would read as a broken bot.
   */
  mayStaySilent?: boolean;
};

/**
 * What the agent answers with when a message turns out not to be for it.
 *
 * A sentinel rather than an empty answer: a model told to say nothing tends to
 * say something anyway, and an empty string can't be told apart from a run that
 * fell over — which would dress a real failure up as a deliberate silence.
 */
export const NOT_FOR_ME = "NOT_FOR_ME";

/** Whether an answer is the agent declining to say anything. */
export function isSilence(text: string) {
  return text.trim().replace(/^[`*\s]+|[`*.\s]+$/g, "").toUpperCase() === NOT_FOR_ME;
}

/**
 * The system prompt. Assembled from sections rather than one template so that
 * what the person wrote stays whole and recognisable in the middle of it —
 * and so skills, when they arrive, are one more section rather than a rewrite.
 */
export function buildInstructions(input: {
  agent: Agent;
  trigger: TriggerContext;
  tools: Pick<AgentTools, "unreachable">;
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

  if (trigger.mayStaySilent) {
    sections.push(
      [
        "## You were not spoken to",
        "",
        "This message is in a thread you are part of, but it does not name you. It may not be yours to answer.",
        "",
        `Decide that first. If the message isn't for you — people talking among themselves, someone answering someone else, a remark that needs nothing from you — reply with exactly \`${NOT_FOR_ME}\` and nothing else, and call no tools. Nothing is posted and nobody sees that you considered it.`,
        "",
        "Answer only if you are being asked for something, or the thread plainly needs what you know. When it's a close call, stay out: a thread you keep interrupting is worse than one you sat a turn out of.",
      ].join("\n"),
    );
  }

  // Only worth saying when something is off. A list of tools the model can
  // already see in its tool definitions would just be noise.
  const caveats: string[] = [];
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
