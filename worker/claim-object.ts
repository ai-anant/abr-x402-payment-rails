import { DurableObject } from "cloudflare:workers";

import {
  ack,
  effectiveState,
  markPaid,
  purgeAt,
  recordFetch,
  release,
  reservationHeld,
  reserve,
  type ClaimRecord,
  type PayabilityError,
} from "../src/claims.js";
import type { ClaimStore } from "./claim-store.js";

const KEY = "claim";

// One Durable Object per claim. Workers runs a DO's methods one at a time with
// transactional storage, so check-and-set operations (reserve, markPaid) can't
// interleave between concurrent payers. An alarm expires unpaid claims and purges the
// record once its retention ends.
export class ClaimObject extends DurableObject {
  private async load(): Promise<ClaimRecord | null> {
    return (await this.ctx.storage.get<ClaimRecord>(KEY)) ?? null;
  }

  private async save(record: ClaimRecord): Promise<void> {
    await this.ctx.storage.put(KEY, record);
    const nextAlarm = effectiveState(record, Date.now()) === "created" ? record.expiresAt : purgeAt(record);
    await this.ctx.storage.setAlarm(nextAlarm);
  }

  async create(record: ClaimRecord): Promise<void> {
    if (await this.load()) throw new Error("claim collision");
    await this.save(record);
  }

  async read(): Promise<ClaimRecord | null> {
    return this.load();
  }

  async reserve(now: number, token: string): Promise<{ ok: true } | { ok: false; error: PayabilityError | "claim_not_found" }> {
    const record = await this.load();
    if (!record) return { ok: false, error: "claim_not_found" };
    const result = reserve(record, now, token);
    if (!result.ok) return result;
    await this.save(result.record);
    return { ok: true };
  }

  async reservationHeld(now: number, token: string): Promise<boolean> {
    const record = await this.load();
    return Boolean(record && reservationHeld(record, now, token));
  }

  async release(token: string): Promise<void> {
    const record = await this.load();
    if (record) await this.save(release(record, token));
  }

  async markPaid(now: number, transactionId: string, payer?: string): Promise<ClaimRecord | null> {
    const record = await this.load();
    if (!record) return null;
    const next = markPaid(record, now, transactionId, payer);
    await this.save(next);
    return next;
  }

  async recordFetch(now: number): Promise<void> {
    const record = await this.load();
    if (record) await this.save(recordFetch(record, now));
  }

  async ack(now: number): Promise<ClaimRecord | null> {
    const record = await this.load();
    if (!record) return null;
    const next = ack(record, now);
    await this.save(next);
    return next;
  }

  override async alarm(): Promise<void> {
    const record = await this.load();
    if (!record) return;
    const now = Date.now();
    if (now >= purgeAt(record)) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (record.state === "created" && now >= record.expiresAt) {
      await this.save({ ...record, state: "expired" });
      return;
    }
    await this.ctx.storage.setAlarm(purgeAt(record));
  }
}

const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

/** ClaimStore over Durable Objects, with a D1 index for user-code lookup and reporting. */
export class DurableClaimStore implements ClaimStore {
  constructor(
    private readonly namespace: DurableObjectNamespace<ClaimObject>,
    private readonly db: D1Database,
  ) {}

  private stub(id: string) {
    return this.namespace.get(this.namespace.idFromName(id));
  }

  private async index(record: ClaimRecord | null): Promise<void> {
    if (!record) return;
    try {
      await this.db
        .prepare(
          `INSERT INTO claims_index
             (claim_id, user_code, state, checks, total_checks, price_atomic, created_at, expires_at,
              paid_at, transaction_id, payer, acked_at, client_name, client_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (claim_id) DO UPDATE SET
             state = excluded.state, paid_at = excluded.paid_at,
             transaction_id = excluded.transaction_id, payer = excluded.payer,
             acked_at = excluded.acked_at`,
        )
        .bind(
          record.id,
          record.userCode,
          record.state,
          JSON.stringify(record.checks),
          record.totalChecks,
          record.priceAtomic,
          iso(record.createdAt),
          iso(record.expiresAt),
          iso(record.paidAt),
          record.transactionId ?? null,
          record.payer ?? null,
          iso(record.ackedAt),
          record.clientName ?? null,
          record.clientVersion ?? null,
        )
        .run();
    } catch (error) {
      // The Durable Object is authoritative; a lagging index only affects reporting.
      console.error("claims_index write failed", error instanceof Error ? error.message : error);
    }
  }

  async create(record: ClaimRecord): Promise<void> {
    // Reserve the user code in the index first: its UNIQUE constraint makes collisions fail fast.
    await this.db
      .prepare(
        `INSERT INTO claims_index (claim_id, user_code, state, checks, total_checks, price_atomic, created_at, expires_at, client_name, client_version)
         VALUES (?, ?, 'created', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.userCode,
        JSON.stringify(record.checks),
        record.totalChecks,
        record.priceAtomic,
        iso(record.createdAt),
        iso(record.expiresAt),
        record.clientName ?? null,
        record.clientVersion ?? null,
      )
      .run();
    await this.stub(record.id).create(record);
  }

  async get(id: string): Promise<ClaimRecord | null> {
    return this.stub(id).read();
  }

  async idForUserCode(userCode: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT claim_id FROM claims_index WHERE user_code = ?")
      .bind(userCode)
      .first<{ claim_id: string }>();
    return row?.claim_id ?? null;
  }

  reserve(id: string, now: number, token: string) {
    return this.stub(id).reserve(now, token);
  }

  reservationHeld(id: string, now: number, token: string) {
    return this.stub(id).reservationHeld(now, token);
  }

  async release(id: string, token: string): Promise<void> {
    await this.stub(id).release(token);
  }

  async markPaid(id: string, now: number, transactionId: string, payer?: string) {
    const record = await this.stub(id).markPaid(now, transactionId, payer);
    await this.index(record);
    return record;
  }

  async recordFetch(id: string, now: number): Promise<void> {
    await this.stub(id).recordFetch(now);
  }

  async ack(id: string, now: number) {
    const record = await this.stub(id).ack(now);
    await this.index(record);
    return record;
  }
}
