-- Real owner names, so DERIK can resolve "who did Chad trade with" the same
-- way as "who did Seal Team Nix trade with" — team names change constantly,
-- the person behind a franchise doesn't. Provided by the commissioner.
CREATE TABLE franchise_owners (
  franchise_id INTEGER PRIMARY KEY REFERENCES franchises(franchise_id),
  owner_name TEXT NOT NULL
);

INSERT INTO franchise_owners (franchise_id, owner_name) VALUES
(116239, 'Logan'),
(116240, 'Kyle'),
(116241, 'Jackie'),
(116242, 'Goon (Adam)'),
(116243, 'TJ'),
(116244, 'Patrick'),
(116245, 'Baker'),
(116246, 'Joren'),
(116247, 'Keillor'),
(116248, 'Moran'),
(116249, 'Ashleigh'),
(116250, 'Jake'),
(116251, 'Chad'),
(116252, 'Sara');
