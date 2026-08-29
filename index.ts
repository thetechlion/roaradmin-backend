import { Hono } from "hono";
import type { Env, AppVariables, Rank, StaffMember, QueuedCommand } from "./types";
import { requireGameKey } from "./auth";

export { GameLink } from "./gameLink";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get("/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));

// ── Roblox Studio module -> backend ──────────────────────────────────────
// All routes below require the per-game API key (Authorization: Bearer <key>)

const game = app.basePath("/games/:gameId");
game.use("*", requireGameKey);

// Called on player join: resolve their current rank + permission set.
// Cached in KV for a short TTL so a busy server isn't hammering D1.
game.get("/permissions/:robloxUserId", async (c) => {
  const gameRow = c.get("game");
  const robloxUserId = c.req.param("robloxUserId");
  const cacheKey = `perm:${gameRow.org_id}:${robloxUserId}`;

  const cached = await c.env.PERMS_CACHE.get(cacheKey, "json");
  if (cached) return c.json(cached);

  const staff = await c.env.DB.prepare(
    "SELECT * FROM staff_members WHERE org_id = ? AND roblox_user_id = ? AND status = 'active'"
  )
    .bind(gameRow.org_id, robloxUserId)
    .first<StaffMember>();

  if (!staff) {
    const result = { isStaff: false, permissions: [], priority: 0 };
    await c.env.PERMS_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 });
    return c.json(result);
  }

  const rank = staff.rank_id
    ? await c.env.DB.prepare("SELECT * FROM ranks WHERE id = ?").bind(staff.rank_id).first<Rank>()
    : null;

  const result = {
    isStaff: true,
    rankName: rank?.name ?? null,
    priority: rank?.priority ?? 0,
    permissions: rank ? JSON.parse(rank.permissions) : [],
  };

  await c.env.PERMS_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 });
  return c.json(result);
});

// Roblox module polls this to pick up commands issued from the dashboard/Discord.
game.get("/commands/poll", async (c) => {
  const gameRow = c.get("game");

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM command_queue WHERE game_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 25"
  )
    .bind(gameRow.id)
    .all<QueuedCommand>();

  if (results.length > 0) {
    const ids = results.map((r) => r.id);
    await c.env.DB.prepare(
      `UPDATE command_queue SET status = 'delivered', delivered_at = unixepoch() WHERE id IN (${ids
        .map(() => "?")
        .join(",")})`
    )
      .bind(...ids)
      .run();
  }

  return c.json({
    commands: results.map((r) => ({ id: r.id, command: r.command, args: JSON.parse(r.args) })),
  });
});

// Roblox module reports a moderation action it took locally (e.g. a chat-command ban)
// so it shows up in the shared log/dashboard.
game.post("/moderation", async (c) => {
  const gameRow = c.get("game");
  const body = await c.req.json<{
    action_type: string;
    target_roblox_user_id: number;
    target_username: string;
    issued_by_staff_id: string;
    reason?: string;
    duration_seconds?: number;
  }>();

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO moderation_actions
      (id, org_id, game_id, action_type, target_roblox_user_id, target_username, issued_by_staff_id, reason, duration_seconds, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      gameRow.org_id,
      gameRow.id,
      body.action_type,
      body.target_roblox_user_id,
      body.target_username,
      body.issued_by_staff_id,
      body.reason ?? null,
      body.duration_seconds ?? null,
      body.duration_seconds ? Math.floor(Date.now() / 1000) + body.duration_seconds : null
    )
    .run();

  return c.json({ id }, 201);
});

// Passive time-tracking: module calls this on join and on leave.
game.post("/time/join", async (c) => {
  const gameRow = c.get("game");
  const { staff_id } = await c.req.json<{ staff_id: string }>();
  const id = crypto.randomUUID();

  await c.env.DB.prepare(
    "INSERT INTO time_logs (id, org_id, game_id, staff_id, joined_at) VALUES (?, ?, ?, ?, unixepoch())"
  )
    .bind(id, gameRow.org_id, gameRow.id, staff_id)
    .run();

  return c.json({ time_log_id: id }, 201);
});

game.post("/time/leave", async (c) => {
  const { time_log_id } = await c.req.json<{ time_log_id: string }>();

  await c.env.DB.prepare(
    `UPDATE time_logs
     SET left_at = unixepoch(), duration_seconds = unixepoch() - joined_at
     WHERE id = ?`
  )
    .bind(time_log_id)
    .run();

  return c.json({ ok: true });
});

export default app;
