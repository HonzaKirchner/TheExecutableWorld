import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Badge } from "@/components/ui/badge";

export default async function AgentDetailPage({
  params,
}: PageProps<"/app/[agentId]">) {
  const { agentId } = await params;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 duration-500">
      <Link
        href="/app"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Agents
      </Link>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Agent</h1>
        <Badge variant="secondary" className="font-mono text-xs">
          {agentId}
        </Badge>
      </div>

      <div className="mt-8 rounded-xl border border-dashed px-6 py-20 text-center text-sm text-muted-foreground transition-colors hover:border-border/80 hover:bg-muted/30">
        Nothing here yet.
      </div>
    </div>
  );
}
