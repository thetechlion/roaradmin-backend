// Thin wrapper around Roblox's public Users API (users.roblox.com) and the
// legacy Groups API's "my groups" endpoint. All unauthenticated, all
// self/username-scoped lookups -- not affected by the group member-list
// privacy change (see src/openCloudGroups.ts for that).

export async function resolveUsernameToId(username: string): Promise<{ id: number; name: string } | null> {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  if (!res.ok) {
    throw new Error(`Roblox username lookup failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json<{ data: { id: number; name: string }[] }>();
  return data.data[0] ?? null;
}

export async function getUserBio(userId: number): Promise<string> {
  const res = await fetch(`https://users.roblox.com/v1/users/${userId}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Roblox user profile fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json<{ description?: string }>();
  return data.description ?? "";
}

/**
 * A user's groups + their role in each. Self-scoped (a user's own
 * memberships, looked up by their own id), used to populate "which of your
 * groups do you want to set up?" after login.
 */
export async function getUserGroupRoles(
  robloxUserId: number
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
