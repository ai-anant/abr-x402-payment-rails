-- Settlement ledger (replaces var/settlements.jsonl). One row per settle outcome.
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('payment_settled', 'payment_settlement_failed')),
  method TEXT,
  path TEXT,
  phase TEXT,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  transaction_id TEXT,
  error TEXT,
  source TEXT NOT NULL,
  raw TEXT NOT NULL
);

-- A transaction settles once; re-imports and retries are no-ops.
CREATE UNIQUE INDEX IF NOT EXISTS settlements_tx_event
  ON settlements (transaction_id, event)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS settlements_occurred_at ON settlements (occurred_at);
