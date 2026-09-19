import type { NextRequest } from "next/server";

import { verifyPubSubToken } from "@/lib/gmail/google";
import { processNotification, type GmailNotification } from "@/lib/gmail/watch";

/**
 * Where the Pub/Sub push subscription delivers Gmail's notifications. The
 * subscription's endpoint URL carries `?token=<GMAIL_PUBSUB_TOKEN>`, which is
 * what tells our subscription's requests from anyone else's.
 *
 * Pub/Sub wants a 2xx within its ack deadline and retries otherwise, so the
 * work is done here but failures are logged rather than reported back — a
 * retry wouldn't help with a mailbox whose tokens have died.
 */
export async function POST(request: NextRequest) {
  if (!verifyPubSubToken(request.nextUrl.searchParams.get("token"))) {
    return new Response("Unknown subscription.", { status: 401 });
  }

  let envelope: { message?: { data?: string; messageId?: string } };
  try {
    envelope = await request.json();
  } catch {
    return new Response("Malformed body.", { status: 400 });
  }

  const notification = decode(envelope.message?.data);
  if (!notification) {
    // Not a Gmail notification; acknowledge so Pub/Sub doesn't keep sending it.
    return new Response(null, { status: 204 });
  }

  try {
    const count = await processNotification(notification);
    if (count > 0) {
      console.log(
        `Gmail notification ${envelope.message?.messageId ?? "?"} for ${notification.emailAddress}: ${count} trigger(s)`,
      );
    }
  } catch (error) {
    console.error("Processing a Gmail notification failed", error);
  }
  return new Response(null, { status: 204 });
}

/** `message.data` is base64 JSON: `{ "emailAddress": "…", "historyId": 123 }`. */
function decode(data: string | undefined): GmailNotification | null {
  if (!data) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as {
      emailAddress?: unknown;
      historyId?: unknown;
    };
    if (typeof payload.emailAddress !== "string") return null;
    const historyId =
      typeof payload.historyId === "number" || typeof payload.historyId === "string"
        ? String(payload.historyId)
        : null;
    if (!historyId || !/^\d+$/.test(historyId)) return null;
    return { emailAddress: payload.emailAddress, historyId };
  } catch {
    return null;
  }
}
