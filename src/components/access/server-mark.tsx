import { cn } from "cn";

/** A server's initial in a tile — the catalog carries no logos. */
export function ServerMark({
  name,
  muted,
  className,
}: {
  name: string;
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
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
