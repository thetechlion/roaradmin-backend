import type { Context, Next } from "hono";
import type { Env, Game, AppVariables } from "./types";

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

// Placeholder for the dashboard side: staff sign in with Roblox OAuth2,
// we issue our own short-lived signed session token (JWT or similar) and
// validate it here. Filled in when we build the dashboard auth flow.
export async function requireStaffSession(c: AppContext, next: Next) {
  const sessionToken = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!sessionToken) {
    return c.json({ error: "not_authenticated" }, 401);
  }
  // TODO: verify signed session token, look up staff_member, attach to context
  await next();
}
