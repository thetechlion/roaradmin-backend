// Authenticated client for the Open Cloud v2 Groups API (apis.roblox.com/cloud/v2).
// This is still a Beta API on Roblox's side -- endpoints and the exact filter
// syntax below are the best-documented shape as of this writing. If Roblox
// changes the beta contract, this is the one file that needs updating.
//
// Every call here is authenticated with the *org's* API key (an Open Cloud
// key created by the group owner), not a RoarAdmin-wide credential -- each
// group's data stays scoped to a key that group's owner controls and can
// revoke at any time.

const BASE = "https://apis.roblox.com/cloud/v2";

export class OpenCloudError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function ocFetch<T>(path: string, apiKey: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    // Surface 401/403 distinctly -- these almost always mean the stored key
    // is missing a required scope, so the dashboard can say exactly that
    // instead of a generic "something went wrong".
    throw new OpenCloudError(res.status, await res.text());
  }
  return res.json<T>();
}

export interface OcGroupRole {
  path: string; // "groups/{groupId}/roles/{roleId}"
  id: string;
  displayName: string;
  rank: number;
  memberCount?: number;
}

export interface OcGroupMembership {
  path: string; // "groups/{groupId}/memberships/{membershipId}"
  user: string; // "users/{userId}"
  role: string; // "groups/{groupId}/roles/{roleId}"
}

function membershipIdFromPath(path: string): string {
  return path.split("/").pop()!;
}
function roleIdFromPath(path: string): string {
  return path.split("/").pop()!;
}

export async function getGroupRoles(apiKey: string, groupId: number): Promise<OcGroupRole[]> {
  const roles: OcGroupRole[] = [];
  let pageToken: string | undefined;

  do {
    const qs = new URLSearchParams({ maxPageSize: "100" });
    if (pageToken) qs.set("pageToken", pageToken);

    const data = await ocFetch<{ groupRoles: OcGroupRole[]; nextPageToken?: string }>(
      `/groups/${groupId}/roles?${qs.toString()}`,
      apiKey
    );
    roles.push(...data.groupRoles);
    pageToken = data.nextPageToken;
  } while (pageToken);

  return roles;
}

/**
 * Paginated membership listing, optionally filtered.
 * `filter` uses Roblox's CEL-style filter syntax for v2 List endpoints, e.g.
 *   role == 'groups/12345/roles/67890'
 *   user == 'users/98765'
 * Verify this against current Roblox docs if it starts returning errors --
 * filter support on this specific endpoint is one of the least-documented
 * parts of the v2 Groups API at the time this was written.
 */
export async function* iterateMemberships(
  apiKey: string,
  groupId: number,
  filter?: string
): AsyncGenerator<OcGroupMembership> {
  let pageToken: string | undefined;

  do {
    const qs = new URLSearchParams({ maxPageSize: "100" });
    if (pageToken) qs.set("pageToken", pageToken);
    if (filter) qs.set("filter", filter);

    const data = await ocFetch<{ groupMemberships: OcGroupMembership[]; nextPageToken?: string }>(
      `/groups/${groupId}/memberships?${qs.toString()}`,
      apiKey
    );

    for (const m of data.groupMemberships) yield m;
    pageToken = data.nextPageToken;
  } while (pageToken);
}

/** Find one user's current membership record, or null if they're not a member. */
export async function findMembershipForUser(
  apiKey: string,
  groupId: number,
  robloxUserId: number
): Promise<OcGroupMembership | null> {
  for await (const m of iterateMemberships(apiKey, groupId, `user == 'users/${robloxUserId}'`)) {
    return m; // filtered to exactly this user, so the first result is it
  }
  return null;
}

/**
 * Sets a member's role directly (promotion/demotion/custom rank change).
 * Uses PATCH .../memberships/{id} to overwrite the `role` field. Owner,
 * Member, and Guest roles cannot be assigned this way -- Roblox rejects it.
 */
export async function updateMembershipRole(
  apiKey: string,
  groupId: number,
  membershipId: string,
  newRoleId: string
): Promise<OcGroupMembership> {
  return ocFetch<OcGroupMembership>(`/groups/${groupId}/memberships/${membershipId}`, apiKey, {
    method: "PATCH",
    body: JSON.stringify({ role: `groups/${groupId}/roles/${newRoleId}` }),
  });
}

/** Quick validation call used right after a group owner submits an API key. */
export async function validateApiKey(apiKey: string, groupId: number): Promise<void> {
  await getGroupRoles(apiKey, groupId); // throws OpenCloudError on bad key/scope
}

export { membershipIdFromPath, roleIdFromPath };
