import type { Context, Next } from "hono";
import type { Env, Game, AppVariables, OrgRobloxCredential } from "./types";
import { verifySessionToken } from "./session";
import { decryptSecret } from "./crypto";

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

// SHA-256 the incoming key and compare to the stored hash — we never store
// the raw API key, only its hash, same pattern as a password.
export async function hashKey(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Middleware used on every route the Roblox Studio module calls.
 * Expects header: Authorization: Bearer <game_api_key>
 * On success, attaches the resolved `game` row to context via c.set("game", ...).
 */
export async function requireGameKey(c: AppContext, next: Next) {
  const authHeader = c.req.header("Authorization") ?? "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return c.json({ error: "missing_api_key" }, 401);
  }

  const gameId = c.req.param("gameId");
  if (!gameId) {
    return c.json({ error: "missing_game_id" }, 400);
  }

  const game = await c.env.DB.prepare("SELECT * FROM games WHERE id = ?")
    .bind(gameId)
    .first<Game>();

  if (!game) {
    return c.json({ error: "unknown_game" }, 404);
  }

  const providedHash = await hashKey(token);
  if (providedHash !== game.api_key_hash) {
    return c.json({ error: "invalid_api_key" }, 401);
  }

  c.set("game", game);
  await next();
}

// Dashboard staff auth. Session tokens are issued at the end of the Roblox
// OAuth callback (see /auth/roblox/callback in index.ts) and sent back as
// `Authorization: Bearer <token>` on every dashboard API call.
export async function requireStaffSession(c: AppContext, next: Next) {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) {
    return c.json({ error: "not_authenticated" }, 401);
  }

  const payload = await verifySessionToken(token, c.env.SESSION_SECRET);
  if (!payload) {
    return c.json({ error: "invalid_or_expired_session" }, 401);
  }

  // A session is always scoped to one org (the one the user selected on
  // login); routes under /orgs/:orgId must match, so a stolen/reused token
  // for org A can't be replayed against org B.
  const orgIdParam = c.req.param("orgId");
  if (orgIdParam && orgIdParam !== payload.orgId) {
    return c.json({ error: "org_mismatch" }, 403);
  }

  c.set("session", {
    staffMemberId: payload.staffMemberId,
    orgId: payload.orgId,
    robloxUserId: payload.robloxUserId,
  });
  await next();
}

/** Decrypts and returns an org's stored Roblox Open Cloud API key, or null if none is set. */
export async function getOrgRobloxApiKey(c: AppContext, orgId: string): Promise<string | null> {
  const cred = await c.env.DB.prepare("SELECT * FROM org_roblox_credentials WHERE org_id = ?")
    .bind(orgId)
    .first<OrgRobloxCredential>();
  if (!cred) return null;

  return decryptSecret(cred.api_key_ciphertext, cred.api_key_iv, c.env.ENCRYPTION_KEY);
}
