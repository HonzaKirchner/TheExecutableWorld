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

1. Create `.env.local` with:

   | Variable               | Where it comes from                            | Required |
   | ---------------------- | ---------------------------------------------- | -------- |
   | `AUTH_SECRET`          | `npx auth secret`                               | yes      |
   | `SLACK_CLIENT_ID`      | Slack app → Basic Information → Client ID       | yes      |
   | `SLACK_CLIENT_SECRET`  | Slack app → Basic Information → Client Secret   | yes      |
   | `SLACK_SIGNING_SECRET` | Slack app → Basic Information → Signing Secret  | not yet  |
   | `SLACK_APP_ID`         | Slack app → Basic Information → App ID          | not yet  |

   Auth.js would normally look for `AUTH_SLACK_ID` / `AUTH_SLACK_SECRET`. [src/auth.ts](src/auth.ts)
   passes `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` to the provider explicitly so the
   variables keep Slack's own naming.

   The signing secret and app ID aren't read by any code yet. They're what you'd need to
   verify inbound Slack requests (Events API, slash commands), not to sign in.

2. In your [Slack app](https://api.slack.com/apps), under **OAuth & Permissions**:
   - add the **User Token Scopes** `openid`, `email`, `profile`
   - add the redirect URL `https://<your-domain>/api/auth/callback/slack`

   Slack requires **https** for redirect URLs, including in development — use a tunnel
   (ngrok, Cloudflare Tunnel) and set `AUTH_URL` to the tunnel's https origin.

3. Run it:

   ```bash
   npm run dev
   ```

### Pulling env vars from Vercel

Instead of writing `.env.local` by hand:

```bash
npm run env:pull
```

This pulls the **Production** environment variables into `.env.local`, because that's
the only environment this project defines — the same values back local development.
The first run prompts you to log in and link the project.

Two things to know:

- It **overwrites** `.env.local`. Anything you keep there that isn't also set in Vercel
  Production is lost on every pull — so keep Vercel Production as the source of truth,
  including `AUTH_SECRET`.
- Don't set `AUTH_URL` in Vercel. It's only needed to point local dev at an https
  tunnel, and pulling a production value into `.env.local` would send local sign-in
  redirects to the production domain. Vercel infers the right URL from the request host
  on its own.

The script goes through `npx`, so the Vercel CLI is not a project dependency — it would
otherwise be installed on every production build for no reason.

## Deploying to Vercel

Set `AUTH_SECRET`, `AUTH_SLACK_ID` and `AUTH_SLACK_SECRET` as project environment
variables. `AUTH_URL` is detected automatically. Add the production callback URL
(`https://<your-domain>/api/auth/callback/slack`) to the Slack app.

[vercel.json](vercel.json) pins the framework preset to `nextjs`. This matters when the
Vercel project was imported before the Next.js code existed in the repo: detection ran
against an empty repo, the preset was locked to "Other", and the build then failed with
`No Output Directory named "public" found`. The pin overrides the dashboard preset, so
detection order stops mattering.

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
