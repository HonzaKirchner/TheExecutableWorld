import { SlackApiError, slackPost } from "@/lib/slack";

/**
 * App configuration tokens are what the App Manifest API authenticates with —
 * they are not bot or user tokens, and you can't get one through OAuth. You
 * generate a pair by hand under "Your App Configuration Tokens" at
 * https://api.slack.com/apps and put it in the environment:
 *
 *   SLACK_CONFIG_ACCESS_TOKEN   xoxe.xoxp-1-…   good for 12 hours
 *   SLACK_CONFIG_REFRESH_TOKEN  xoxe-1-…        swaps for a fresh pair
 *
 * Nothing is persisted. The pair lives in the environment and, once rotated,
 * in this module's memory for the life of the process. Slack invalidates a
 * refresh token the moment it is used, so after the first rotation the
 * environment holds a dead refresh token: a new process gets by on the access
 * token while that is still valid, and once it isn't, `apps.manifest.*` fails
 * until a fresh pair is generated and both variables are updated.
 *
 * The pair belongs to the workspace it was generated in, which is also the
 * workspace new apps are created in.
 */

type Pair = {
  accessToken: string | undefined;
  refreshToken: string | undefined;
  /** Epoch milliseconds; unknown for the pair read from the environment. */
  expiresAt?: number;
};

/** Rotate a little early rather than racing the expiry. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Slack's answers when the access token is no longer any good. */
const REJECTED_TOKEN = new Set(["invalid_auth", "token_expired", "token_revoked", "not_authed"]);

let current: Pair | undefined;
/** In-flight rotation, so concurrent callers share one rather than racing. */
let rotating: Promise<Pair> | undefined;

/**
 * Runs `call` with a usable configuration access token. The environment's
 * access token comes with no expiry, so the first sign it has expired is Slack
 * rejecting it — in that case the pair is rotated and the call made once more.
 */
export async function withConfigToken<T>(call: (token: string) => Promise<T>): Promise<T> {
  const pair = currentPair();

  if (pair.accessToken && !isExpiring(pair)) {
    try {
      return await call(pair.accessToken);
    } catch (error) {
      if (!isRejectedToken(error)) throw error;
    }
  }

  const fresh = await rotate(pair);
  return call(fresh.accessToken as string);
}

function currentPair(): Pair {
  if (!current) {
    current = {
      accessToken: env("SLACK_CONFIG_ACCESS_TOKEN"),
      refreshToken: env("SLACK_CONFIG_REFRESH_TOKEN"),
    };
    if (!current.accessToken && !current.refreshToken) {
      throw new Error(
        "No Slack app configuration token. Generate a pair under \"Your App " +
          "Configuration Tokens\" at https://api.slack.com/apps and set " +
          "SLACK_CONFIG_ACCESS_TOKEN and SLACK_CONFIG_REFRESH_TOKEN.",
      );
    }
  }
  return current;
}

function rotate(pair: Pair): Promise<Pair> {
  // A rotation already under way was started from the same pair; its result
  // is the one everybody wants.
  if (rotating) return rotating;

  rotating = (async () => {
    const refreshToken = pair.refreshToken;
    if (!refreshToken) {
      throw new Error(
        "The Slack app configuration access token was rejected and there is " +
          "no SLACK_CONFIG_REFRESH_TOKEN to rotate it with. Generate a new pair " +
          "at https://api.slack.com/apps and update both variables.",
      );
    }

    let rotated;
    try {
      rotated = await rotate_(refreshToken);
    } catch (error) {
      // The pair in memory can go stale — a rotation that failed halfway, or
      // someone regenerating the pair in Slack and redeploying. If the
      // environment holds a different refresh token, it's the newer of the
      // two, so give it a turn.
      const fallback = env("SLACK_CONFIG_REFRESH_TOKEN");
      if (fallback && fallback !== refreshToken) {
        rotated = await rotate_(fallback);
      } else {
        throw rotationFailed(error);
      }
    }

    current = rotated;
    return rotated;
  })().finally(() => {
    rotating = undefined;
  });

  return rotating;
}

async function rotate_(refreshToken: string): Promise<Pair> {
  const response = await slackPost<{
    ok: true;
    token: string;
    refresh_token: string;
    exp: number;
  }>("tooling.tokens.rotate", { form: { refresh_token: refreshToken } });

  return {
    accessToken: response.token,
    refreshToken: response.refresh_token,
    // `exp` is seconds since the epoch.
    expiresAt: response.exp * 1000,
  };
}

function env(name: "SLACK_CONFIG_ACCESS_TOKEN" | "SLACK_CONFIG_REFRESH_TOKEN") {
  const value = process.env[name];
  // `vercel env pull` writes this in place of secrets it won't hand out.
  if (!value || value === "[sensitive]") return undefined;
  return value;
}

function rotationFailed(error: unknown) {
  if (error instanceof SlackApiError) {
    return new Error(
      `Could not refresh the Slack app configuration token (${error.code}). ` +
        "Slack invalidates a refresh token once it has been used, so this is " +
        "expected after the process that rotated it went away. Generate a new " +
        "pair at https://api.slack.com/apps and update SLACK_CONFIG_ACCESS_TOKEN " +
        "and SLACK_CONFIG_REFRESH_TOKEN.",
      { cause: error },
    );
  }
  return error;
}

function isRejectedToken(error: unknown) {
  return error instanceof SlackApiError && REJECTED_TOKEN.has(error.code);
}

function isExpiring(pair: Pair) {
  if (pair.expiresAt === undefined) return false;
  return pair.expiresAt - EXPIRY_MARGIN_MS <= Date.now();
}
