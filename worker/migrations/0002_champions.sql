-- Authoritative season champions. For 2013-2024 this matches both
-- games.is_championship and LeagueLegacy's own record-book "Season
-- Champions" table. For 2025, LeagueLegacy's record-book table is wrong
-- (it credits The SHIELD, who actually lost their week-15 playoff game) —
-- their History page even carries a "League data is updating in the
-- background" banner. The real 2025 champion, confirmed by tracing the
-- actual bracket in `games` (won wk15 vs Surfin' Loons, wk16 vs Flying
-- Kites, wk17 championship 136.94-122.94 vs Seal Team Nix) and confirmed
-- by the commissioner: Jack of All Trades (116241).
CREATE TABLE season_champions (
  season INTEGER PRIMARY KEY,
  franchise_id INTEGER NOT NULL REFERENCES franchises(franchise_id)
);

INSERT INTO season_champions (season, franchise_id) VALUES
(2013, 116241),
(2014, 116250),
(2015, 116246),
(2016, 116239),
(2017, 116247),
(2018, 116245),
(2019, 116242),
(2020, 116239),
(2021, 116241),
(2022, 116244),
(2023, 116249),
(2024, 116241),
(2025, 116241);
