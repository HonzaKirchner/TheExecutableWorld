"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

/**
 * The server cards in two groups: the ones always on show, and the rest,
 * which start out cut off half-way — enough to see there's more — behind a
 * button that reveals them. Both groups are grids of `<li>`s.
 */
export function CollapsibleServers({
  children,
  more,
  moreCount,
}: {
  children: React.ReactNode;
  more: React.ReactNode;
  moreCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2">{children}</ul>

      {moreCount > 0 ? (
        <div className="relative mt-3">
          <ul
            // `inert` keeps the cut-off cards out of the tab order and away
            // from screen readers until they're actually shown.
            inert={!open}
            className={cn(
              "grid gap-3 overflow-hidden transition-[max-height] duration-500 ease-out sm:grid-cols-2",
              open ? "max-h-[200rem]" : "max-h-14",
            )}
          >
            {more}
          </ul>

          {open ? null : (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background via-background/60 to-transparent"
            />
          )}

          <div className={cn("flex justify-center", open ? "mt-4" : "absolute inset-x-0 -bottom-3")}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="gap-1.5 bg-background shadow-sm"
            >
              {open ? (
                <>
                  <ChevronUp className="size-3.5" />
                  Show less
                </>
              ) : (
                <>
                  <ChevronDown className="size-3.5" />
                  Show {moreCount} more
                </>
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
