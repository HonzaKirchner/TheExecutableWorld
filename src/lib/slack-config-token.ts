import { decryptSecret, encryptSecret, isEncrypted } from "@/lib/crypto";
import { db, ensureSchema } from "@/lib/db";
import { SlackApiError, slackPost } from "@/lib/slack";

/**
 * App configuration tokens are what the App Manifest API authenticates with —
 * they are not bot or user tokens, and you can't get one through OAuth. Someone
 * with access to the workspace generates the first pair by hand under "Your App
 * Configuration Tokens" at https://api.slack.com/apps.
 *
 * The pair belongs to the workspace it was generated in, and `apps.manifest.create`
 * takes no team parameter — an app is born wherever its configuration token came
 * from. So the pair is stored per workspace, and a workspace can't create agents
 * until someone has pasted one in. There is no environment fallback: a shared
 * pair would quietly create every workspace's apps in whichever workspace
 * generated it.
 *
 * From then on this module keeps the pair alive: the access token lasts 12 hours,
 * and every rotation invalidates the refresh token it was made from, so the
 * current pair has to be written back to the database. Losing that write means
 * going back to api.slack.com for a new one.
 */

/** Rotate a little early rather than racing the expiry. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

type TokenRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

/**
 * Why a workspace can't reach the Manifest API. Both cases are fixed the same
 * way — paste a fresh pair — so callers can send the person to the same place
 * rather than telling them to read a log.
 */
export class SlackConfigTokenError extends Error {
  readonly reason: "missing" | "stale";

  constructor(reason: "missing" | "stale", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlackConfigTokenError";
    this.reason = reason;
  }
}

const CONFIG_TOKEN_HELP =
  'Generate one under "Your App Configuration Tokens" at https://api.slack.com/apps ' +
  "while signed in to this workspace.";

/** Whether this workspace has a pair on file — not whether it still rotates. */
export async function hasConfigToken(workspaceId: string): Promise<boolean> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select 1 from slack_config_tokens where workspace_id = ${workspaceId} limit 1
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Takes a refresh token someone pasted and makes it this workspace's pair.
 *
 * Rotating straight away both proves the token is real — the alternative is
 * finding out halfway through creating an agent — and is unavoidable anyway:
 * the first rotation is what yields an access token, and it invalidates what
 * was pasted, so the result has to be stored either way.
 */
export async function saveConfigRefreshToken(workspaceId: string, refreshToken: string) {
  await ensureSchema();

  let rotated;
  try {
    rotated = await rotate(refreshToken);
  } catch (error) {
    throw rotationFailed(error, "That token was rejected by Slack");
  }

  await storePair(workspaceId, rotated.token, rotated.refreshToken, rotated.expiresAt);
}

/** Forgets a workspace's pair, so the next agent asks for a new one. */
async function clearConfigToken(workspaceId: string) {
  await ensureSchema();
  const sql = db();
  await sql`delete from slack_config_tokens where workspace_id = ${workspaceId}`;
}

export async function getConfigAccessToken(workspaceId: string): Promise<string> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql`
    select access_token, refresh_token, expires_at
    from slack_config_tokens
    where workspace_id = ${workspaceId}
    limit 1
  `) as TokenRow[];

  const row = rows[0];
  if (!row) {
    throw new SlackConfigTokenError(
      "missing",
      `This workspace has no Slack app configuration token. ${CONFIG_TOKEN_HELP}`,
    );
  }

  // The pair predates encryption if it isn't marked as encrypted. Read it as
  // it is, and write it back encrypted straight away rather than waiting for
  // the next rotation.
  const current = await readPair(workspaceId, row);
  if (!isExpiring(current.expires_at)) {
    return current.access_token;
  }

  let rotated;
  try {
    rotated = await rotate(current.refresh_token);
  } catch (error) {
    // The stored pair is dead — a rotation that failed halfway, or someone
    // regenerating it in Slack. Nothing here can revive it, and keeping it
    // would only fail again, so drop it and ask for a new one.
    await clearConfigToken(workspaceId);
    throw rotationFailed(error, "This workspace's Slack app configuration token expired");
  }

  await storePair(workspaceId, rotated.token, rotated.refreshToken, rotated.expiresAt);

  return rotated.token;
}

async function storePair(
  workspaceId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: string,
) {
  const sql = db();
  await sql`
    insert into slack_config_tokens (workspace_id, access_token, refresh_token, expires_at, updated_at)
    values (${workspaceId}, ${encryptSecret(accessToken)}, ${encryptSecret(refreshToken)}, ${expiresAt}, now())
    on conflict (workspace_id) do update
      set access_token  = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at    = excluded.expires_at,
          updated_at    = now()
  `;
}

async function readPair(workspaceId: string, row: TokenRow): Promise<TokenRow> {
  if (isEncrypted(row.access_token) && isEncrypted(row.refresh_token)) {
    return {
      access_token: decryptSecret(row.access_token),
      refresh_token: decryptSecret(row.refresh_token),
      expires_at: row.expires_at,
    };
  }
  await storePair(workspaceId, row.access_token, row.refresh_token, row.expires_at);
  return row;
}

async function rotate(refreshToken: string) {
  const response = await slackPost<{
    ok: true;
    token: string;
    refresh_token: string;
    exp: number;
  }>("tooling.tokens.rotate", { form: { refresh_token: refreshToken } });

  return {
    token: response.token,
    refreshToken: response.refresh_token,
    // `exp` is seconds since the epoch.
    expiresAt: new Date(response.exp * 1000).toISOString(),
  };
}

function rotationFailed(error: unknown, lead: string) {
  if (error instanceof SlackApiError) {
    return new SlackConfigTokenError(
      "stale",
      `${lead} (${error.code}). ${CONFIG_TOKEN_HELP}`,
      { cause: error },
    );
  }
  return error;
}

function isExpiring(expiresAt: string) {
  return new Date(expiresAt).getTime() - EXPIRY_MARGIN_MS <= Date.now();
}
