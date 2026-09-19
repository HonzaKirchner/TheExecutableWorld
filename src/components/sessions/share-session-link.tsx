"use client";

import { useState } from "react";
import { Check, Link2 } from "lucide-react";

import { sessionPath } from "@/lib/sessions";
import { Button } from "@/components/ui/button";

/**
 * Copies the public link to a run — the one page outside the sign-in gate,
 * so it can go to whoever asked what the agent did. Falls back to opening
 * the link where the clipboard isn't available.
 */
export function ShareSessionLink({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);
  const path = sessionPath(sessionId);

  async function copy() {
    const url = new URL(path, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.open(url, "_blank", "noreferrer");
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} className="gap-1.5">
      {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
      {copied ? "Link copied" : "Copy share link"}
    </Button>
  );
}
