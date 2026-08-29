import type { Env, Org, Rank, StaffMember, OrgRobloxCredential } from "./types";
import {
  iterateMemberships,
  findMembershipForUser,
  membershipIdFromPath,
  roleIdFromPath,
  OpenCloudError,
} from "./openCloudGroups";
import { decryptSecret } from "./crypto";

const now = () => Math.floor(Date.now() / 1000);

export class MissingApiKeyError extends Error {
  constructor(orgId: string) {
    super(`Org ${orgId} has no Roblox API key on file -- group sync skipped`);
  }
}

async function getOrgApiKey(env: Env, org: Org): Promise<string> {
  const cred = await env.DB.prepare("SELECT * FROM org_roblox_credentials WHERE org_id = ?")
    .bind(org.id)
    .first<OrgRobloxCredential>();
  if (!cred) throw new MissingApiKeyError(org.id);
  return decryptSecret(cred.api_key_ciphertext, cred.api_key_iv, env.ENCRYPTION_KEY);
}

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
  membershipId: string,
  robloxRoleId: number
) {
  const existing = await env.DB.prepare(
    "SELECT * FROM staff_members WHERE org_id = ? AND roblox_user_id = ?"
  )
    .bind(org.id, robloxUserId)
    .first<StaffMember>();

  if (!existing) {
    // Brand new staff member: they hold a group role that's mapped to a
    // configured rank, so bring them in as `synced`. Username isn't
    // returned by the v2 membership object -- backfilled lazily by
    // whichever route next needs to display it, stored as a placeholder
    // in the meantime.
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO staff_members
        (id, org_id, roblox_user_id, roblox_username, rank_id, last_group_rank_id, roblox_membership_id, sync_status, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', ?)`
    )
      .bind(id, org.id, robloxUserId, `user_${robloxUserId}`, rank.id, robloxRoleId, membershipId, now())
      .run();

    await env.DB.prepare(
      `INSERT INTO rank_changes (id, org_id, staff_id, from_rank_id, to_rank_id, changed_by_staff_id, reason)
       VALUES (?, ?, ?, NULL, ?, NULL, 'group_sync: new staff member')`
    )
      .bind(crypto.randomUUID(), org.id, id, rank.id)
      .run();
    return;
  }

  if (existing.rank_override) return; // opted out of auto-resync

  const rankChanged = existing.rank_id !== rank.id;

  await env.DB.prepare(
    `UPDATE staff_members
     SET rank_id = ?, last_group_rank_id = ?, roblox_membership_id = ?, sync_status = 'synced', last_synced_at = ?
     WHERE id = ?`
  )
    .bind(rank.id, robloxRoleId, membershipId, now(), existing.id)
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

/** Phase A — discover: walk every configured (mapped) rank and pull the current
 * membership list for its Roblox role. We don't crawl the whole group -- only
 * roles an admin has mapped to a RoarAdmin rank matter for staff purposes. */
async function discoverFromMappedRanks(env: Env, org: Org, apiKey: string) {
  const ranks = await getMappedRanks(env, org.id);

  for (const rank of ranks) {
    if (rank.roblox_rank_id == null) continue;
    const filter = `role == 'groups/${org.roblox_group_id}/roles/${rank.roblox_rank_id}'`;

    for await (const membership of iterateMemberships(apiKey, org.roblox_group_id, filter)) {
      const userId = Number(membership.user.split("/").pop());
      await upsertStaffForRank(
        env,
        org,
        rank,
        userId,
        membershipIdFromPath(membership.path),
        rank.roblox_rank_id
      );
    }
  }
}

/** Phase B — reconcile: for staff already tracked, look up their current membership
 * directly, catching promotions/demotions/removals done outside RoarAdmin. An
 * unmapped role never touches rank_id -- only sync_status, so nobody silently
 * loses permissions; an admin has to resolve it. */
async function reconcileExistingStaff(env: Env, org: Org, apiKey: string) {
  const ranks = await getMappedRanks(env, org.id);
  const rankByRobloxId = new Map(ranks.map((r) => [r.roblox_rank_id, r]));

  const { results: staff } = await env.DB.prepare(
    "SELECT * FROM staff_members WHERE org_id = ? AND rank_override = 0 AND status = 'active'"
  )
    .bind(org.id)
    .all<StaffMember>();

  for (const member of staff) {
    const membership = await findMembershipForUser(apiKey, org.roblox_group_id, member.roblox_user_id);

    if (!membership) {
      await env.DB.prepare(
        "UPDATE staff_members SET sync_status = 'left_group', last_synced_at = ? WHERE id = ?"
      )
        .bind(now(), member.id)
        .run();
      continue;
    }

    const currentRoleId = Number(roleIdFromPath(membership.role));

    if (currentRoleId === member.last_group_rank_id && member.sync_status === "synced") {
      continue;
    }

    const matchedRank = rankByRobloxId.get(currentRoleId);

    if (!matchedRank) {
      await env.DB.prepare(
        `UPDATE staff_members
         SET last_group_rank_id = ?, roblox_membership_id = ?, sync_status = 'unmapped', last_synced_at = ?
         WHERE id = ?`
      )
        .bind(currentRoleId, membershipIdFromPath(membership.path), now(), member.id)
        .run();
      continue;
    }

    if (matchedRank.id !== member.rank_id) {
      await env.DB.prepare(
        `UPDATE staff_members
         SET rank_id = ?, last_group_rank_id = ?, roblox_membership_id = ?, sync_status = 'synced', last_synced_at = ?
         WHERE id = ?`
      )
        .bind(matchedRank.id, currentRoleId, membershipIdFromPath(membership.path), now(), member.id)
        .run();

      await env.DB.prepare(
        `INSERT INTO rank_changes (id, org_id, staff_id, from_rank_id, to_rank_id, changed_by_staff_id, reason)
         VALUES (?, ?, ?, ?, ?, NULL, 'group_sync: role change detected')`
      )
        .bind(crypto.randomUUID(), org.id, member.id, member.rank_id, matchedRank.id)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE staff_members
         SET last_group_rank_id = ?, roblox_membership_id = ?, sync_status = 'synced', last_synced_at = ?
         WHERE id = ?`
      )
        .bind(currentRoleId, membershipIdFromPath(membership.path), now(), member.id)
        .run();
    }
  }
}

/** Full sync for one org. Called on a Cron Trigger (fallback) and from the manual "sync now" button. */
export async function syncOrgGroup(env: Env, org: Org) {
  const apiKey = await getOrgApiKey(env, org); // throws MissingApiKeyError if unset
  await discoverFromMappedRanks(env, org, apiKey);
  await reconcileExistingStaff(env, org, apiKey);
}

/** Instant/"push" sync for a single staff member -- call right after any RoarAdmin
 * action that changes someone's Roblox group rank, so the record doesn't wait for
 * the next Cron tick. */
export async function syncSingleStaffMember(env: Env, org: Org, staffId: string) {
  const member = await env.DB.prepare("SELECT * FROM staff_members WHERE id = ? AND org_id = ?")
    .bind(staffId, org.id)
    .first<StaffMember>();
  if (!member || member.rank_override) return;

  const apiKey = await getOrgApiKey(env, org);
  const ranks = await getMappedRanks(env, org.id);
  const rankByRobloxId = new Map(ranks.map((r) => [r.roblox_rank_id, r]));

  const membership = await findMembershipForUser(apiKey, org.roblox_group_id, member.roblox_user_id);

  if (!membership) {
    await env.DB.prepare(
      "UPDATE staff_members SET sync_status = 'left_group', last_synced_at = ? WHERE id = ?"
    )
      .bind(now(), member.id)
      .run();
    return;
  }

  const currentRoleId = Number(roleIdFromPath(membership.role));
  const matchedRank = rankByRobloxId.get(currentRoleId);

  if (!matchedRank) {
    await env.DB.prepare(
      `UPDATE staff_members
       SET last_group_rank_id = ?, roblox_membership_id = ?, sync_status = 'unmapped', last_synced_at = ?
       WHERE id = ?`
    )
      .bind(currentRoleId, membershipIdFromPath(membership.path), now(), member.id)
      .run();
    return;
  }

  await env.DB.prepare(
    `UPDATE staff_members
     SET rank_id = ?, last_group_rank_id = ?, roblox_membership_id = ?, sync_status = 'synced', last_synced_at = ?
     WHERE id = ?`
  )
    .bind(matchedRank.id, currentRoleId, membershipIdFromPath(membership.path), now(), member.id)
    .run();
}

export { OpenCloudError };
