/**
 * The origin this app is reachable at — what goes into OAuth redirect URLs,
 * both the ones Slack sends people back to after installing an agent and the
 * one MCP servers send them back to after authorizing.
 *
 * AUTH_URL is already the canonical origin in local development; on Vercel it
 * isn't set (Auth.js infers the origin per request) so fall back to the
 * production domain, which is the one that has to be registered anyway.
 */
export function baseUrl() {
  const explicit = process.env.APP_BASE_URL ?? process.env.AUTH_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;

  return "https://localhost:3003";
}

/**
 * The origin the outside world can reach — where Slack delivers events.
 *
 * Unlike `baseUrl()`, `localhost` is no use here: Slack has to be able to call
 * it. In development this is the production deployment, so local runs get the
 * right URL into the manifest even though they can't receive the events
 * themselves.
 */
export function publicBaseUrl() {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel}`;

  return baseUrl();
}
