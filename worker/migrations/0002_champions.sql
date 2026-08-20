-- Authoritative season champions, sourced from LeagueLegacy's own Season
-- Champions record-book table (leaguelegacy.io/.../history), not inferred
-- from games.is_championship — that flag turned out unset for 2025, and
-- LeagueLegacy's own site displays a data-inconsistency for that season
-- (matchup results show The SHIELD losing its week-15 playoff game, while
-- their record book credits them as 2025 champion; their History page
-- itself carries a "League data is updating in the background" banner).
-- Every other season (2013-2024) matches games.is_championship exactly.
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
(2025, 116239);
