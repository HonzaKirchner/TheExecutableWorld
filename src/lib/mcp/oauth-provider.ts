import { randomBytes } from "node:crypto";

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { baseUrl } from "@/lib/base-url";
import {
  loadCredentials,
  updateCredentials,
  type McpCredentials,
} from "@/lib/mcp/connections";

export const MCP_CALLBACK_PATH = "/api/mcp/callback";

/**
 * The SDK's OAuth client, backed by one `mcp_connections` row.
 *
 * The SDK was written with a long-lived process in mind: it hands us things to
 * hold on to (registered client, tokens, PKCE verifier) and asks for them back
 * later. Here "later" is a different request, possibly on a different
 * serverless instance, so everything goes through the database.
 *
 * The one thing that can't be done for real is the redirect — a Server Action
 * can't navigate from inside a callback. `redirectToAuthorization` records the
 * URL instead, and the caller performs the redirect once the SDK has thrown
 * its `UnauthorizedError`.
 */
export class DbOAuthClientProvider implements OAuthClientProvider {
  readonly connectionId: string;

  /** Set once the SDK has asked for the person to be sent off to authorize. */
  authorizationUrl: URL | undefined;

  // Loaded on first use. The SDK reads tokens and client info several times
  // per connection attempt; one round trip is enough.
  private credentials: Promise<McpCredentials> | undefined;

  constructor(connectionId: string) {
    this.connectionId = connectionId;
  }

  get redirectUrl() {
    return `${baseUrl()}${MCP_CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Coworkers",
      client_uri: baseUrl(),
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Registered as a public client. PKCE protects the code exchange, and
      // every server in the catalog accepts public clients — not all of them
      // issue secrets to dynamically registered ones.
      token_endpoint_auth_method: "none",
    };
  }

  async state() {
    const state = randomBytes(24).toString("base64url");
    await this.save({ oauthState: state });
    return state;
  }

  async clientInformation() {
    return (await this.load()).clientInformation ?? undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    await this.save({ clientInformation });
  }

  async tokens() {
    return (await this.load()).tokens ?? undefined;
  }

  async saveTokens(tokens: OAuthTokens) {
    // The authorization is over, so the state and verifier it used are done
    // too. Clearing them means a replayed callback finds nothing to match.
    await this.save({ tokens, oauthState: null, codeVerifier: null });
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    this.authorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string) {
    await this.save({ codeVerifier });
  }

  async codeVerifier() {
    const verifier = (await this.load()).codeVerifier;
    if (!verifier) {
      throw new Error(
        "No PKCE code verifier stored for this connection. Start the authorization again.",
      );
    }
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const patch: Partial<McpCredentials> = {};
    if (scope === "all" || scope === "client") patch.clientInformation = null;
    if (scope === "all" || scope === "tokens") patch.tokens = null;
    if (scope === "all" || scope === "verifier") patch.codeVerifier = null;
    if (scope === "all" || scope === "discovery") patch.discovery = null;
    await this.save(patch);
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    await this.save({ discovery });
  }

  async discoveryState() {
    return (await this.load()).discovery ?? undefined;
  }

  private load() {
    this.credentials ??= loadCredentials(this.connectionId);
    return this.credentials;
  }

  private async save(patch: Partial<McpCredentials>) {
    await updateCredentials(this.connectionId, patch);
    const current = await this.load();
    this.credentials = Promise.resolve({ ...current, ...patch });
  }
}
