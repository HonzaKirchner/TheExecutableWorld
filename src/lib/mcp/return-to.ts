import { randomBytes } from "node:crypto";

/**
 * Where a person lands once an MCP connection is authorized: the server's
 * tool page under Access by default, or — when the connection was started
 * from a trigger's card — that trigger's page, with the trigger set up on
 * the way. Only Gmail has a trigger that listens through its connection, so
 * `trigger` means something for that server alone.
 *
 * The choice rides along in the OAuth `state`, the same way Slack installs
 * carry theirs, because the callback is a fresh request with nothing else
 * to remember it by. What happens on landing is in `landing.ts`; this file
 * stays free of that so the OAuth provider can import it.
 */
export type McpReturnTo = "access" | "trigger";

const RETURN_TO_VALUES: readonly McpReturnTo[] = ["access", "trigger"];

export function newMcpState(returnTo: McpReturnTo = "access") {
  return `${randomBytes(24).toString("base64url")}.${returnTo}`;
}

export function mcpReturnTo(state: string): McpReturnTo {
  const suffix = state.slice(state.lastIndexOf(".") + 1);
  return isReturnTo(suffix) ? suffix : "access";
}

export function parseMcpReturnTo(value: unknown): McpReturnTo {
  return isReturnTo(value) ? value : "access";
}

function isReturnTo(value: unknown): value is McpReturnTo {
  return typeof value === "string" && (RETURN_TO_VALUES as readonly string[]).includes(value);
}
