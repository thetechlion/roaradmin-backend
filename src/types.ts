export interface Env {
  DB: D1Database;
  PERMS_CACHE: KVNamespace;
  GAME_LINK: DurableObjectNamespace;
  ENVIRONMENT: string;

  // Dashboard (Pages) origin, for CORS -- e.g. https://roaradmin.pages.dev
  DASHBOARD_ORIGIN: string;

  SESSION_SECRET: string;   // wrangler secret -- signs dashboard session tokens
  ENCRYPTION_KEY: string;   // wrangler secret -- encrypts stored org API keys
}

// Hono context variable bag — lets c.get("game") / c.set("game", ...) type-check
// without a cast at every call site.
export interface AppVariables {
  game: Game;
  session: StaffSessionContext;
}

export interface Game {
  id: string;
  org_id: string;
  name: string;
  roblox_universe_id: number;
  roblox_place_id: number | null;
  api_key_hash: string;
}

export interface StaffMember {
  id: string;
  org_id: string;
  roblox_user_id: number;
  roblox_username: string;
  discord_user_id: string | null;
  rank_id: string | null;
  rank_override: number; // sqlite boolean (0/1)
  is_org_owner: number; // sqlite boolean (0/1)
  status: string;
  last_group_rank_id: number | null;
  roblox_membership_id: string | null;
  sync_status: "synced" | "unmapped" | "left_group";
  last_synced_at: number | null;
}

export interface Org {
  id: string;
  name: string;
  roblox_group_id: number;
  discord_guild_id: string | null;
}

export interface OrgRobloxCredential {
  org_id: string;
  api_key_ciphertext: string;
  api_key_iv: string;
  added_by_staff_id: string | null;
  last_validated_at: number | null;
  last_validation_ok: number | null;
}
export interface UserAccount {
  id: string;
  roblox_user_id: number;
  roblox_username: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  created_at: number;
  last_login_at: number | null;
}

export interface PendingSignup {
  roblox_user_id: number;
  roblox_username: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  verification_token: string;
  expires_at: number;
  created_at: number;
}

// Extends AppVariables below once a request has passed requireStaffSession.
export interface StaffSessionContext {
  staffMemberId: string;
  orgId: string;
  robloxUserId: number;
}

export interface Rank {
  id: string;
  org_id: string;
  name: string;
  roblox_rank_id: number | null;
  priority: number;
  permissions: string; // JSON-encoded string[]
  color: string | null;
}

export interface QueuedCommand {
  id: string;
  game_id: string;
  command: string;
  args: string; // JSON
  issued_by_staff_id: string | null;
  status: "pending" | "delivered" | "failed";
  created_at: number;
}
