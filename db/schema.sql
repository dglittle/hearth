-- card-board schema (design: work/card-board/design.md §1)
-- Applied once at db creation by tools/card.js (auto-init) — WAL is persistent;
-- busy_timeout + foreign_keys are per-connection and set by card.js on open.

PRAGMA journal_mode = WAL;

CREATE TABLE cards (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,       -- 'mind'|'short-term'|'long-term'|'human'|'{{AGENT_NAME}}'|'erg'|'header'
  title       TEXT NOT NULL DEFAULT '',  -- one line, OPTIONAL (the operator 2026-07-28); '' = untitled
  body        TEXT NOT NULL DEFAULT '',   -- markdown
  status      TEXT NOT NULL DEFAULT 'draft',
    -- 'draft'    : live — the only pre-done state ('ready' retired 2026-07-28: all ergs explicit)
    -- 'done'     : work complete; kept for chain history
    -- 'archived' : swept off the board
  x REAL, y REAL, w REAL DEFAULT 240, h REAL DEFAULT 96,  -- board geometry; NULL x/y = auto-place
  importance  INTEGER,             -- 1-10 (old priority line)
  urgency     INTEGER,
  url         TEXT,                -- optional ↗ link (Jira/Slack/GH)
  created_by  TEXT NOT NULL,       -- 'operator' | 'erg:<erg_id>'
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  lock_erg    INTEGER REFERENCES ergs(id),  -- advisory work-lock holder (NULL = free)
  lock_at     TEXT                          -- for stale-lock reaping
);
CREATE INDEX idx_cards_kind   ON cards(kind);
CREATE INDEX idx_cards_status ON cards(status);
CREATE INDEX idx_cards_lock   ON cards(lock_erg) WHERE lock_erg IS NOT NULL;

CREATE TABLE links (                -- DAG, multi-parent
  parent INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  child  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind   TEXT NOT NULL DEFAULT 'child',   -- 'child' = continuation/chain; 'ref' = see-also (dashed)
  PRIMARY KEY (parent, child)
);
CREATE INDEX idx_links_child ON links(child);

CREATE TABLE ergs (
  id          INTEGER PRIMARY KEY,
  mode        TEXT NOT NULL,        -- 'generic' | 'targeted'
  target_card INTEGER REFERENCES cards(id),  -- targeted mode only
  info_card   INTEGER REFERENCES cards(id),  -- the in-flight kind='erg' card
  pid         INTEGER,              -- claude -p process, for liveness checks
  status      TEXT NOT NULL DEFAULT 'running',  -- 'running'|'done'|'failed'
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  result      TEXT,                 -- the DONE line
  sid         TEXT                  -- claude session id (warm-resume, card #756)
);

CREATE TABLE costs (                -- the claude-p cost log
  erg_id        INTEGER PRIMARY KEY REFERENCES ergs(id),
  wall_seconds  REAL,
  model         TEXT,
  input_tokens  INTEGER, output_tokens INTEGER,
  cache_read    INTEGER, cache_write  INTEGER,
  usd           REAL                -- total_cost_usd from claude -p --output-format json
);

CREATE TABLE acts (                 -- operator's UI actions, append-only (audit + replay)
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL
);
