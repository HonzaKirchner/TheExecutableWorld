import { dynamicTool, jsonSchema, type JSONSchema7, type ToolSet } from "ai";

import { openMcpSession, type McpSession } from "@/lib/mcp/client";
import { listConnections, listTools } from "@/lib/mcp/connections";
import { getMcpServer } from "@/lib/mcp/catalog";

/**
 * A tool name the model sees. MCP tool names are unique per server, not
 * across servers, so they are prefixed — and the prefix is also how a call
 * finds its way back to the right session.
 *
 * Both halves are already restricted to the character class providers accept
 * for tool names (server ids come from the catalog, tool names from MCP's own
 * naming rules), so the join needs no escaping beyond the separator.
 */
const SEPARATOR = "__";

function qualify(serverId: string, toolName: string) {
  return `${serverId}${SEPARATOR}${toolName}`;
}

export type AgentTools = {
  /** What to hand `generateText`. Empty when the agent has no tools. */
  toolSet: ToolSet;
  /**
   * Tools the agent is allowed to use but that a person has to approve first.
   * There is nowhere to ask yet, so they are withheld and named in the prompt
   * — the agent should say it can't do the thing rather than pretend it can.
   */
  withheld: { name: string; serverName: string }[];
  /** Servers that could not be reached. The run goes ahead without them. */
  unreachable: { serverName: string; error: string }[];
  /** Must be called when the run is over, successful or not. */
  close: () => Promise<void>;
};

const NO_TOOLS: AgentTools = {
  toolSet: {},
  withheld: [],
  unreachable: [],
  close: async () => {},
};

/**
 * Builds the agent's tool set from its authorized MCP connections.
 *
 * Tools are listed from the servers rather than read from `mcp_tools`: the
 * cached rows carry the person's decisions, not the argument schemas, and a
 * schema is only trustworthy if it came from the server this run is calling.
 * So the database decides *whether* a tool may be used and the server decides
 * *what it looks like*.
 */
export async function loadAgentTools(agentId: string): Promise<AgentTools> {
  const connections = (await listConnections(agentId)).filter(
    (connection) => connection.status === "authorized" && connection.allowedCount > 0,
  );
  if (connections.length === 0) return NO_TOOLS;

  const sessions: McpSession[] = [];
  const toolSet: ToolSet = {};
  const withheld: AgentTools["withheld"] = [];
  const unreachable: AgentTools["unreachable"] = [];

  const close = async () => {
    await Promise.all(sessions.map((session) => session.close()));
  };

  try {
    await Promise.all(
      connections.map(async (connection) => {
        const serverName = getMcpServer(connection.serverId)?.name ?? connection.serverId;

        // The person's decisions, by tool name.
        const decisions = new Map(
          (await listTools(connection.id)).map((tool) => [tool.name, tool]),
        );

        let session: McpSession;
        let offered;
        try {
          session = await openMcpSession(connection);
          sessions.push(session);
          offered = await session.listTools();
        } catch (error) {
          unreachable.push({ serverName, error: describe(error) });
          return;
        }

        for (const tool of offered) {
          const decision = decisions.get(tool.name);
          if (!decision?.allowed) continue;
          if (decision.requiresApproval) {
            withheld.push({ name: tool.name, serverName });
            continue;
          }

          toolSet[qualify(connection.serverId, tool.name)] = dynamicTool({
            description: toolDescription(serverName, tool.title, tool.description),
            inputSchema: jsonSchema(tool.inputSchema ?? EMPTY_SCHEMA),
            // Identifies where the tool came from without telling the model.
            metadata: { serverId: connection.serverId, toolName: tool.name },
            execute: async (args) => {
              const result = await session.callTool(tool.name, args);
              return result;
            },
          });
        }
      }),
    );
  } catch (error) {
    await close();
    throw error;
  }

  return { toolSet, withheld, unreachable, close };
}

/** For a server that declares no arguments — MCP allows it, providers don't. */
const EMPTY_SCHEMA: JSONSchema7 = { type: "object", properties: {} };

/**
 * The server's name goes in the description so the model can tell two
 * similarly named tools apart, and so it can say where an answer came from.
 */
function toolDescription(
  serverName: string,
  title: string | undefined,
  description: string | undefined,
) {
  const lead = description ?? title ?? "No description given.";
  return `[${serverName}] ${lead}`;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
