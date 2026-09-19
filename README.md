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
| `/api/mcp/slack`                     | The Slack MCP server this app hosts — tools that act as an agent's own Slack app |
| `/api/slack/install/callback`        | Where Slack sends people back to after installing an agent     |
| `/api/slack/events/[triggerId]`      | Where Slack delivers an agent's events (mentions, DMs)         |
| `/app/[agentId]/triggers/[kind]`     | A trigger's detail: connect (Stripe, once per workspace), choose events |
| `/api/stripe/connect/callback`       | Where Stripe Connect sends people back to                      |
| `/api/stripe/events`                 | The platform's Connect webhook — events from every connected Stripe account |
| `/s/[sessionId]`                     | One run's transcript, live while it runs — readable without signing in |
| `/app/[agentId]/sessions`            | Every run of the agent                                         |
| `/app/[agentId]/sessions/[sessionId]` | One run's transcript, inside the app                          |
| `/api/sessions/[sessionId]/events`   | The transcript feed the live view polls                        |

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
   | `APP_BASE_URL`         | Origin for OAuth redirect URLs (see below)      | optional |
   | `PUBLIC_BASE_URL`      | Internet-reachable origin for Slack event delivery; defaults to the Vercel production URL | locally, to create agents |
   | `DB_CONNECTION_STRING` | Neon → connection string                        | yes      |
   | `ENCRYPTION_KEY`       | `openssl rand -hex 32` — encrypts every secret stored in the database | yes |
   | `STRIPE_SECRET_KEY`    | The Stripe App developer account's secret key (same mode as the install link) | for Stripe triggers |
   | `STRIPE_INSTALL_LINK`  | An install link copied from the Stripe App's External test tab (test mode), used verbatim | for Stripe triggers |
   | `STRIPE_CLIENT_ID`     | Only as a fallback for a published app without `STRIPE_INSTALL_LINK` | optional |
   | `OPENAI_API_KEY`       | platform.openai.com → API keys — without it agents can't answer | to run agents |
   | `GITHUB_MCP_CLIENT_ID` / `GITHUB_MCP_CLIENT_SECRET` | A GitHub App (or OAuth App) with `<base URL>/api/mcp/callback` as its callback URL. GitHub's MCP server doesn't register clients dynamically, so without these the GitHub card can't connect | for GitHub access |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | A Google Cloud OAuth client (web application) in a project with the Gmail API enabled, with `<base URL>/api/mcp/callback` among its redirect URIs | for Gmail access and triggers |
   | `GMAIL_PUBSUB_TOPIC` | A Pub/Sub topic, `projects/<project>/topics/<topic>`, that `gmail-api-push@system.gserviceaccount.com` may publish to | for Gmail triggers |
   | `GMAIL_PUBSUB_TOKEN` | `openssl rand -hex 24` — the topic's push subscription delivers to `<PUBLIC_BASE_URL>/api/gmail/events?token=<this>` | for Gmail triggers |
   | `CRON_SECRET` | `openssl rand -hex 24` — Vercel sends it with the daily cron that renews Gmail watches | for Gmail triggers |

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

Seven tables, created by [src/lib/db.ts](src/lib/db.ts):

| Table                 | Key                       | Notes                                            |
| --------------------- | ------------------------- | ------------------------------------------------ |
| `workspaces`          | Slack team id             | One row per Slack workspace                       |
| `workspace_users`     | Slack user id             | Cascades on workspace delete                      |
| `agents`              | `uuid`                    | `workspace_id`, `handle`, `description`, `instructions`, `model`, plus the Slack app it owns and — once installed — its bot token |
| `mcp_connections`     | `uuid`, unique per (agent, server) | An agent's link to one MCP server: OAuth client, tokens, in-flight `state`/verifier, cached discovery |
| `mcp_tools`           | (connection, tool name)   | The server's tools as last listed, with `allowed` and `requires_approval` |
| `triggers`            | `uuid`, unique per (agent, kind) | What makes an agent act: `config.events`, `status`, for Gmail the mailbox in `account_id`, and the last event seen |
| `stripe_connections`  | Slack team id             | The workspace's Stripe account — one install of the Stripe App shared by all its agents — with the `state` of an install in flight and the agent it started from |
| `stripe_webhook_endpoint` | `'default'`           | The platform's one Connect webhook endpoint at Stripe, with its signing secret |
| `slack_config_tokens` | Slack team id             | That workspace's current app configuration token pair — the workspace its agents' Slack apps are created in |
| `agent_sessions`      | `uuid`                    | One run of an agent: which trigger woke it, a one-line title, `running`/`done`/`failed` |
| `agent_session_events`| (session, `seq`)          | The transcript — `seq` is gap-free per session, so it doubles as the live view's cursor |

### Secrets are encrypted

Everything secret that lands in the database — the Slack client and signing secrets of
generated apps and their bot tokens, the MCP OAuth client/tokens/PKCE verifier, the Stripe
webhook signing secret — goes through
[src/lib/crypto.ts](src/lib/crypto.ts): AES-256-GCM under `ENCRYPTION_KEY`, stored as
`enc:v1:<iv>.<ciphertext>.<tag>`. Reads refuse values without that prefix, so a plaintext
column can't be mistaken for an encrypted one. Losing the key means losing every stored
secret; agents would have to be recreated and servers reconnected. The configuration token
row is the one exception to strictness: a pair from before encryption is read once and
written back encrypted.

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

"New agent" on `/app` opens a dialog asking for a handle, an optional one-line
description, a model and instructions. The handle is the agent's only name: it is the
Slack app's name and the bot's display name, and it heads the agent's page. The
description is the Slack app's description (140 characters); the instructions are what
the agent follows and are shown first on its page. Submitting the dialog runs
`createAgentAction` in [src/app/app/actions.ts](src/app/app/actions.ts), which:

1. re-checks the session (the action is a POST endpoint of its own, reachable without
   the UI);
2. validates the fields against Slack's own limits — 35 characters and `a-z 0-9 . _ -`
   for the handle (the app-name limit, the tighter of the two it has to satisfy), 140 for
   the description; the limits live in [src/lib/agent-limits.ts](src/lib/agent-limits.ts)
   so the form and the action agree;
3. rejects a handle already used in the workspace *before* calling Slack, because app
   creation is rate limited and an orphaned app has to be cleaned up by hand;
4. stores the workspace's app configuration token if the dialog asked for one (below) —
   after the other fields are known good, because saving it spends it;
5. creates a Slack app from a manifest via `apps.manifest.create` — subscribed to no
   events and asking for the base bot scopes only; events and tools are chosen later,
   and each choice updates the manifest (below);
6. stores the agent with the credentials Slack hands back, and redirects to its page.

If the insert fails after the app exists, the app is deleted again so the workspace
doesn't collect orphans.

### App configuration tokens

`apps.manifest.create` doesn't authenticate with a bot or user token, and you can't get
its token through OAuth. Someone generates the pair by hand under **Your App
Configuration Tokens** at [api.slack.com/apps](https://api.slack.com/apps).

**The pair decides which workspace the app is created in.** `apps.manifest.create` takes
no team parameter, so an app is born wherever its configuration token came from. A single
shared pair would create every customer's agents in whichever workspace generated it —
undistributed, and so impossible for that customer to install. So the pair is stored per
workspace in `slack_config_tokens` (one row per Slack team id), and there is no
environment fallback.

A workspace with no pair can't create agents, so the app asks for one as soon as someone
signs in: the `/app` layout checks `hasConfigToken` and, when there is none, opens
[src/components/workspace-setup-dialog.tsx](src/components/workspace-setup-dialog.tsx) —
the steps for generating the pair at api.slack.com, a field for the refresh token, and a
note that this is a stopgap: Slack can grant the same permission over its usual OAuth
flow, but that grant has to be arranged with Slack's support, so the pasted token stands
in until then. "Later" puts the dialog away for the tab (`sessionStorage`), and the
"New agent" dialog then asks for the token before the rest of its form instead; `/app`
passes `needsConfigToken` to
[src/components/new-agent-dialog.tsx](src/components/new-agent-dialog.tsx). Whoever pastes
it must have generated it while signed in to *that* workspace — nothing here can check
that, but a token from elsewhere puts the apps in the wrong place again.

The token is rotated the moment it's pasted: that both proves it is real and is
unavoidable anyway, since the first rotation is what yields an access token and
invalidates what was pasted. From there
[src/lib/slack-config-token.ts](src/lib/slack-config-token.ts) keeps it alive — the access
token lasts 12 hours, and every rotation invalidates the refresh token it came from, so
the current pair is written back. A rotation Slack rejects means the pair is dead: the row
is deleted, and the dialog asks for a new one the next time round. `SlackConfigTokenError`
carries that as a message the forms show directly.

There is no way to replace a workspace's pair while it still rotates — that would want a
settings page, which doesn't exist yet.

## Triggers

The **Triggers** section lists what makes an agent act: **Slack**, **Stripe** and
**Gmail**. None is added unasked — a trigger exists once the person has chosen its
events, and the first save is what creates it. Opening a trigger shows its webhook, the
last event it received, and lets the person choose the events it listens for; the choice
is stored in `triggers.config.events`. Slack differs from the other two only in what
comes before: every agent already has a Slack app, so there is nothing to connect and the
card goes straight to the page.

### Slack

A Slack trigger is the agent's own app's Events API subscription: the trigger's row id is
the last path segment of `/api/slack/events/[triggerId]`, and that URL goes into the app's
manifest as `request_url`. The events on offer, and the bot scope each one needs, are in
[src/lib/slack-events-catalog.ts](src/lib/slack-events-catalog.ts); `app_mention` is
always on once the agent listens at all, and the page preselects `message.im` alongside
it for an agent that hasn't chosen yet. Saving runs `apps.manifest.update` with the new
`bot_events` and the scopes derived from them (plus those of the Slack tools allowed
under Access, below), then stores the choice. The first save creates the trigger — the
row goes in before the manifest, because Slack challenges the URL as soon as it sees it
and the endpoint only answers for a trigger that exists; if Slack then rejects the
manifest the row is deleted again. **Stop listening** takes the subscription out of the
manifest and deletes the trigger; the app stays installed and its tools keep working.

Slack applies new scopes to an *installed* app only when it is installed again, so the
install records the scopes it granted (`agents.slack_bot_scopes`) and the agent's page
turns the install panel amber with a **Reinstall** button while the events and tools
need more than that. [src/lib/slack-access.ts](src/lib/slack-access.ts) is where the
manifest, the install's scopes and the tools meet: it builds the manifest from the
trigger and the allowed tools, and computes the scopes an install has to ask for.

Events are chosen before or after the install, whichever comes first; an install after
the choice asks for exactly what it needs, and the install panel at the bottom of the
agent's page is the one place that talks about installing. Until the app is installed
nothing can wake the agent, so the page shows no sessions section either. The
destination of an install rides inside the OAuth `state` —
`<random>.agent` or `<random>.trigger`, a suffix Slack returns verbatim
([src/lib/slack-install.ts](src/lib/slack-install.ts)) — so the install panel at the
bottom of the agent's page keeps landing on the agent's page. A `state` without a
suffix, from an install started before this existed, resolves to the agent's page too.

**Slack verifies the URL with a challenge when it lands in the manifest**, so the endpoint
must be deployed before an agent can subscribe to events — from local development too. That's what
`PUBLIC_BASE_URL` is for: the production origin, used only for this URL. Everything else
(OAuth redirects) keeps using `APP_BASE_URL` / `AUTH_URL`, which can stay on `localhost`.
Locally you'll subscribe agents whose events go to production; production and local share
the database, so the production endpoint finds them.

The endpoint ([route.ts](src/app/api/slack/events/[triggerId]/route.ts)):

1. looks the trigger up and takes the agent's signing secret;
2. verifies `X-Slack-Signature` over the raw body (HMAC-SHA256, five-minute replay
   window);
3. answers `url_verification` with the challenge;
4. ignores Slack retries (`X-Slack-Retry-Num`) — a retry means the first reply was slow,
   and replying again would double-post;
5. for a person's mention or DM, replies in the thread with the agent's bot token.

Nothing more yet — the reply is a fixed line, and other subscribed events are only noted
on the trigger (`last_event_at`, `last_event_type`).

### Stripe

Stripe accounts connect by **installing a Stripe App** that this deployment owns — one with
`stripe_api_access_type: "oauth"` ([docs](https://docs.stripe.com/stripe-apps/api-authentication/oauth)).
Two facts from Stripe's docs shape the design:

- The install link on `marketplace.stripe.com` comes back with an authorization code; the
  exchange at `/v1/oauth/token` returns the installing account's id (`stripe_user_id`) and
  tokens. The tokens aren't needed — the developer account's key with a `Stripe-Account`
  header acts for an account that installed the app — so nothing per-account is stored
  but the id.
- Events from every account that installed the app are delivered to **one webhook
  endpoint on the developer account** that listens to *connected accounts*
  (`connect=true`), each event carrying the `account` it came from. Stripe only delivers
  events the app holds permissions for, so the app's manifest grants the read permission
  for every object, and the endpoint subscribes to `*`. One installation then serves
  every agent: the account is connected **once per workspace**
  ([src/lib/stripe-connections.ts](src/lib/stripe-connections.ts)), each agent's trigger
  is only its own list of event types, and the events route fans an event out to every
  agent in the account's workspace whose list has its type and drops everything else.
  Adding an agent or changing what one listens to never touches Stripe.

Setting up the app (once, with the Stripe CLI):

1. In `stripe-app.json`: `"stripe_api_access_type": "oauth"`, `"distribution_type": "public"`,
   and `"allowed_redirect_uris"` containing `<APP_BASE_URL>/api/stripe/connect/callback`
   (locally `https://localhost:3003/api/stripe/connect/callback`; add the production one too).
2. Grant `event_read` and the `*_read` permission of every object whose events agents
   may want (the manifest in the sibling `TheExecutableWorldStripeApp` project does).
   Adding permissions later means a new upload, pointing the External test at that
   version, and reinstalling on each account so the new permissions are accepted.
3. `stripe apps upload` **to the main account**, not a sandbox — only there does the app
   get install links. On the app's page, the **External test** tab shows the install links
   per mode; copy the test-mode one whole into `STRIPE_INSTALL_LINK`. While an app is in
   external testing its links carry a channel (`chnlink_…`) that a link built from the
   `client_id` alone lacks, and Stripe rejects the bare form as "invalid OAuth link", so
   the app uses the link as given and only sets `redirect_uri` and `state` on it.
   `STRIPE_SECRET_KEY` is the developer account's key in the same mode (a managed
   sandbox's key for a sandbox link). The public links in **Settings** only work after
   app review; for a published app `STRIPE_CLIENT_ID` alone is enough.

The **Signing secret** shown on the app's page (`absec_…`) is for verifying requests a
Stripe App UI extension sends to a backend; this app has no UI extension, so it isn't used.
Webhook signatures use the endpoint's own `whsec_…` secret, which Stripe returns when the
app creates the endpoint (below).

The flow, in [triggers/actions.ts](src/app/app/[agentId]/triggers/actions.ts):

1. **Connect Stripe**, on any agent's card or trigger page while the workspace has no
   account, writes the workspace's `stripe_connections` row with an OAuth `state` and the
   agent it was started from, and redirects to the install link with `redirect_uri` and
   `state` set. A workspace that is already connected keeps its account until the new
   code is exchanged, so an abandoned reconnect changes nothing.
2. `/api/stripe/connect/callback` resolves the `state`, checks the session's workspace,
   exchanges the code for the account id, marks the workspace connected, and lands the
   person back on the trigger page they left from.
3. The callback also runs `syncStripeEndpoint()`
   ([src/lib/stripe-webhook.ts](src/lib/stripe-webhook.ts)), which the first time creates
   the endpoint via `POST /v1/webhook_endpoints` with `connect=true`,
   `url=<PUBLIC_BASE_URL>/api/stripe/events` and `enabled_events=["*"]`, and stores the
   signing secret Stripe returns only then. Saving events runs it again in case that
   failed. From here on every agent in the workspace picks events without another
   install — a curated catalog in [src/lib/stripe-events.ts](src/lib/stripe-events.ts)
   plus any event type typed in — and the first save creates the agent's trigger, which
   is nothing but that list.
4. `/api/stripe/events` verifies `Stripe-Signature` (HMAC-SHA256 over `t.body`, five-minute
   window), finds every agent whose workspace is connected to `event.account` and whose
   trigger lists `event.type`, records the event on those triggers and runs the agents in
   parallel; events no trigger asked for are acknowledged and dropped.
   `account.application.deauthorized` (sent when the account uninstalls the app) marks
   the workspace's connection `disconnected`, which silences all its agents at once. It
   answers 200 in every case Stripe shouldn't retry.
5. **Stop listening** on a trigger page deletes that agent's trigger only. **Disconnect
   workspace** removes the account from every agent at once and, unless another
   workspace uses the same account, tries `/oauth/deauthorize` — documented for Connect,
   so treated as best effort; uninstalling from the account's Dashboard is the sure way.
   The agents' event lists stay in place, inert, so connecting again resumes them.

As with Slack, the events URL has to be reachable from the internet, so it uses
`PUBLIC_BASE_URL`; Stripe events for agents created locally arrive in production, which
shares the database. Test-mode installs send test events only; a sandbox install sends
events only to an endpoint in that sandbox.

#### Acting on Stripe

The trigger only tells the agent what happened. Acting — refunding a payment, looking up a
customer, cancelling a subscription — is a second grant, to **Stripe's own MCP server**
(`https://mcp.stripe.com`, [docs](https://docs.stripe.com/mcp)), connected under Access like
any other server; the trigger page offers the same button under **Actions** and says whether
the agent may refund. The two grants are separate on purpose: the App install delivers
events to the platform without holding write permissions on anyone's account, while the MCP
grant is the person's own OAuth session with Stripe, scoped to the account (live or sandbox)
they pick on Stripe's consent page and revocable there under **OAuth sessions**. Stripe's
authorization server registers clients dynamically (public client with PKCE), so nothing is
configured for it on the deployment.

Stripe's server exposes no per-object tools. Reads go through `stripe_api_read` and every
write — refunds included — through `stripe_api_write`, with `stripe_api_search` /
`stripe_api_details` for finding the right API method, `get_stripe_account_info`, and
`search_stripe_documentation` alongside. So "may refund" comes down to allowing
`stripe_api_write`, which allows every other write too; the approval flag applies to the
whole tool. Stripe adds a check of its own: a refund (or outbound payment) requested over an
OAuth session is withheld and answered with a link where a person approves it, after which
the agent has to retry with the approval token Stripe issues — the approval lapses after 24
hours. Stripe's OAuth doesn't act on *connected* accounts (for that Stripe wants a platform
restricted key plus a `Stripe-Account` header), so the MCP grant is always for an account
the person can sign into — normally the same one they installed the App into.

### Gmail

A Gmail trigger wakes the agent when mail lands in a mailbox. Gmail has no webhooks of its
own: `users.watch` makes it publish to a **Google Cloud Pub/Sub topic**, and a push
subscription on that topic delivers to this app. The trigger rides on the agent's **Gmail
MCP connection** (below): the tokens Google issued for the tools are the ones the watch
uses, so a Google account is granted once, under Access, and the trigger then needs only
to be started. Granted once *per workspace*, in fact: an agent with no Gmail connection
of its own takes over the grant another agent of the workspace holds — its row gets a
copy of that row's tokens, checked against Google first
([src/lib/gmail/connection.ts](src/lib/gmail/connection.ts)) — so "Connect Gmail" on the
second agent finishes on the spot and its trigger offers **Start listening** right away.
Only a workspace with no grant at all is sent to Google's consent screen.

Setting up Google (once):

1. In a Cloud project, enable the **Gmail API** and create an **OAuth client** of type web
   application with `<APP_BASE_URL>/api/mcp/callback` as a redirect URI (add the production
   origin too). Put its id and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
   Google doesn't register OAuth clients dynamically, which is why the deployment brings
   its own. While the consent screen is in testing, add the Google accounts that will
   connect as test users.
2. Create a **Pub/Sub topic** and grant `gmail-api-push@system.gserviceaccount.com` the
   Pub/Sub Publisher role on it. Its full name goes into `GMAIL_PUBSUB_TOPIC`.
3. Give the topic a **push subscription** whose endpoint is
   `<PUBLIC_BASE_URL>/api/gmail/events?token=<GMAIL_PUBSUB_TOKEN>`. The token is the only
   thing that tells the subscription's requests from anyone else's, so keep it random.
4. Set `CRON_SECRET`; Vercel sends it with the daily cron in `vercel.json` that calls
   `/api/gmail/renew`.

The flow, in [triggers/actions.ts](src/app/app/[agentId]/triggers/actions.ts) and
[src/lib/gmail/watch.ts](src/lib/gmail/watch.ts):

1. **Start listening** (needs the authorized Gmail connection) calls `users.watch` with the
   topic and the labels the events map to — `INBOX` for `message.received`, `STARRED` for
   `message.starred` ([src/lib/gmail-events.ts](src/lib/gmail-events.ts)) — and records
   the mailbox address, the `historyId` to pick up from and the watch's expiry on the
   trigger. Saving a different set of events re-issues the watch; the history position
   carries over so nothing in between is skipped.
2. `/api/gmail/events` checks the token, decodes the notification (`emailAddress`,
   `historyId`), finds the active triggers for that address and, for each, lists the
   mailbox's history since its stored position with `historyTypes=messageAdded,labelAdded`.
   A message added with `INBOX` (and neither `SENT` nor `DRAFT`) is `message.received`;
   a `STARRED` label added is `message.starred`. Each occurrence is recorded on the
   trigger and, for now, only logged — as with the other triggers. The position moves to
   the furthest id seen, never backwards. If Gmail no longer has history that far back
   (404), the position resets to the notification's. Pub/Sub is answered 204 in every
   case it shouldn't retry.
3. Gmail forgets a watch after seven days. The cron renews every watch within three days
   of expiry; a notification arriving in that window renews on the side. A renewal that
   Google refuses (refresh token revoked) marks the trigger `disconnected`.
4. **Stop listening** deletes the trigger and calls `users.stop` — unless another agent
   listens to the same mailbox, since the watch is per mailbox, not per agent.
   Disconnecting the Gmail server under Access stops the trigger first, while the tokens
   still work.

## Running an agent

A trigger answers its webhook first and runs the agent afterwards, in
[`after`](https://nextjs.org/docs/app/api-reference/functions/after): Slack wants a 200
within three seconds and Stripe retries for days, while a run that calls a couple of
tools takes far longer than either allows. Both routes set `maxDuration = 300`, which is
the ceiling the run has to fit inside — Vercel caps it by plan, so a smaller plan cuts a
long run short.

The harness is [src/lib/agent/run.ts](src/lib/agent/run.ts), and it is deliberately dull:
resolve the model, load the tools, hand both to the AI SDK's `generateText` with
`stopWhen: stepCountIs(12)`, close the MCP sessions. It knows nothing about Slack or
Stripe and writes nowhere — a trigger builds the messages, calls it, and decides what to
do with the answer.

### Models and providers

An agent stores a model id (`agents.model`). [src/lib/models.ts](src/lib/models.ts) says
which ids exist and which provider each belongs to;
[src/lib/agent/providers.ts](src/lib/agent/providers.ts) builds a registry over the
providers whose API key is set and resolves the id to a model. Adding a provider is three
steps — install its `@ai-sdk/*` package, add the entry to `PROVIDERS` and its models to
`MODELS`, add the factory — and nothing outside those two files knows a provider exists.
A model whose key is missing fails the run with a message that names the variable, rather
than quietly answering as a different model.

### Tools

The agent's tools are the MCP tools it has been allowed. At the start of a run,
[src/lib/agent/tools.ts](src/lib/agent/tools.ts) opens a session per authorized
connection and lists what the server offers now, then keeps the tools whose `mcp_tools`
row says `allowed`. The split is on purpose: the database holds the person's decisions,
the server holds the argument schemas, and a cached schema that has drifted from the
server's is worse than no cache.

Names are qualified as `serverId__toolName`, because MCP tool names are unique per server
and not across them. Tools marked `requires_approval` are **withheld** — there is nowhere
to ask a person yet — and named in the system prompt as unavailable, so the agent says it
can't do the thing instead of pretending it did. A server that can't be reached is
reported the same way and doesn't fail the run.

### Slack

[src/lib/agent/slack.ts](src/lib/agent/slack.ts) reads the thread with
`conversations.replies` so the agent answers in context, and falls back to the single
delivered message when that call is refused — an agent subscribed only to `app_mention`
was never granted `channels:history`, and asking is cheaper than tracking which of the
four history scopes applies. The agent's own messages become assistant turns, everyone
else's are prefixed with their `<@U…>` so a multi-person thread stays legible. The reply
goes into the thread, and *something* always goes into the thread: a run that fails says
so, because silence is indistinguishable from being ignored.

### Stripe

[src/lib/agent/stripe.ts](src/lib/agent/stripe.ts) runs the agent on the event, with the
event object in the message. There is nowhere to reply — no thread, no person waiting —
so the run is the point and whatever the agent says at the end only reaches the logs.
Giving an agent somewhere to report is a setting that doesn't exist yet.

## Sessions

A session is one run of an agent: a trigger woke it, `runAgent` did some things, it
stopped. Each gets a random uuid, and that uuid is the whole address of its transcript —
`/s/<id>` is outside the gate in [src/proxy.ts](src/proxy.ts) and renders for anyone with
the link, signed in or not. That's the point: you can paste a run at someone with no
account here and show them what the agent did. **Nothing in a transcript is private**, so
only text meant to be read goes into one — no tokens, no raw webhook payloads, no
instructions, and on the Stripe side not even the event object, which can carry a
customer's name and amount. [src/lib/sessions.ts](src/lib/sessions.ts) says so at the
top, and the write helpers (`startSession`, `appendSessionEvent`, `finishSession`) are
the only way in — each one query, since a Slack run starts inside the three-second
webhook budget.

`runAgent` itself stays trigger-agnostic (see above): it takes an optional `onEvent`
callback and reports each tool call and result to it as they happen, without knowing
that sessions exist. [src/lib/agent/slack.ts](src/lib/agent/slack.ts) and
[src/lib/agent/stripe.ts](src/lib/agent/stripe.ts) are the only callers that turn those
into transcript lines — opening a session before the run, wiring `onEvent` to
`appendSessionEvent`, and closing it with the reply (Slack) or a note (Stripe), `done` or
`failed` depending on how the run and, for Slack, the post to the thread went.

Inside the app, runs have pages of their own: `/app/[agentId]/sessions` lists every run
of an agent, newest first, and `/app/[agentId]/sessions/[sessionId]` shows one — the same
transcript as the public link, behind the sign-in gate and scoped to the workspace
(`getAgentSession`), with a **Copy share link** button that hands out the `/s/<id>` URL.
The agent's page shows its latest few with a way to the full list, and every card on the
agents list links straight to that agent's sessions.

### Live

The page server-renders the transcript as it stands, then polls
`/api/sessions/<id>/events?after=<seq>` about once a second while the run is `running`,
slowing down when nothing is happening and giving up after a few quiet minutes — a run
that dies without closing its session shouldn't be polled forever. Polling rather than
SSE: this runs on serverless functions talking to the database over HTTP, where holding a
stream open costs an invocation for the length of the run, and a cursor poll costs one
small query. Without JavaScript the page still shows the transcript, just not the rest of
it.

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

Not every server registers clients dynamically. GitHub's and Google's take a client
registered by hand, named per server in the catalog (`clientEnv`) and read from the
environment; the provider hands it to the SDK in place of a registered one. Servers
outside the catalog are added with the **Custom** card, by URL; they get a generated
`custom-…` id and keep their name on the connection row.

**Stripe** is Stripe's own remote server at `mcp.stripe.com`, connected the standard way —
its authorization server registers clients dynamically and the person picks the account on
Stripe's consent page — so it needs nothing from the environment. It is how an agent acts
on Stripe (refunds first among the reasons); the Stripe *trigger* is a separate grant. See
[Acting on Stripe](#acting-on-stripe) for its tools and how Stripe has refunds approved.

**Gmail** is served by this app itself, at `/api/mcp/gmail`
([src/lib/gmail/mcp-server.ts](src/lib/gmail/mcp-server.ts)). Google's own Gmail MCP
server is drafts-only and behind a preview programme, so this one wraps the Gmail API in
tools that can search and read mail, send and reply, draft, and change labels. It is an
ordinary OAuth resource server whose authorization server is Google: its 401 names
`/api/mcp/gmail/oauth-protected-resource`, which points at `accounts.google.com`, and every
request is checked against Google's `tokeninfo` — the token must have been issued to this
deployment's client with the `gmail.modify` scope. Connecting it from the Access section
is therefore the standard flow, with Google's consent screen in the middle
(`access_type=offline` so a refresh token comes back). Locally, the app connects to itself
over `https://localhost:3003`, whose certificate Node doesn't trust out of the box: set
`NODE_EXTRA_CA_CERTS` to the mkcert root (`$(mkcert -CAROOT)/rootCA.pem`) when running
`npm run dev` to connect Gmail in development.

**Slack** is served by this app as well, at `/api/mcp/slack`
([src/lib/slack-mcp-server.ts](src/lib/slack-mcp-server.ts)), and is the one server with
no OAuth of its own. Every agent's Slack app is installed with a bot token, and the tools
— send a message or DM, list and join channels, read a channel or a thread, find a person,
react — call Slack's Web API with whatever bearer token is on the request, checked with
`auth.test`. **Connect** asks nothing of anyone: the tool list is the catalog in
[src/lib/slack-tools-catalog.ts](src/lib/slack-tools-catalog.ts) — the server registers
exactly those tools, taking their titles, descriptions and annotations from it — so
`ensureSlackConnection` creates the connection row, syncs the catalog into `mcp_tools`
and, if the app is installed, writes the bot token into the row as the token pair. That
is what lets Slack tools (like Slack events) be chosen *before* the app is installed:
each tool needs bot scopes of its own, listed in the catalog, and saving access to the
Slack server updates the manifest first, as saving events does, so the one install asks
for everything at once. After an install the callback writes the new token in; a tool
allowed later means the agent's page asks for a reinstall, and a tool called before that
reinstall answers with Slack's `missing_scope`, turned into a tool error that says so.
The tool page never contacts the server for Slack either — the catalog is the list. The Slack trigger's page carries the same card
under **Actions**, as Stripe's does, since being woken by Slack and acting in it are two
grants.

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
`ENCRYPTION_KEY` as project environment variables. `AUTH_URL` is detected
automatically. App configuration tokens are *not* environment variables — each workspace
pastes its own through the app (above). Add the production callback URL
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
    api/mcp/gmail/              The Gmail MCP server this app hosts
    api/mcp/slack/              The Slack MCP server this app hosts
    api/slack/install/callback/ Slack install callback
    api/slack/events/[triggerId]/ Slack Events API webhook
    api/stripe/events/          Stripe Connect webhook
    s/[sessionId]/page.tsx      A run's transcript, public and live
    api/sessions/[sessionId]/events/ Transcript feed for the live view
  lib/
    db.ts                       Neon client + schema
    base-url.ts                 Origin for redirect URLs
    agents.ts                   Workspace and agent queries
    models.ts                   The models an agent can run on
    slack.ts                    Slack Web API wrapper
    slack-config-token.ts       App configuration token pair per workspace, rotated
    slack-apps.ts               App manifest (scopes, events) -> apps.manifest.create
    slack-install.ts            Install URL + oauth.v2.access
    slack-events.ts             Signature check, event shapes, reply
    slack-events-catalog.ts     Slack events on offer + the scopes they need
    slack-tools-catalog.ts      Slack MCP tools + the scopes they need
    slack-mcp-server.ts         The hosted Slack MCP server (bot-token bearer)
    slack-access.ts             Manifest from trigger + tools; seeds the Slack connection
    triggers.ts                 Trigger catalog + queries
    sessions.ts                  Sessions + transcripts (public by design)
    agent/
      run.ts                    The harness: one model call loop, trigger-agnostic
      providers.ts              Model id -> provider client (the only @ai-sdk/* import)
      prompt.ts                 System prompt assembly
      tools.ts                  MCP tools -> AI SDK tool set, gated by the DB
      slack.ts                  Slack trigger -> run -> reply in thread
      stripe.ts                 Stripe trigger -> run
    mcp/
      catalog.ts                The MCP servers agents can connect to
      connections.ts            Connection + tool queries
      oauth-provider.ts         SDK OAuthClientProvider backed by the database
      client.ts                 Connect, list tools, finish authorization, run sessions
      tools.ts                  Approval suggestion from tool annotations
  components/
    access/                     Access section, connect card, tool form, install panel
    triggers-section.tsx        Triggers section
    sessions/                    Session rows, one run's view, transcript + its polling, share link
    ui/                         shadcn/ui primitives
```
