import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { SignInWithSlack } from "@/components/sign-in-with-slack";

export default async function LandingPage({ searchParams }: PageProps<"/">) {
  const session = await auth();
  if (session) redirect("/app");

  const { callbackUrl } = await searchParams;
  const target = typeof callbackUrl === "string" ? callbackUrl : "/app";

  return (
    <main className="relative flex flex-1 items-center justify-center overflow-hidden px-6">
      {/* Soft backdrop: a faint grid fading out behind the content. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_45%,black,transparent)]"
      >
        <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-60" />
      </div>

      <div className="relative flex w-full max-w-md flex-col items-center text-center">
        <div className="animate-in fade-in zoom-in-95 duration-700">
          <div className="flex size-12 items-center justify-center rounded-2xl border bg-card shadow-sm">
            <span className="font-mono text-lg font-semibold tracking-tighter">ai</span>
          </div>
        </div>

        <h1 className="mt-8 animate-in fade-in slide-in-from-bottom-2 text-balance text-4xl font-semibold tracking-tight duration-700 sm:text-5xl">
          AI coworkers
        </h1>

        <p className="mt-4 max-w-sm animate-in fade-in slide-in-from-bottom-2 text-balance text-base text-muted-foreground duration-700 [animation-delay:120ms] [animation-fill-mode:backwards]">
          Create them, give them a job, manage them. All from one place.
        </p>

        <div className="mt-10 w-full animate-in fade-in slide-in-from-bottom-2 duration-700 [animation-delay:240ms] [animation-fill-mode:backwards] sm:w-auto">
          <SignInWithSlack callbackUrl={target} />
        </div>

        <p className="mt-6 animate-in fade-in text-xs text-muted-foreground duration-700 [animation-delay:400ms] [animation-fill-mode:backwards]">
          We only use Slack to identify you and your workspace.
        </p>
      </div>
    </main>
  );
}
