"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";

/**
 * The server cards in two groups: the ones always on show, and the rest,
 * which start out cut off half-way — enough to see there's more — behind a
 * button that reveals them. Both groups are grids of `<li>`s.
 *
 * The reveal animates a grid row from `0fr` to `1fr` rather than a
 * `max-height`. A max-height has to be a guess at the tallest the list could
 * get, and the transition runs over that whole guess: opening was over in the
 * first few percent of the duration, and closing did nothing visible until
 * the last few. A fraction track always ends exactly at the content's height,
 * so the whole duration is spent moving. The row's item keeps a `min-height`
 * for the cut-off teaser and `overflow: hidden` so that it can shrink below
 * its content at all.
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
        <div className="mt-3">
          <div className="relative">
            <div
              className="grid transition-[grid-template-rows] duration-300 ease-out"
              style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
            >
              <ul
                // `inert` keeps the cut-off cards out of the tab order and away
                // from screen readers until they're actually shown.
                inert={!open}
                className="grid min-h-14 gap-3 overflow-hidden sm:grid-cols-2"
              >
                {more}
              </ul>
            </div>

            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background via-background/60 to-transparent transition-opacity duration-300",
                open ? "opacity-0" : "opacity-100",
              )}
            />
          </div>

          <div
            className={cn(
              "relative flex justify-center transition-[margin] duration-300 ease-out",
              open ? "mt-4" : "-mt-3",
            )}
          >
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
