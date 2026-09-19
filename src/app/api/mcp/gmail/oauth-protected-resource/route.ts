import { protectedResourceMetadata } from "@/lib/gmail/mcp-server";

/**
 * RFC 9728 metadata for the Gmail MCP server: points clients at Google as
 * the authorization server. The server names this URL in its 401 challenge,
 * so it can live here rather than under /.well-known.
 */
export async function GET() {
  return Response.json(protectedResourceMetadata(), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
