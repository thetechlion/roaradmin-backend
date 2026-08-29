-- RoarAdmin D1 schema
-- One "org" = one community/Roblox group. An org can have multiple games (Bloxstreet, Frappe, etc.)
-- running the same permission/rank/session system.

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────
-- Orgs & Games
-- ─────────────────────────────────────────────

CREATE TABLE orgs (
  id            TEXT PRIMARY KEY,           -- uuid
  name          TEXT NOT NULL,
  roblox_group_id INTEGER NOT NULL,         -- the synced Roblox group
  discord_guild_id TEXT,                    -- linked Discord server
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE games (
  id            TEXT PRIMARY KEY,           -- uuid
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,              -- e.g. "Bloxstreet"
  roblox_universe_id INTEGER NOT NULL,
  roblox_place_id INTEGER,
  api_key_hash  TEXT NOT NULL,              -- hashed key the Studio module authenticates with
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─────────────────────────────────────────────
-- Staff / Permissions (synced from the Roblox group, with local overrides)
-- ─────────────────────────────────────────────

CREATE TABLE ranks (
  id            TEXT PRIMARY KEY,           -- uuid
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,              -- e.g. "Head Moderator"
  roblox_rank_id INTEGER,                   -- numeric group rank this maps to (nullable = custom, non-group rank)
  priority      INTEGER NOT NULL,           -- higher = more authority, used for command gating & promotion ceilings
  permissions   TEXT NOT NULL DEFAULT '[]', -- JSON array of permission strings, e.g. ["kick","ban","promote","session:host"]
  color         TEXT,                       -- dashboard/discord embed color
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE staff_members (
  id            TEXT PRIMARY KEY,           -- uuid
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  roblox_user_id INTEGER NOT NULL,
  roblox_username TEXT NOT NULL,
  discord_user_id TEXT,
  rank_id       TEXT REFERENCES ranks(id),
  rank_override BOOLEAN NOT NULL DEFAULT 0, -- true = don't auto-resync this user's rank from the group
  is_org_owner  BOOLEAN NOT NULL DEFAULT 0, -- Roblox group owner (rank 255); implicit full dashboard access
  status        TEXT NOT NULL DEFAULT 'active', -- active | loa | suspended | terminated
  joined_staff_at INTEGER NOT NULL DEFAULT (unixepoch()),
  -- Group-sync bookkeeping. A user stays on their last known local `rank_id`
  -- until an admin resolves an unmapped group rank -- we never silently
  -- desync someone's permissions.
  last_group_rank_id INTEGER,               -- most recent Roblox group role id seen for this user
  roblox_membership_id TEXT,                -- Open Cloud v2 "memberships/{id}" resource id, cached for writes
  sync_status   TEXT NOT NULL DEFAULT 'synced', -- synced | unmapped | left_group
  last_synced_at INTEGER,
  UNIQUE(org_id, roblox_user_id)
);

-- ─────────────────────────────────────────────
-- RoarAdmin login accounts (username + password, verified via a one-time
-- code placed in the user's Roblox profile description). Separate from
-- staff_members: an account is "who can log in", staff_members is "what
-- org(s) they belong to and at what rank".
-- ─────────────────────────────────────────────

CREATE TABLE user_accounts (
  id            TEXT PRIMARY KEY,           -- uuid
  roblox_user_id INTEGER NOT NULL UNIQUE,
  roblox_username TEXT NOT NULL,            -- most recently seen username, for display/login-by-username
  password_salt TEXT NOT NULL,              -- base64
  password_hash TEXT NOT NULL,              -- base64
  password_iterations INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login_at INTEGER
);

-- Deliberately NOT in user_accounts until verification succeeds -- per spec,
-- an unverified signup attempt must not exist "in the records" yet. One row
-- per in-progress signup; a repeat signup attempt for the same Roblox user
-- overwrites their previous pending attempt.
CREATE TABLE pending_signups (
  roblox_user_id INTEGER PRIMARY KEY,
  roblox_username TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  verification_token TEXT NOT NULL,         -- "RA-1234ABCD"
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
-- ─────────────────────────────────────────────
-- Roblox Open Cloud API key per org, used to write group-rank changes
-- (promotions/demotions) and to read group membership under the group
-- member-list privacy setting. Encrypted at rest -- see src/crypto.ts.
-- ─────────────────────────────────────────────

CREATE TABLE org_roblox_credentials (
  org_id        TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  api_key_ciphertext TEXT NOT NULL,         -- base64 AES-GCM ciphertext
  api_key_iv    TEXT NOT NULL,              -- base64 IV used for the above
  added_by_staff_id TEXT REFERENCES staff_members(id),
  last_validated_at INTEGER,
  last_validation_ok BOOLEAN,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─────────────────────────────────────────────
-- Moderation log (bans/kicks/warns, shared across an org's games)
-- ─────────────────────────────────────────────

CREATE TABLE moderation_actions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  game_id       TEXT REFERENCES games(id),
  action_type   TEXT NOT NULL,              -- kick | ban | unban | warn | mute
  target_roblox_user_id INTEGER NOT NULL,
  target_username TEXT NOT NULL,
  issued_by_staff_id TEXT NOT NULL REFERENCES staff_members(id),
  reason        TEXT,
  duration_seconds INTEGER,                 -- null = permanent
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at    INTEGER
);

-- ─────────────────────────────────────────────
-- Promotion/demotion history
-- ─────────────────────────────────────────────

CREATE TABLE rank_changes (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  staff_id      TEXT NOT NULL REFERENCES staff_members(id),
  from_rank_id  TEXT REFERENCES ranks(id),
  to_rank_id    TEXT REFERENCES ranks(id),
  changed_by_staff_id TEXT REFERENCES staff_members(id), -- null if automated/group-synced
  reason        TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─────────────────────────────────────────────
-- Sessions (scheduled RP/training/patrol events)
-- ─────────────────────────────────────────────

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  game_id       TEXT REFERENCES games(id),
  session_type  TEXT NOT NULL,              -- training | patrol | shift | event
  hosted_by_staff_id TEXT NOT NULL REFERENCES staff_members(id),
  scheduled_start INTEGER NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  status        TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | ended | cancelled
  discord_event_id TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE session_attendance (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  staff_id      TEXT NOT NULL REFERENCES staff_members(id),
  rsvp_status   TEXT DEFAULT 'none',         -- none | going | maybe | declined
  clocked_in_at INTEGER,
  clocked_out_at INTEGER
);

-- ─────────────────────────────────────────────
-- Passive in-game time tracking (playtime while on-duty per rank/department)
-- ─────────────────────────────────────────────

CREATE TABLE time_logs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  game_id       TEXT NOT NULL REFERENCES games(id),
  staff_id      TEXT NOT NULL REFERENCES staff_members(id),
  joined_at     INTEGER NOT NULL,
  left_at       INTEGER,
  duration_seconds INTEGER
);

-- ─────────────────────────────────────────────
-- Command queue (dashboard/Discord -> game). The Roblox module polls or
-- receives push via a Durable Object and marks these consumed.
-- ─────────────────────────────────────────────

CREATE TABLE command_queue (
  id            TEXT PRIMARY KEY,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  command       TEXT NOT NULL,              -- e.g. "kick", "teleport", "announce"
  args          TEXT NOT NULL DEFAULT '{}', -- JSON payload
  issued_by_staff_id TEXT REFERENCES staff_members(id),
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  delivered_at  INTEGER
);

CREATE INDEX idx_staff_org ON staff_members(org_id);
CREATE INDEX idx_mod_actions_org ON moderation_actions(org_id, target_roblox_user_id);
CREATE INDEX idx_time_logs_staff ON time_logs(staff_id, game_id);
CREATE INDEX idx_command_queue_pending ON command_queue(game_id, status);
