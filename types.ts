export interface Env {
  DB: D1Database;
  PERMS_CACHE: KVNamespace;
  GAME_LINK: DurableObjectNamespace;
  ENVIRONMENT: string;
}

// Hono context variable bag — lets c.get("game") / c.set("game", ...) type-check
// without a cast at every call site.
export interface AppVariables {
  game: Game;
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
  status: string;
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
