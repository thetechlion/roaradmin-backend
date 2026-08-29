// Minimal signed session token for the dashboard: HMAC-SHA256 over a JSON
// payload, base64url encoded. Not a full JWT library -- we don't need
// interop with anything else, just a tamper-proof token we issue and verify
// ourselves. Secret comes from a Wrangler secret:
//   wrangler secret put SESSION_SECRET

export interface SessionPayload {
  kind: "session";
  staffMemberId: string;
  orgId: string;
  robloxUserId: number;
  exp: number; // unix seconds
}

/** Short-lived token proving "this Roblox user just OAuth'd and owns this group",
 * used to authorize POST /orgs/bootstrap without re-running the OAuth flow. */
export interface SetupPayload {
  kind: "setup";
  robloxUserId: number;
  robloxGroupId: number;
  groupName: string;
  exp: number;
}

type AnyPayload = SessionPayload | SetupPayload;

function toBase64Url(bytes: Uint8Array): string {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(payload: AnyPayload, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

async function verifyPayload<T extends AnyPayload>(token: string, secret: string): Promise<T | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(sig),
    new TextEncoder().encode(body)
  );
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createSessionToken(
  payload: Omit<SessionPayload, "kind">,
  secret: string
): Promise<string> {
  return signPayload({ ...payload, kind: "session" }, secret);
}

export async function verifySessionToken(
  token: string,
  secret: string
): Promise<SessionPayload | null> {
  const payload = await verifyPayload<SessionPayload>(token, secret);
  return payload?.kind === "session" ? payload : null;
}

export async function createSetupToken(
  payload: Omit<SetupPayload, "kind">,
  secret: string
): Promise<string> {
  return signPayload({ ...payload, kind: "setup" }, secret);
}

export async function verifySetupToken(token: string, secret: string): Promise<SetupPayload | null> {
  const payload = await verifyPayload<SetupPayload>(token, secret);
  return payload?.kind === "setup" ? payload : null;
}
