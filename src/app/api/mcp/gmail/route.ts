import type { NextRequest } from "next/server";

import { handleGmailMcpRequest } from "@/lib/gmail/mcp-server";

/**
 * The Gmail MCP server this app hosts (see src/lib/gmail/mcp-server.ts).
 * Public by design — it's an OAuth resource server, and the bearer token on
 * each request is what says who's asking.
 */
export async function GET(request: NextRequest) {
  return handleGmailMcpRequest(request);
}

export async function POST(request: NextRequest) {
  return handleGmailMcpRequest(request);
}

export async function DELETE(request: NextRequest) {
  return handleGmailMcpRequest(request);
}
