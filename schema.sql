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
  status        TEXT NOT NULL DEFAULT 'active', -- active | loa | suspended | terminated
  joined_staff_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(org_id, roblox_user_id)
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
