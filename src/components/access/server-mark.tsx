import type { LucideIcon } from "lucide-react";
import { cn } from "cn";

/**
 * A server's initial in a tile — the catalog carries no logos. An icon can
 * stand in for the initial where there's no single server to name.
 */
export function ServerMark({
  name,
  icon: Icon,
  muted,
  className,
}: {
  name: string;
  icon?: LucideIcon;
  muted?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold",
        muted ? "bg-muted text-muted-foreground" : "bg-card",
        className,
      )}
    >
      {Icon ? <Icon className="size-4" /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}
