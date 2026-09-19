"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * Shows a one-off toast for something a callback reported through the query
 * string, then drops the query string so a reload doesn't show it again.
 */
export function FlashToast({ message }: { message: string }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    toast(message);
    router.replace(pathname, { scroll: false });
  }, [message, router, pathname]);

  return null;
}
