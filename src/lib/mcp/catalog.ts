/**
 * The MCP servers an agent can be given access to.
 *
 * All of them speak Streamable HTTP and authorize with OAuth, with the client
 * registering itself dynamically — which is what lets one deployment connect
 * to any of them without someone pre-registering it by hand.
 *
 * `id` is what gets stored, so treat it as permanent. The URL is copied onto
 * the connection at connect time, so changing one here only affects new ones.
 */
export type McpServerDefinition = {
  id: string;
  name: string;
  description: string;
  url: string;
};

export const MCP_SERVERS: readonly McpServerDefinition[] = [
  {
    id: "apify",
    name: "Apify",
    description:
      "Run Actors from Apify Store — scrapers, crawlers and automations — and read their results.",
    url: "https://mcp.apify.com",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and update pages and databases.",
    url: "https://mcp.notion.com/mcp",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects and cycles.",
    url: "https://mcp.linear.app/mcp",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Issues, errors and performance data from your projects.",
    url: "https://mcp.sentry.dev/mcp",
  },
];

export function getMcpServer(id: string) {
  return MCP_SERVERS.find((server) => server.id === id);
}
