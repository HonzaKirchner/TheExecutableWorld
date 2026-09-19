import type { NextRequest } from "next/server";

import { getSession, listSessionEvents } from "@/lib/sessions";

/**
 * What the live transcript polls. Public, like the page it feeds: the session
 * id is the only credential, so this route deliberately has no session check.
 *
 * `?after=<seq>` is the cursor — the highest line the caller already has — so
 * a poll on a quiet session transfers almost nothing.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteContext<"/api/sessions/[sessionId]/events">,
) {
  const { sessionId } = await params;

  const session = await getSession(sessionId);
  if (!session) {
    return Response.json({ error: "Unknown session." }, { status: 404 });
  }

  const after = Number(request.nextUrl.searchParams.get("after") ?? 0);
  const events = await listSessionEvents(
    sessionId,
    Number.isFinite(after) && after > 0 ? Math.floor(after) : 0,
  );

  return Response.json(
    {
      status: session.status,
      endedAt: session.endedAt,
      events,
    },
    // Nothing about a running session may be held anywhere in between.
    { headers: { "cache-control": "no-store" } },
  );
}
