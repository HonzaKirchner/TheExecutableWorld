import Link from "next/link";

import { auth } from "@/auth";
import { hasConfigToken } from "@/lib/slack-config-token";
import { UserMenu } from "@/components/user-menu";
import { WorkspaceSetupDialog } from "@/components/workspace-setup-dialog";
import { Toaster } from "@/components/ui/sonner";

export default async function AppLayout({ children }: LayoutProps<"/app">) {
  const session = await auth();
  const workspaceId = session?.slack?.teamId;

  // A workspace can't create agents until someone has pasted its app
  // configuration token, so the first thing a signed-in person sees in a
  // workspace without one is the dialog that asks for it.
  const needsSetup = workspaceId ? !(await hasConfigToken(workspaceId)) : false;

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

      {needsSetup ? <WorkspaceSetupDialog teamName={session?.slack?.teamName} /> : null}

      <Toaster position="bottom-center" />
    </div>
  );
}
