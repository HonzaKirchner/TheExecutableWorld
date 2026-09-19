"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

import { signInWithSlack } from "@/app/actions";
import { SlackIcon } from "@/components/slack-icon";
import { Button } from "@/components/ui/button";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      size="lg"
      disabled={pending}
      className="group h-12 w-full gap-3 rounded-xl px-6 text-base shadow-sm transition-all duration-300 hover:shadow-md active:scale-[0.98] sm:w-auto"
    >
      {pending ? (
        <Loader2 className="size-5 animate-spin" />
      ) : (
        <SlackIcon className="size-5 transition-transform duration-300 group-hover:scale-110" />
      )}
      {pending ? "Redirecting to Slack…" : "Sign in with Slack"}
    </Button>
  );
}

export function SignInWithSlack({ callbackUrl = "/app" }: { callbackUrl?: string }) {
  return (
    <form action={signInWithSlack}>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <SubmitButton />
    </form>
  );
}
