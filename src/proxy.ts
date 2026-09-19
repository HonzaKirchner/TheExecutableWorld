import { auth } from "@/auth";

// Gate everything under /app behind a Slack session.
export default auth((req) => {
  if (!req.auth) {
    const signInUrl = new URL("/", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return Response.redirect(signInUrl);
  }
});

export const config = {
  matcher: ["/app/:path*"],
};
