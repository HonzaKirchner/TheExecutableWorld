import { auth } from "@/auth";
import { baseUrl } from "@/lib/base-url";

// Gate everything under /app behind a Slack session.
export default auth((req) => {
  if (!req.auth) {
    const signInUrl = new URL("/", baseUrl());
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return Response.redirect(signInUrl);
  }
});

export const config = {
  matcher: ["/app/:path*"],
};
