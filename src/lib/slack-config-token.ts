import { db, ensureSchema } from "@/lib/db";
import { SlackApiError, slackPost } from "@/lib/slack";

/**
 * App configuration tokens are what the App Manifest API authenticates with —
 * they are not bot or user tokens, and you can't get one through OAuth. You
 * generate the first pair by hand under "Your App Configuration Tokens" at
 * https://api.slack.com/apps and put the refresh token in
 * SLACK_CONFIG_REFRESH_TOKEN.
 *
 * From then on this module keeps it alive: the access token lasts 12 hours, and
 * every rotation invalidates the refresh token it was made from, so the current
 * pair has to be written back to the database. Losing that write means going
 * back to api.slack.com for a new pair.
 *
 * The pair belongs to the workspace it was generated in, which is also the
 * workspace new apps are created in — so there is a single row, not one per
 * signed-in workspace.
 */
const ROW_ID = "default";

/** Rotate a little early rather than racing the expiry. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

type TokenRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};

export async function getConfigAccessToken(): Promise<string> {
  await ensureSchema();
  const sql = db();

  const rows = (await sql`
    select access_token, refresh_token, expires_at
    from slack_config_tokens
    where id = ${ROW_ID}
    limit 1
  `) as TokenRow[];

  const current = rows[0];
  if (current && !isExpiring(current.expires_at)) {
    return current.access_token;
  }

  const fallback = envRefreshToken();
  const refreshToken = current?.refresh_token ?? fallback;
  if (!refreshToken) {
    throw new Error(
      "No Slack app configuration token. Generate one under \"Your App " +
        "Configuration Tokens\" at https://api.slack.com/apps and set " +
        "SLACK_CONFIG_REFRESH_TOKEN.",
    );
  }

  let rotated;
  try {
    rotated = await rotate(refreshToken);
  } catch (error) {
    // The stored refresh token can go stale — a rotation that failed halfway,
    // or someone regenerating the pair in Slack. If the environment holds a
    // different one, it's the newer of the two, so give it a turn.
    if (fallback && fallback !== refreshToken) {
      rotated = await rotate(fallback);
    } else {
      throw rotationFailed(error);
    }
  }

  await sql`
    insert into slack_config_tokens (id, access_token, refresh_token, expires_at, updated_at)
    values (${ROW_ID}, ${rotated.token}, ${rotated.refreshToken}, ${rotated.expiresAt}, now())
    on conflict (id) do update
      set access_token  = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at    = excluded.expires_at,
          updated_at    = now()
  `;

  return rotated.token;
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

function envRefreshToken() {
  const value = process.env.SLACK_CONFIG_REFRESH_TOKEN;
  if (!value || value === "[sensitive]") return undefined;
  return value;
}

function rotationFailed(error: unknown) {
  if (error instanceof SlackApiError) {
    return new Error(
      `Could not refresh the Slack app configuration token (${error.code}). ` +
        "Generate a new pair at https://api.slack.com/apps and update " +
        "SLACK_CONFIG_REFRESH_TOKEN.",
      { cause: error },
    );
  }
  return error;
}

function isExpiring(expiresAt: string) {
  return new Date(expiresAt).getTime() - EXPIRY_MARGIN_MS <= Date.now();
}
