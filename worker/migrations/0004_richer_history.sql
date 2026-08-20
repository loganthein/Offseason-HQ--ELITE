-- Replaces the thin draft_picks/transactions data with a richer import that
-- captures: which draft picks were acquired via trade (and from whom), and
-- full multi-item trade detail (including draft-pick-for-player and
-- pick-for-pick trades) instead of just a top-level player_added/dropped
-- pair that was empty for a meaningful share of real trades.
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS draft_picks;

CREATE TABLE draft_picks (
  season INTEGER NOT NULL,
  round INTEGER NOT NULL,
  pick_in_round INTEGER NOT NULL,
  is_keeper INTEGER NOT NULL DEFAULT 0,
  from_trade INTEGER NOT NULL DEFAULT 0,
  original_franchise_id INTEGER REFERENCES franchises(franchise_id),
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
  trade_partner_franchise_id INTEGER REFERENCES franchises(franchise_id),
  faab_bid REAL,
  value REAL
);
CREATE INDEX idx_tx_season ON transactions(season);
CREATE INDEX idx_tx_franchise ON transactions(franchise_id);

-- One row per player or pick moved in a transaction. A trade generates a
-- transaction_items row per asset moved; a simple waiver add/drop generates
-- one 'gain' and/or one 'loss' row.
CREATE TABLE transaction_items (
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(transaction_id),
  direction TEXT NOT NULL,
  item_type TEXT NOT NULL,
  player_name TEXT,
  position TEXT,
  pick_round INTEGER,
  pick_season INTEGER,
  pick_original_franchise_id INTEGER REFERENCES franchises(franchise_id)
);
CREATE INDEX idx_txitems_tx ON transaction_items(transaction_id);
