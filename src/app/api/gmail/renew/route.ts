import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { renewDueWatches } from "@/lib/gmail/watch";

/**
 * Renews Gmail watches before they lapse. Called daily by the cron in
 * vercel.json, which Vercel authenticates with `CRON_SECRET`. Notifications
 * renew on the side too, so a quiet mailbox is the only one that depends on
 * this.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return new Response("CRON_SECRET is not set; renewal is disabled.", { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  if (!equal(header, `Bearer ${secret}`)) {
    return new Response("Unauthorized.", { status: 401 });
  }

  const results = await renewDueWatches();
  return Response.json({ renewed: results });
}

function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
