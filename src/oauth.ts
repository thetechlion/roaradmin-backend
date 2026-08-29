// Roblox OAuth 2.0 / OpenID Connect helpers.
// Reference: https://create.roblox.com/docs/cloud/auth/oauth2-reference
//
// This app is registered once (by whoever operates RoarAdmin) as a single
// OAuth 2.0 app in the Roblox Creator Dashboard, with the `openid profile`
// scopes and this Worker's /auth/roblox/callback as its redirect URL.
// Every dashboard user authenticates through that one app.
//
// Config needed:
//   wrangler.toml [vars]:   ROBLOX_OAUTH_CLIENT_ID
//   wrangler secret put ROBLOX_OAUTH_CLIENT_SECRET
//   wrangler secret put SESSION_SECRET
//   wrangler secret put ENCRYPTION_KEY

const AUTHORIZE_URL = "https://apis.roblox.com/oauth/v1/authorize";
const TOKEN_URL = "https://apis.roblox.com/oauth/v1/token";
const USERINFO_URL = "https://apis.roblox.com/oauth/v1/userinfo";

export interface RobloxUserInfo {
  sub: string; // Roblox user id, as a string
  name?: string;
  nickname?: string;
  preferred_username?: string;
  picture?: string;
}

function toBase64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Generates a PKCE verifier + its S256 challenge. Roblox supports and recommends PKCE for all client types. */
export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = toBase64Url(verifierBytes.buffer);

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = toBase64Url(digest);

  return { verifier, challenge };
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: "openid profile",
    response_type: "code",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<{ access_token: string; id_token: string; refresh_token: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Roblox OAuth token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function getUserInfo(accessToken: string): Promise<RobloxUserInfo> {
  const res = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Roblox userinfo fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * A user's groups + their role in each, via the public legacy endpoint.
 * This is self-scoped (a user looking up their own memberships) rather than
 * a third party listing a group's members, so it isn't affected by the
 * Jan 2026 group member-list-privacy change -- only used to populate the
 * "which of your groups do you want to set up?" screen after login.
 */
export async function getUserGroupRoles(
  robloxUserId: string
): Promise<{ group: { id: number; name: string }; role: { id: number; name: string; rank: number } }[]> {
  const res = await fetch(`https://groups.roblox.com/v1/users/${robloxUserId}/groups/roles`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Roblox groups lookup failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json<{ data: any[] }>();
  return data.data;
}
