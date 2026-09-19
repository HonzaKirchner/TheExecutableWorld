"use server";

import { signIn, signOut } from "@/auth";

export async function signInWithSlack(formData: FormData) {
  const callbackUrl = (formData.get("callbackUrl") as string) || "/app";
  await signIn("slack", { redirectTo: callbackUrl });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
