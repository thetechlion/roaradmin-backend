// Thin wrapper around Roblox's public Groups API (groups.roblox.com).
// These endpoints are unauthenticated for reads on public groups.

const BASE = "https://groups.roblox.com";

export interface RobloxGroupRole {
  id: number;
  name: string;
  rank: number; // 0-255, the "priority" number staff configure in Roblox
  memberCount: number;
}

export interface RobloxGroupMember {
  userId: number;
  username: string;
}

export interface RobloxUserGroupRole {
  group: { id: number; name: string };
  role: { id: number; name: string; rank: number };
}

async function robloxGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Roblox API ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json<T>();
}

export async function getGroupRoles(groupId: number): Promise<RobloxGroupRole[]> {
  const data = await robloxGet<{ roles: RobloxGroupRole[] }>(`/v1/groups/${groupId}/roles`);
  return data.roles;
}

/** Paginated list of every user currently holding a given role. */
export async function* iterateUsersInRole(
  groupId: number,
  roleId: number
): AsyncGenerator<RobloxGroupMember> {
  let cursor = "";
  while (true) {
    const qs = new URLSearchParams({ limit: "100", sortOrder: "Asc" });
    if (cursor) qs.set("cursor", cursor);

    const data = await robloxGet<{
      previousPageCursor: string | null;
      nextPageCursor: string | null;
      data: { userId: number; username: string }[];
    }>(`/v1/groups/${groupId}/roles/${roleId}/users?${qs.toString()}`);

    for (const u of data.data) {
      yield { userId: u.userId, username: u.username };
    }

    if (!data.nextPageCursor) break;
    cursor = data.nextPageCursor;
  }
}

/** Look up one user's current role in one specific group, or null if they've left it. */
export async function getUserRoleInGroup(
  userId: number,
  groupId: number
): Promise<RobloxUserGroupRole | null> {
  const data = await robloxGet<{ data: RobloxUserGroupRole[] }>(
    `/v1/users/${userId}/groups/roles`
  );
  return data.data.find((g) => g.group.id === groupId) ?? null;
}
