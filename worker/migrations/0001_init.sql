-- Canonical franchise = a persistent team lineage across name changes and
-- across the LeagueLegacy/MFL platform migration. franchise_id is
-- LeagueLegacy's own stable league_member_id (116239-116252), which also
-- maps onto MFL franchise ids via a fixed offset: mfl_id = franchise_id - 116238.
CREATE TABLE franchises (
  franchise_id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL
);

-- The name a franchise used in a given season (teams rename constantly).
CREATE TABLE franchise_names (
  franchise_id INTEGER NOT NULL REFERENCES franchises(franchise_id),
  season INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (franchise_id, season)
);

CREATE TABLE games (
  game_id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  is_playoff INTEGER NOT NULL DEFAULT 0,
  is_championship INTEGER NOT NULL DEFAULT 0,
  home_franchise_id INTEGER NOT NULL REFERENCES franchises(franchise_id),
  away_franchise_id INTEGER NOT NULL REFERENCES franchises(franchise_id),
  home_score REAL NOT NULL,
  away_score REAL NOT NULL,
  home_coach_score REAL,
  away_coach_score REAL,
  home_luck REAL,
  away_luck REAL
);
CREATE INDEX idx_games_season_week ON games(season, week);
CREATE INDEX idx_games_home ON games(home_franchise_id);
CREATE INDEX idx_games_away ON games(away_franchise_id);

CREATE TABLE draft_picks (
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  pick_in_round INTEGER NOT NULL,
  is_keeper INTEGER NOT NULL DEFAULT 0,
  franchise_id INTEGER NOT NULL REFERENCES franchises(franchise_id),
  player_name TEXT,
  position TEXT,
  value REAL,
  PRIMARY KEY (season, round, pick_in_round)
);
CREATE INDEX idx_draft_season ON draft_picks(season);
CREATE INDEX idx_draft_franchise ON draft_picks(franchise_id);

CREATE TABLE transactions (
  transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  week INTEGER,
  ts TEXT,
  franchise_id INTEGER NOT NULL REFERENCES franchises(franchise_id),
  type TEXT NOT NULL,
  player_added TEXT,
  value_added REAL,
  player_dropped TEXT,
  value_dropped REAL,
  faab_bid REAL
);
CREATE INDEX idx_tx_season ON transactions(season);
CREATE INDEX idx_tx_franchise ON transactions(franchise_id);
