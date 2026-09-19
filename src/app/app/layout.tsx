import Link from "next/link";

import { auth } from "@/auth";
import { UserMenu } from "@/components/user-menu";

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const session = await auth();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-4 px-6">
          <Link
            href="/app"
            className="flex items-center gap-2.5 transition-opacity hover:opacity-70"
          >
            <span className="flex size-7 items-center justify-center rounded-lg border bg-card">
              <span className="font-mono text-xs font-semibold tracking-tighter">ai</span>
            </span>
            <span className="text-sm font-medium">Coworkers</span>
          </Link>

          <UserMenu
            name={session?.user?.name}
            email={session?.user?.email}
            image={session?.user?.image}
            teamName={session?.slack?.teamName}
          />
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>
    </div>
  );
}
