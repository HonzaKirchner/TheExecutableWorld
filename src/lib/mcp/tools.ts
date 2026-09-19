import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Whether a tool should need a human's go-ahead before the agent calls it,
 * going by what the server says about it. Only a starting point — the person
 * configuring the agent gets the final say.
 *
 * Anything not declared read-only is treated as needing approval. That
 * includes tools with no annotations at all: a server that says nothing
 * about a tool has given us no reason to trust it.
 */
export function suggestApproval(annotations: ToolAnnotations | null | undefined) {
  return annotations?.readOnlyHint !== true;
}

export type ToolTrait = "read-only" | "destructive" | "open-world";

/** The annotations worth showing next to a tool, as short labels. */
export function toolTraits(annotations: ToolAnnotations | null | undefined): ToolTrait[] {
  if (!annotations) return [];
  const traits: ToolTrait[] = [];
  if (annotations.readOnlyHint === true) traits.push("read-only");
  // destructiveHint defaults to true for tools that aren't read-only, so an
  // absent value on a writing tool still counts.
  else if (annotations.destructiveHint !== false) traits.push("destructive");
  if (annotations.openWorldHint === true) traits.push("open-world");
  return traits;
}
