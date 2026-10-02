import type { SettlementAuditEvent, SettlementAuditSink } from "../src/audit.js";

// Settlement ledger in D1. Same event shape as the JSONL sink; the full event is also
// kept verbatim in `raw` so nothing is lost if columns evolve.
export class D1SettlementSink implements SettlementAuditSink {
  constructor(private readonly db: D1Database) {}

  async record(event: SettlementAuditEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO settlements
           (occurred_at, event, method, path, phase, network, asset, amount_atomic, pay_to,
            transaction_id, error, source, raw, claim_id, checks, payer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', ?, ?, ?, ?)`,
      )
      .bind(
        event.occurredAt,
        event.event,
        event.method ?? null,
        event.path ?? null,
        event.phase,
        event.network,
        event.asset,
        event.amountAtomic,
        event.payTo,
        event.transactionId ?? null,
        event.error ?? null,
        JSON.stringify(event),
        event.claimId ?? null,
        event.checks ?? null,
        event.payer ?? null,
      )
      .run();
  }
}
