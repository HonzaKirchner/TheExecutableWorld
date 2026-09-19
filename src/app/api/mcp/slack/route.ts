import type { NextRequest } from "next/server";

import { handleSlackMcpRequest } from "@/lib/slack-mcp-server";

/**
 * The Slack MCP server this app hosts (see src/lib/slack-mcp-server.ts).
 * Public by design — the bearer token on each request is a Slack bot token,
 * and Slack itself says whether it's good.
 */
export async function GET(request: NextRequest) {
  return handleSlackMcpRequest(request);
}

export async function POST(request: NextRequest) {
  return handleSlackMcpRequest(request);
}

export async function DELETE(request: NextRequest) {
  return handleSlackMcpRequest(request);
}
