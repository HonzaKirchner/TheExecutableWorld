# Coworkers

Create AI coworkers, give them a job, and manage them from one place.

Next.js (App Router) + Tailwind v4 + shadcn/ui, with Slack sign-in via Auth.js. Deploys to Vercel.

## Pages

| Route             | What it is                                        |
| ----------------- | ------------------------------------------------- |
| `/`               | Landing page — a single "Sign in with Slack" button |
| `/app`            | List of the user's agents (empty for now)          |
| `/app/[agentId]`  | Agent detail (empty for now)                       |

Everything under `/app` is gated by [src/proxy.ts](src/proxy.ts); signed-out visitors are sent to `/` with a `callbackUrl`, and signed-in visitors hitting `/` go straight to `/app`.

## Setup

1. Copy the env template and fill it in:

   ```bash
   cp .env.example .env.local
   ```

   | Variable            | Where it comes from                                    |
   | ------------------- | ------------------------------------------------------ |
   | `AUTH_SECRET`       | `npx auth secret`                                       |
   | `AUTH_SLACK_ID`     | Slack app → Basic Information → Client ID               |
   | `AUTH_SLACK_SECRET` | Slack app → Basic Information → Client Secret           |

2. In your [Slack app](https://api.slack.com/apps), under **OAuth & Permissions**:
   - add the **User Token Scopes** `openid`, `email`, `profile`
   - add the redirect URL `https://<your-domain>/api/auth/callback/slack`

   Slack requires **https** for redirect URLs, including in development — use a tunnel
   (ngrok, Cloudflare Tunnel) and set `AUTH_URL` to the tunnel's https origin.

3. Run it:

   ```bash
   npm run dev
   ```

## Deploying to Vercel

Set `AUTH_SECRET`, `AUTH_SLACK_ID` and `AUTH_SLACK_SECRET` as project environment
variables. `AUTH_URL` is detected automatically. Add the production callback URL
(`https://<your-domain>/api/auth/callback/slack`) to the Slack app.

## Layout

```
src/
  auth.ts                       Auth.js config (Slack OIDC provider, JWT sessions)
  proxy.ts                      Route gate for /app/**
  app/
    actions.ts                  signIn / signOut server actions
    page.tsx                    Landing
    app/layout.tsx              Signed-in shell (header + user menu)
    app/page.tsx                Agents list
    app/[agentId]/page.tsx      Agent detail
    api/auth/[...nextauth]/     Auth.js route handlers
  components/                   App components + shadcn/ui primitives
```
