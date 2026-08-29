import type { Env, Org, Rank, StaffMember } from "./types";
import { getGroupRoles, iterateUsersInRole, getUserRoleInGroup } from "./robloxGroup";

const now = () => Math.floor(Date.now() / 1000);

async function getMappedRanks(env: Env, orgId: string): Promise<Rank[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM ranks WHERE org_id = ? AND roblox_rank_id IS NOT NULL"
  )
    .bind(orgId)
    .all<Rank>();
  return results;
}

async function upsertStaffForRank(
  env: Env,
  org: Org,
  rank: Rank,
  robloxUserId: number,
  username: string,
  robloxRoleId: number
) {
  const existing = await env.DB.prepare(
    "SELECT * FROM staff_members WHERE org_id = ? AND roblox_user_id = ?"
  )
    .bind(org.id, robloxUserId)
    .first<StaffMember>();

  if (!existing) {
    // Brand new staff member: they hold a group role that's mapped to a
    // configured rank, so bring them in as `synced`.
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO staff_members
        (id, org_id, roblox_user_id, roblox_username, rank_id, last_group_rank_id, sync_status, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, 'synced', ?)`
    )
      .bind(id, org.id, robloxUserId, username, rank.id, robloxRoleId, now())
      .run();

    await env.DB.prepare(
      `INSERT INTO rank_changes (id, org_id, staff_id, from_rank_id, to_rank_id, changed_by_staff_id, reason)
       VALUES (?, ?, ?, NULL, ?, NULL, 'group_sync: new staff member')`
    )
      .bind(crypto.randomUUID(), org.id, id, rank.id)
      .run();
    return;
  }

  // rank_override users are explicitly opted out of auto-resync — never touch them.
  if (existing.rank_override) return;

  const rankChanged = existing.rank_id !== rank.id;

  await env.DB.prepare(
    `UPDATE staff_members
     SET rank_id = ?, last_group_rank_id = ?, sync_status = 'synced', last_synced_at = ?
     WHERE id = ?`
  )
    .bind(rank.id, robloxRoleId, now(), existing.id)
    .run();

  if (rankChanged) {
    await env.DB.prepare(
      `INSERT INTO rank_changes (id, org_id, staff_id, from_rank_id, to_rank_id, changed_by_staff_id, reason)
       VALUES (?, ?, ?, ?, ?, NULL, 'group_sync: role change detected')`
    )
      .bind(crypto.randomUUID(), org.id, existing.id, existing.rank_id, rank.id)
      .run();
  }
}

/**
 * Phase A — discover: walk every *configured* (mapped) rank and pull the
 * current member list for its Roblox role, upserting staff records.
 * We deliberately don't crawl the whole group membership — only roles an
 * admin has actually mapped to a RoarAdmin rank matter for staff purposes.
 */
async function discoverFromMappedRanks(env: Env, org: Org) {
  const ranks = await getMappedRanks(env, org.id);

  for (const rank of ranks) {
    if (rank.roblox_rank_id == null) continue;
    for await (const member of iterateUsersInRole(org.roblox_group_id, rank.roblox_rank_id)) {
      await upsertStaffForRank(env, org, rank, member.userId, member.username, rank.roblox_rank_id);
    }
  }
}

/**
 * Phase B — reconcile: for staff we already track (and haven't opted out
 * via rank_override), look up their *current* group role directly. Catches
 * promotions/demotions/removals that happened outside RoarAdmin.
 *
 * Per policy: if their new role doesn't map to any configured rank, we
 * DO NOT change their local rank_id — we only flag sync_status so an admin
 * can map it (or explicitly override). Nobody silently loses permissions.
 */
async function reconcileExistingStaff(env: Env, org: Org) {
  const ranks = await getMappedRanks(env, org.id);
  const rankByRobloxId = new Map(ranks.map((r) => [r.roblox_rank_id, r]));

  const { results: staff } = await env.DB.prepare(
    "SELECT * FROM staff_members WHERE org_id = ? AND rank_override = 0 AND status = 'active'"
  )
    .bind(org.id)
    .all<StaffMember>();

  for (const member of staff) {
    const currentRole = await getUserRoleInGroup(member.roblox_user_id, org.roblox_group_id);

    if (!currentRole) {
      // Left the group entirely. Leave rank_id untouched, just flag it.
      await env.DB.prepare(
        "UPDATE staff_members SET sync_status = 'left_group', last_synced_at = ? WHERE id = ?"
      )
        .bind(now(), member.id)
        .run();
      continue;
    }

    // Already up to date, and their live role still maps cleanly.
    if (currentRole.role.id === member.last_group_rank_id && member.sync_status === "synced") {
      continue;
    }

    const matchedRank = rankByRobloxId.get(currentRole.role.id);

    if (!matchedRank) {
      // Their group role has no configured RoarAdmin rank. Leave them
      // exactly as they are; just surface it for an admin to resolve.
      await env.DB.prepare(
        `UPDATE staff_members
         SET last_group_rank_id = ?, sync_status = 'unmapped', last_synced_at = ?
         WHERE id = ?`
      )
        .bind(currentRole.role.id, now(), member.id)
        .run();
      continue;
    }

    if (matchedRank.id !== member.rank_id) {
      await env.DB.prepare(
        `UPDATE staff_members
         SET rank_id = ?, last_group_rank_id = ?, sync_status = 'synced', last_synced_at = ?
         WHERE id = ?`
      )
        .bind(matchedRank.id, currentRole.role.id, now(), member.id)
        .run();

      await env.DB.prepare(
        `INSERT INTO rank_changes (id, org_id, staff_id, from_rank_id, to_rank_id, changed_by_staff_id, reason)
         VALUES (?, ?, ?, ?, ?, NULL, 'group_sync: role change detected')`
      )
        .bind(crypto.randomUUID(), org.id, member.id, member.rank_id, matchedRank.id)
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE staff_members SET last_group_rank_id = ?, sync_status = 'synced', last_synced_at = ? WHERE id = ?"
      )
        .bind(currentRole.role.id, now(), member.id)
        .run();
    }
  }
}

/** Full sync for one org. Called on a Cron Trigger (fallback) and from the manual "sync now" button. */
export async function syncOrgGroup(env: Env, org: Org) {
  await discoverFromMappedRanks(env, org);
  await reconcileExistingStaff(env, org);
}

/**
 * Instant/"push" sync for a single staff member — call this right after any
 * action taken through RoarAdmin itself that changes someone's Roblox group
 * rank (e.g. a dashboard promotion), so the local record doesn't wait for
 * the next Cron tick.
 */
export async function syncSingleStaffMember(env: Env, org: Org, staffId: string) {
  const member = await env.DB.prepare("SELECT * FROM staff_members WHERE id = ? AND org_id = ?")
    .bind(staffId, org.id)
    .first<StaffMember>();
  if (!member || member.rank_override) return;

  const ranks = await getMappedRanks(env, org.id);
  const rankByRobloxId = new Map(ranks.map((r) => [r.roblox_rank_id, r]));
  const currentRole = await getUserRoleInGroup(member.roblox_user_id, org.roblox_group_id);

  if (!currentRole) {
    await env.DB.prepare(
      "UPDATE staff_members SET sync_status = 'left_group', last_synced_at = ? WHERE id = ?"
    )
      .bind(now(), member.id)
      .run();
    return;
  }

  const matchedRank = rankByRobloxId.get(currentRole.role.id);
  if (!matchedRank) {
    await env.DB.prepare(
      `UPDATE staff_members
       SET last_group_rank_id = ?, sync_status = 'unmapped', last_synced_at = ?
       WHERE id = ?`
    )
      .bind(currentRole.role.id, now(), member.id)
      .run();
    return;
  }

  await env.DB.prepare(
    `UPDATE staff_members
     SET rank_id = ?, last_group_rank_id = ?, sync_status = 'synced', last_synced_at = ?
     WHERE id = ?`
  )
    .bind(matchedRank.id, currentRole.role.id, now(), member.id)
    .run();
}
