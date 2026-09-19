# Coworkers

Create AI coworkers, give them a job, and manage them from one place.

Next.js (App Router) + Tailwind v4 + shadcn/ui, with Slack sign-in via Auth.js. Deploys to Vercel.

## Pages

| Route                                | What it is                                                    |
| ------------------------------------ | ------------------------------------------------------------- |
| `/`                                  | Landing page — a single "Sign in with Slack" button            |
| `/app`                               | List of the user's agents, and the "New agent" dialog          |
| `/app/[agentId]`                     | Agent detail: instructions, triggers, access, install to Slack |
| `/app/[agentId]/access/[serverId]`   | Which of a server's tools the agent may call                   |
| `/api/mcp/callback`                  | Where MCP authorization servers send people back to            |
| `/api/slack/install/callback`        | Where Slack sends people back to after installing an agent     |
| `/api/slack/events/[triggerId]`      | Where Slack delivers an agent's events (mentions, DMs)         |

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
   | `SLACK_CONFIG_REFRESH_TOKEN` | api.slack.com/apps → Your App Configuration Tokens | to create agents |
   | `APP_BASE_URL`         | Origin for OAuth redirect URLs (see below)      | optional |
   | `PUBLIC_BASE_URL`      | Internet-reachable origin for Slack event delivery; defaults to the Vercel production URL | locally, to create agents |
   | `DB_CONNECTION_STRING` | Neon → connection string                        | yes      |

   Auth.js would normally look for `AUTH_SLACK_ID` / `AUTH_SLACK_SECRET`. [src/auth.ts](src/auth.ts)
   passes `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` to the provider explicitly so the
   variables keep Slack's own naming.

   The signing secret and app ID aren't read by any code yet. They're what you'd need to
   verify inbound Slack requests (Events API, slash commands), not to sign in.

2. In your [Slack app](https://api.slack.com/apps), under **OAuth & Permissions**:
   - add the **User Token Scopes** `openid`, `email`, `profile`
   - add these **Redirect URLs**:
     - `https://<your-domain>/api/auth/callback/slack`
     - `https://localhost:3003/api/auth/callback/slack`

   **Both must be `https`.** Slack's settings form will happily save an
   `http://localhost:...` URL, but the authorize endpoint rejects it at request time with
   `invalid redirect_uri`. This is why `npm run dev` serves https (below).

3. Run it:

   ```bash
   npm run dev
   ```

   The dev server runs on **https://localhost:3003** — `next dev --experimental-https`,
   which generates a self-signed certificate via `mkcert` into `certificates/`
   (gitignored).

   The **first run prompts for your macOS password** so mkcert can add its local CA to
   the system trust store. If that prompt is dismissed or fails, Next prints
   `Failed to generate self-signed certificate. Falling back to http.` and starts on
   **http** — at which point Slack sign-in fails again with `invalid redirect_uri`. If
   you see that, check the startup banner says `https://localhost:3003`, not `http://`.

   `AUTH_URL=https://localhost:3003` lives in `.env.development.local`, which Next loads
   at higher precedence than `.env.local` — so it survives `npm run env:pull` and applies
   only in development.

### Pulling env vars from Vercel

```bash
npm run env:pull
```

This pulls the **Production** environment variables into `.env.local`, because that's
the only environment this project defines — the same values back local development.
The first run prompts you to log in and link the project.

#### Sensitive variables do not come down

Vercel marks Production variables as **Sensitive** by default. Sensitive values can't be
read back out — not in the dashboard, not via the CLI — so `vercel env pull` writes the
literal string `[sensitive]` in their place. Auth.js then sends `[sensitive]` to Slack as
the client secret and Slack replies:

```json
{ "ok": false, "error": "bad_client_secret" }
```

This does **not** affect production: sensitive values are still available to the Vercel
build container and at runtime. It only breaks local development.

The fix is to keep the real secret in `.env.development.local`, which Next loads at higher
precedence than `.env.local` and which `env:pull` never touches:

```ini
# .env.development.local
AUTH_URL=https://localhost:3003
SLACK_CLIENT_SECRET=<real value from Slack -> Basic Information>
```

To check whether a pull gave you placeholders:

```bash
grep -c '\[sensitive\]' .env.local
```

#### Other notes

- `env:pull` **overwrites** `.env.local`. Keep anything local-only in
  `.env.development.local` instead.
- Don't set `AUTH_URL` in Vercel. It's only needed to point local dev at https, and
  pulling a production value would send local sign-in redirects to the production domain.
  Vercel infers the right URL from the request host on its own.
- The script goes through `npx`, so the Vercel CLI is not a project dependency — it would
  otherwise be installed on every production build for no reason.

## Database

Neon Postgres, reached through `@neondatabase/serverless` (HTTP, one round trip per
query — no pooled connection to keep alive on serverless). Connection string comes from
`DB_CONNECTION_STRING`.

Six tables, created by [src/lib/db.ts](src/lib/db.ts):

| Table                 | Key                       | Notes                                            |
| --------------------- | ------------------------- | ------------------------------------------------ |
| `workspaces`          | Slack team id             | One row per Slack workspace                       |
| `workspace_users`     | Slack user id             | Cascades on workspace delete                      |
| `agents`              | `uuid`                    | `workspace_id`, `name`, `handle`, `description`, `model`, plus the Slack app it owns and — once installed — its bot token |
| `mcp_connections`     | `uuid`, unique per (agent, server) | An agent's link to one MCP server: OAuth client, tokens, in-flight `state`/verifier, cached discovery |
| `mcp_tools`           | (connection, tool name)   | The server's tools as last listed, with `allowed` and `requires_approval` |
| `triggers`            | `uuid`, unique per (agent, kind) | What makes an agent act; the id is the webhook path        |
| `slack_config_tokens` | `'default'`               | The current app configuration token pair          |

Agent handles are unique per workspace and case-insensitive (`agents_workspace_handle_idx`),
so two workspaces can both have an `@researcher`.

The schema is created idempotently and memoised per server process, so signing in on a
fresh database just works. To apply it up front — or to check the connection string
before involving Slack:

```bash
npm run db:init
```

### On sign-in

The `signIn` event in [src/auth.ts](src/auth.ts) upserts the workspace and the user from
Slack's OIDC claims (`team_id`, `team_name`, `team_domain`, `user_id`). It runs on every
sign-in, refreshing name/email/avatar and `last_seen_at`. The database module is imported
dynamically there so the driver stays out of the bundle for [src/proxy.ts](src/proxy.ts),
which only needs to know whether a session exists.

### Tenant scoping

Every query is filtered by `workspace_id`, taken from the session rather than the URL.
`getAgent()` takes the workspace as its first argument, so an agent id belonging to
another workspace returns `null` and the page 404s instead of leaking across tenants.

Reads go through a fixed column list that leaves out `slack_client_secret`,
`slack_signing_secret` and `slack_bot_token`, so nothing that reaches a page — or a
Server Action's return value, which is serialised to the client — can carry them by
accident. `mcp_connections` works the same way: `McpConnection` never includes the OAuth
material, which is read only by the OAuth client through `loadCredentials`.

## Creating an agent

"New agent" on `/app` opens a dialog asking for a name, a Slack handle, a model and
instructions (stored as `description`, shown first on the agent's page). Submitting it runs `createAgentAction` in
[src/app/app/actions.ts](src/app/app/actions.ts), which:

1. re-checks the session (the action is a POST endpoint of its own, reachable without
   the UI);
2. validates the fields against Slack's own limits — 35 characters for the app name, and
   `a-z 0-9 . _ -` for the bot display name;
3. rejects a handle already used in the workspace *before* calling Slack, because app
   creation is rate limited and an orphaned app has to be cleaned up by hand;
4. creates a Slack app from a manifest via `apps.manifest.create` — with event
   subscriptions pointing at the agent's webhook (below);
5. stores the agent and its Slack trigger with the credentials Slack hands back, and
   redirects to its page.

If the insert fails after the app exists, the app is deleted again so the workspace
doesn't collect orphans.

### App configuration tokens

`apps.manifest.create` doesn't authenticate with a bot or user token, and you can't get
its token through OAuth. Generate the first pair by hand under **Your App Configuration
Tokens** at [api.slack.com/apps](https://api.slack.com/apps) and put the refresh token in
`SLACK_CONFIG_REFRESH_TOKEN`.

From there [src/lib/slack-config-token.ts](src/lib/slack-config-token.ts) keeps it alive:
the access token lasts 12 hours, and every rotation invalidates the refresh token it came
from — so the current pair is written back to `slack_config_tokens`. If that row is ever
lost you have to generate a new pair by hand. When the stored refresh token is rejected
and `SLACK_CONFIG_REFRESH_TOKEN` holds a different one, the environment value is tried as
a fallback.

The pair belongs to the workspace it was generated in, which is also the workspace new
apps are created in — so there's one row, not one per signed-in workspace.

> The Slack client and signing secrets of generated apps, their bot tokens, and the
> OAuth tokens for MCP servers are all stored in plain text (`agents`,
> `mcp_connections`). Encrypting them is worth doing before this holds anyone else's
> workspaces.

## Triggers

The **Triggers** section lists what makes an agent act. One kind works so far, **Slack**,
and every agent gets it automatically; **Stripe** is listed faded as a placeholder. A trigger is a webhook: its row id is the last
path segment of `/api/slack/events/[triggerId]`, and that URL goes into the Slack app's
manifest as the Events API `request_url`, subscribed to `app_mention` and `message.im`.

The id has to be known before the app is created (the manifest carries the URL), so the
action generates it up front and inserts the trigger right after the agent.

**Slack verifies the URL with a challenge when the manifest is created**, so the endpoint
must be deployed before agents can be created — from local development too. That's what
`PUBLIC_BASE_URL` is for: the production origin, used only for this URL. Everything else
(OAuth redirects) keeps using `APP_BASE_URL` / `AUTH_URL`, which can stay on `localhost`.
Locally you'll create agents whose events go to production; production and local share
the database, so the production endpoint finds them.

The endpoint ([route.ts](src/app/api/slack/events/[triggerId]/route.ts)):

1. looks the trigger up and takes the agent's signing secret;
2. verifies `X-Slack-Signature` over the raw body (HMAC-SHA256, five-minute replay
   window);
3. answers `url_verification` with the challenge;
4. ignores Slack retries (`X-Slack-Retry-Num`) — a retry means the first reply was slow,
   and replying again would double-post;
5. for a person's mention or DM, replies in the thread with the agent's bot token.

Nothing more yet — the reply is a fixed line. Agents created before triggers existed have
a trigger row (backfilled by the schema) but their Slack apps have no event subscription;
recreate them.

## Giving an agent access

The **Access** section on an agent's page lists the MCP servers in
[src/lib/mcp/catalog.ts](src/lib/mcp/catalog.ts). Each is a remote server speaking
Streamable HTTP and authorizing with OAuth. Connecting one:

1. **Connect** runs `connectMcpServerAction`, which creates the `mcp_connections` row and
   tries to connect. The server answers 401, the MCP SDK discovers its authorization
   server, registers this app as an OAuth client (dynamic registration, public client
   with PKCE), and asks to redirect. The action does the redirect.
2. The person authorizes on the server's side and lands on `/api/mcp/callback` with a
   `code` and the `state` that was stored on the connection. The route checks the session
   belongs to the connection's workspace, exchanges the code, lists the server's tools
   and sends them on to the tool page.
3. `/app/[agentId]/access/[serverId]` shows every tool the server offers. Each one has
   **allowed** (off by default — the person picks) and **needs approval** (on unless the
   server declares the tool `readOnlyHint: true`; both are theirs to change). The list is
   refreshed from the server on every visit, keeping the decisions already made.
4. **Save access** stores the decisions and returns to the agent's page.

Everything the OAuth client needs later — registered client, token pair, PKCE verifier,
discovered endpoints — lives on the connection row, because the next request may run on
a different serverless instance. [src/lib/mcp/oauth-provider.ts](src/lib/mcp/oauth-provider.ts)
is the SDK's `OAuthClientProvider` backed by that row; it captures the authorization URL
instead of redirecting, and the caller redirects. Expired tokens are refreshed by the SDK
on the next connection; if that fails too, the person is sent back through authorization.

Redirect URLs are built from `APP_BASE_URL`, falling back to `AUTH_URL` locally and
`VERCEL_PROJECT_PRODUCTION_URL` on Vercel. Every generated Slack app has
`/api/slack/install/callback` on that origin in its manifest, so changing the origin means
regenerating the apps.

## Installing to Slack

**Install to Slack** — the panel at the bottom of the agent's page — stores a random
`state` on the agent and redirects to Slack's OAuth authorize URL with the
agent's own `client_id`, the bot scopes from the manifest, and `team` set to the
workspace. `/api/slack/install/callback` resolves the `state` back to the agent, checks
the session is from the same workspace, exchanges the code with `oauth.v2.access` using
the agent's client secret, and records the bot token and `slack_installed_at`.

Slack lets people pick a different workspace on the authorize page despite `team`. If the
token comes back for another one, it's revoked again (`auth.revoke`) and the page says so —
an agent belongs to exactly one workspace.

The callbacks report back through short codes in the query string (`?installed=1`,
`?error=slack_denied`, …), which the agent page maps to messages — failures as a banner,
cancellations as a passing toast. Nothing from the URL is rendered as-is.

## Deploying to Vercel

Set `AUTH_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `DB_CONNECTION_STRING` and
`SLACK_CONFIG_REFRESH_TOKEN` as project environment variables. `AUTH_URL` is detected
automatically. Add the production callback URL
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
    app/actions.ts              createAgent server action
    app/page.tsx                Agents list
    app/[agentId]/page.tsx      Agent detail + Access section
    app/[agentId]/access/
      actions.ts                connect / save tool access / install server actions
      [serverId]/page.tsx       Tool picker for one MCP server
    api/auth/[...nextauth]/     Auth.js route handlers
    api/mcp/callback/           MCP OAuth callback
    api/slack/install/callback/ Slack install callback
    api/slack/events/[triggerId]/ Slack Events API webhook
  lib/
    db.ts                       Neon client + schema
    base-url.ts                 Origin for redirect URLs
    agents.ts                   Workspace and agent queries
    models.ts                   The models an agent can run on
    slack.ts                    Slack Web API wrapper
    slack-config-token.ts       App configuration token rotation
    slack-apps.ts               App manifest (scopes, events) -> apps.manifest.create
    slack-install.ts            Install URL + oauth.v2.access
    slack-events.ts             Signature check, event shapes, reply
    triggers.ts                 Trigger catalog + queries
    mcp/
      catalog.ts                The MCP servers agents can connect to
      connections.ts            Connection + tool queries
      oauth-provider.ts         SDK OAuthClientProvider backed by the database
      client.ts                 Connect, list tools, finish authorization
      tools.ts                  Approval suggestion from tool annotations
  components/
    access/                     Access section, connect card, tool form, install panel
    triggers-section.tsx        Triggers section
    ui/                         shadcn/ui primitives
```
