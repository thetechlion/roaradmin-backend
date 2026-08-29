import { Hono } from "hono";
import type { Env, AppVariables, Rank, StaffMember, QueuedCommand, Org } from "./types";
import { requireGameKey, requireStaffSession, getOrgRobloxApiKey } from "./auth";
import { syncOrgGroup, syncSingleStaffMember, MissingApiKeyError } from "./groupSync";
import {
  findMembershipForUser,
  updateMembershipRole,
  membershipIdFromPath,
  validateApiKey,
  OpenCloudError,
} from "./openCloudGroups";
import { encryptSecret } from "./crypto";
import {
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getUserInfo,
  getUserGroupRoles,
} from "./oauth";
import { createSessionToken, createSetupToken, verifySetupToken } from "./session";

export { GameLink } from "./gameLink";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours
const SETUP_TOKEN_TTL_SECONDS = 60 * 30; // 30 minutes

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
    rankName: rank?.name ?? (staff.is_org_owner ? "Owner" : null),
    priority: rank?.priority ?? (staff.is_org_owner ? Number.MAX_SAFE_INTEGER : 0),
    permissions: rank ? JSON.parse(rank.permissions) : staff.is_org_owner ? ["*"] : [],
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

// ── Roblox OAuth 2.0 login ────────────────────────────────────────────────
// One RoarAdmin-wide OAuth app (registered once in the Roblox Creator
// Dashboard with the `openid profile` scopes) handles login for every org's
// dashboard users. See src/oauth.ts for setup notes.

app.get("/auth/roblox/login", async (c) => {
  const { verifier, challenge } = await generatePkcePair();
  const state = crypto.randomUUID();

  // Short-lived: the PKCE verifier only needs to survive the redirect round trip.
  await c.env.PERMS_CACHE.put(`oauth_state:${state}`, verifier, { expirationTtl: 600 });

  const url = buildAuthorizeUrl({
    clientId: c.env.ROBLOX_OAUTH_CLIENT_ID,
    redirectUri: c.env.ROBLOX_OAUTH_REDIRECT_URI,
    state,
    codeChallenge: challenge,
  });

  return c.redirect(url);
});

app.get("/auth/roblox/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.json({ error: "missing_code_or_state" }, 400);

  const stateKey = `oauth_state:${state}`;
  const verifier = await c.env.PERMS_CACHE.get(stateKey);
  if (!verifier) return c.json({ error: "invalid_or_expired_state" }, 400);
  await c.env.PERMS_CACHE.delete(stateKey);

  const tokens = await exchangeCodeForToken({
    clientId: c.env.ROBLOX_OAUTH_CLIENT_ID,
    clientSecret: c.env.ROBLOX_OAUTH_CLIENT_SECRET,
    redirectUri: c.env.ROBLOX_OAUTH_REDIRECT_URI,
    code,
    codeVerifier: verifier,
  });

  const userInfo = await getUserInfo(tokens.access_token);
  const robloxUserId = Number(userInfo.sub);

  // "Owned groups" = groups where this user's role has rank 255 (Owner).
  const allGroupRoles = await getUserGroupRoles(userInfo.sub);
  const ownedGroups = allGroupRoles.filter((g) => g.role.rank === 255);

  const groups: Array<{
    groupId: number;
    groupName: string;
    orgId?: string;
    sessionToken?: string;
    needsSetup: boolean;
    setupToken?: string;
  }> = [];

  for (const g of ownedGroups) {
    const org = await c.env.DB.prepare("SELECT * FROM orgs WHERE roblox_group_id = ?")
      .bind(g.group.id)
      .first<Org>();

    if (org) {
      let staff = await c.env.DB.prepare(
        "SELECT * FROM staff_members WHERE org_id = ? AND roblox_user_id = ?"
      )
        .bind(org.id, robloxUserId)
        .first<StaffMember>();

      // The group owner always gets dashboard access, even if group-sync
      // hasn't run yet or their rank isn't mapped -- rank_override keeps
      // them out of the auto-resync path entirely.
      if (!staff) {
        const staffId = crypto.randomUUID();
        await c.env.DB.prepare(
          `INSERT INTO staff_members (id, org_id, roblox_user_id, roblox_username, is_org_owner, rank_override)
           VALUES (?, ?, ?, ?, 1, 1)`
        )
          .bind(staffId, org.id, robloxUserId, userInfo.preferred_username ?? `user_${robloxUserId}`)
          .run();
        staff = { id: staffId } as StaffMember;
      }

      const sessionToken = await createSessionToken(
        {
          staffMemberId: staff.id,
          orgId: org.id,
          robloxUserId,
          exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        },
        c.env.SESSION_SECRET
      );

      groups.push({ groupId: g.group.id, groupName: g.group.name, orgId: org.id, sessionToken, needsSetup: false });
    } else {
      const setupToken = await createSetupToken(
        {
          robloxUserId,
          robloxGroupId: g.group.id,
          groupName: g.group.name,
          exp: Math.floor(Date.now() / 1000) + SETUP_TOKEN_TTL_SECONDS,
        },
        c.env.SESSION_SECRET
      );
      groups.push({ groupId: g.group.id, groupName: g.group.name, needsSetup: true, setupToken });
    }
  }

  // Hand off to the dashboard (a separate Pages app) via URL fragment, not a
  // query string -- fragments never leave the browser, so these one-time
  // tokens never hit any server log (ours or Roblox's referrer chain).
  const payload = { robloxUserId, username: userInfo.preferred_username, groups };
  const redirectUrl = `${c.env.DASHBOARD_URL}/auth/callback#data=${encodeURIComponent(JSON.stringify(payload))}`;
  return c.redirect(redirectUrl);
});

// ── Org bootstrap ─────────────────────────────────────────────────────────
// Creates a new org for a group the user just proved (via OAuth) they own.
// Authorized by a short-lived setup token instead of a staff session, since
// no staff_members row -- or org -- exists yet at this point.

app.post("/orgs", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "missing_setup_token" }, 401);

  const payload = await verifySetupToken(token, c.env.SESSION_SECRET);
  if (!payload) return c.json({ error: "invalid_or_expired_setup_token" }, 401);

  const body = await c.req
    .json<{ name?: string; discordGuildId?: string }>()
    .catch(() => ({} as { name?: string; discordGuildId?: string }));

  const existing = await c.env.DB.prepare("SELECT * FROM orgs WHERE roblox_group_id = ?")
    .bind(payload.robloxGroupId)
    .first<Org>();
  if (existing) return c.json({ error: "org_already_exists", orgId: existing.id }, 409);

  const orgId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO orgs (id, name, roblox_group_id, discord_guild_id) VALUES (?, ?, ?, ?)"
  )
    .bind(orgId, body.name ?? payload.groupName, payload.robloxGroupId, body.discordGuildId ?? null)
    .run();

  const staffId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO staff_members (id, org_id, roblox_user_id, roblox_username, is_org_owner, rank_override)
     VALUES (?, ?, ?, ?, 1, 1)`
  )
    .bind(staffId, orgId, payload.robloxUserId, `user_${payload.robloxUserId}`)
    .run();

  const sessionToken = await createSessionToken(
    {
      staffMemberId: staffId,
      orgId,
      robloxUserId: payload.robloxUserId,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    c.env.SESSION_SECRET
  );

  return c.json({ orgId, sessionToken }, 201);
});

// ── Dashboard -> backend ──────────────────────────────────────────────────
// Staff-session-authenticated routes.

const orgs = app.basePath("/orgs/:orgId");
orgs.use("*", requireStaffSession);

// Tells the dashboard exactly what to select when the group owner creates
// their Roblox Open Cloud API key -- this is the #1 source of confusing
// 401/403s, since Roblox's Groups write API needs several specific
// permission boxes checked, not just a generic "group" toggle.
orgs.get("/roblox-api-key/setup-instructions", async (c) => {
  const org = await c.env.DB.prepare("SELECT * FROM orgs WHERE id = ?")
    .bind(c.req.param("orgId"))
    .first<Org>();
  if (!org) return c.json({ error: "unknown_org" }, 404);

  return c.json({
    groupId: org.roblox_group_id,
    steps: [
      "Go to the Roblox Creator Dashboard (create.roblox.com) and switch the account/context selector at the top to this group -- the key must be created as the group, not your personal account.",
      "Open Open Cloud -> API Keys, then click Create API Key.",
      "Under Permissions, add the Groups API and enable every group-membership permission you see -- reading roles, reading membership, and updating/assigning membership roles. Roblox has split these into several checkboxes; missing one is the most common cause of a rejected key.",
      "You must be the group owner, or a member with the 'API key admin' permission, to create a key for the group.",
      "Optional: restrict the key to this group only and set an IP allowlist.",
      "Copy the generated key immediately -- Roblox only shows it once -- and paste it into RoarAdmin below.",
    ],
    note: "Roblox's Open Cloud Groups write API is still in Beta and the exact permission labels have shifted before. If a correctly-scoped key still gets rejected, RoarAdmin will show Roblox's error directly so you can tell whether it's a scope issue or something else (like trying to assign the Owner/Member/Guest role, which Roblox blocks via API entirely).",
  });
});

orgs.post("/roblox-api-key", async (c) => {
  const orgId = c.req.param("orgId");
  const session = c.get("session");
  const org = await c.env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first<Org>();
  if (!org) return c.json({ error: "unknown_org" }, 404);

  const { apiKey } = await c.req.json<{ apiKey: string }>();
  if (!apiKey) return c.json({ error: "missing_api_key" }, 400);

  try {
    await validateApiKey(apiKey, org.roblox_group_id);
  } catch (err) {
    const status = err instanceof OpenCloudError ? err.status : 502;
    return c.json(
      {
        error: "roblox_api_key_invalid",
        detail:
          status === 401 || status === 403
            ? "Roblox rejected this key. Check it was created under this group (not your personal account) and that every group-membership permission is enabled -- see the setup instructions."
            : "Couldn't validate this key against Roblox right now -- try again shortly.",
      },
      422
    );
  }

  const { ciphertext, iv } = await encryptSecret(apiKey, c.env.ENCRYPTION_KEY);

  await c.env.DB.prepare(
    `INSERT INTO org_roblox_credentials (org_id, api_key_ciphertext, api_key_iv, added_by_staff_id, last_validated_at, last_validation_ok)
     VALUES (?, ?, ?, ?, unixepoch(), 1)
     ON CONFLICT(org_id) DO UPDATE SET
       api_key_ciphertext = excluded.api_key_ciphertext,
       api_key_iv = excluded.api_key_iv,
       added_by_staff_id = excluded.added_by_staff_id,
       last_validated_at = excluded.last_validated_at,
       last_validation_ok = excluded.last_validation_ok`
  )
    .bind(org.id, ciphertext, iv, session.staffMemberId)
    .run();

  return c.json({ ok: true });
});

// Manual "sync now" button on the dashboard — full poll fallback for one org.
orgs.post("/sync/full", async (c) => {
  const orgId = c.req.param("orgId");
  const org = await c.env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first<Org>();
  if (!org) return c.json({ error: "unknown_org" }, 404);

  try {
    await syncOrgGroup(c.env, org);
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return c.json({ error: "no_roblox_api_key_configured" }, 412);
    }
    throw err;
  }
  return c.json({ ok: true });
});

// Instant/"push" sync for one staff member — call right after a dashboard
// promotion/demotion action so the record doesn't wait for the next Cron tick.
orgs.post("/sync/staff/:staffId", async (c) => {
  const orgId = c.req.param("orgId");
  const staffId = c.req.param("staffId");
  const org = await c.env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first<Org>();
  if (!org) return c.json({ error: "unknown_org" }, 404);

  await syncSingleStaffMember(c.env, org, staffId);
  return c.json({ ok: true });
});

// Promotes/demotes a staff member: writes the role change to Roblox itself,
// then reflects it locally right away.
orgs.post("/staff/:staffId/promote", async (c) => {
  const orgId = c.req.param("orgId");
  const staffId = c.req.param("staffId");
  const org = await c.env.DB.prepare("SELECT * FROM orgs WHERE id = ?").bind(orgId).first<Org>();
  if (!org) return c.json({ error: "unknown_org" }, 404);

  const { toRankId, reason } = await c.req.json<{ toRankId: string; reason?: string }>();

  const staff = await c.env.DB.prepare("SELECT * FROM staff_members WHERE id = ? AND org_id = ?")
    .bind(staffId, orgId)
    .first<StaffMember>();
  if (!staff) return c.json({ error: "unknown_staff_member" }, 404);

  const toRank = await c.env.DB.prepare("SELECT * FROM ranks WHERE id = ? AND org_id = ?")
    .bind(toRankId, orgId)
    .first<Rank>();
  if (!toRank || toRank.roblox_rank_id == null) {
    return c.json({ error: "target_rank_not_mapped_to_group_role" }, 400);
  }

  const apiKey = await getOrgRobloxApiKey(c, orgId);
  if (!apiKey) return c.json({ error: "no_roblox_api_key_configured" }, 412);

  let membershipId = staff.roblox_membership_id;
  if (!membershipId) {
    const membership = await findMembershipForUser(apiKey, org.roblox_group_id, staff.roblox_user_id);
    if (!membership) return c.json({ error: "user_not_in_group" }, 409);
    membershipId = membershipIdFromPath(membership.path);
  }

  try {
    await updateMembershipRole(apiKey, org.roblox_group_id, membershipId, String(toRank.roblox_rank_id));
  } catch (err) {
    const status = err instanceof OpenCloudError ? err.status : 502;
    return c.json(
      {
        error: "roblox_role_update_failed",
        detail:
          status === 401 || status === 403
            ? "Roblox rejected the role change. The stored API key may be missing the group-membership write permission, or this target role can't be assigned via API (Roblox blocks assigning the built-in Owner/Member/Guest roles this way)."
            : "Roblox's API didn't accept this role change -- try again shortly.",
      },
      422
    );
  }

  const session = c.get("session");
  await c.env.DB.prepare(
    `INSERT INTO rank_changes (id, org_id, staff_id, from_rank_id, to_rank_id, changed_by_staff_id, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), orgId, staffId, staff.rank_id, toRankId, session.staffMemberId, reason ?? null)
    .run();

  // Reflect the change locally right away rather than waiting on the next sync.
  await syncSingleStaffMember(c.env, org, staffId);

  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,

  // Cron Trigger fallback: sweeps every org so no one relies solely on the
  // instant push path (e.g. ranks changed directly in Roblox, not via the dashboard).
  async scheduled(_event: ScheduledEvent, env: Env) {
    const { results: allOrgs } = await env.DB.prepare("SELECT * FROM orgs").all<Org>();
    for (const org of allOrgs) {
      try {
        await syncOrgGroup(env, org);
      } catch (err) {
        if (err instanceof MissingApiKeyError) {
          console.log(err.message); // expected until the org adds a key -- not an error
        } else {
          console.error(`group sync failed for org ${org.id}:`, err);
        }
      }
    }
  },
};
