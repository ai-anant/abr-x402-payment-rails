-- Claims index: the queryable side of claims (code lookup, disputes, funnel). The
-- authoritative state machine lives in one Durable Object per claim.
CREATE TABLE IF NOT EXISTS claims_index (
  claim_id TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  checks TEXT NOT NULL,
  total_checks INTEGER NOT NULL,
  price_atomic TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  transaction_id TEXT,
  payer TEXT,
  acked_at TEXT,
  client_name TEXT,
  client_version TEXT
);
CREATE INDEX IF NOT EXISTS claims_index_tx ON claims_index (transaction_id);
CREATE INDEX IF NOT EXISTS claims_index_created ON claims_index (created_at);

-- Settlement rows say what was bought and by whom.
ALTER TABLE settlements ADD COLUMN claim_id TEXT;
ALTER TABLE settlements ADD COLUMN checks TEXT;
ALTER TABLE settlements ADD COLUMN payer TEXT;
