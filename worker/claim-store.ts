import {
  ack,
  markPaid,
  recordFetch,
  release,
  reservationHeld,
  reserve,
  type ClaimRecord,
  type PayabilityError,
} from "../src/claims.js";

// Every mutation is one atomic operation on one claim. In production each claim is a
// Durable Object (single-threaded, transactional storage); MemoryClaimStore gives tests
// and local runs the same semantics.
export interface ClaimStore {
  create(record: ClaimRecord): Promise<void>;
  get(id: string): Promise<ClaimRecord | null>;
  idForUserCode(userCode: string): Promise<string | null>;
  reserve(id: string, now: number, token: string): Promise<{ ok: true } | { ok: false; error: PayabilityError | "claim_not_found" }>;
  reservationHeld(id: string, now: number, token: string): Promise<boolean>;
  release(id: string, token: string): Promise<void>;
  markPaid(id: string, now: number, transactionId: string, payer?: string): Promise<ClaimRecord | null>;
  recordFetch(id: string, now: number): Promise<void>;
  ack(id: string, now: number): Promise<ClaimRecord | null>;
}

export class MemoryClaimStore implements ClaimStore {
  readonly records = new Map<string, ClaimRecord>();
  private readonly codes = new Map<string, string>();

  async create(record: ClaimRecord): Promise<void> {
    if (this.records.has(record.id) || this.codes.has(record.userCode)) throw new Error("claim collision");
    this.records.set(record.id, record);
    this.codes.set(record.userCode, record.id);
  }

  async get(id: string): Promise<ClaimRecord | null> {
    return this.records.get(id) ?? null;
  }

  async idForUserCode(userCode: string): Promise<string | null> {
    return this.codes.get(userCode) ?? null;
  }

  async reserve(id: string, now: number, token: string) {
    const record = this.records.get(id);
    if (!record) return { ok: false as const, error: "claim_not_found" as const };
    const result = reserve(record, now, token);
    if (!result.ok) return result;
    this.records.set(id, result.record);
    return { ok: true as const };
  }

  async reservationHeld(id: string, now: number, token: string): Promise<boolean> {
    const record = this.records.get(id);
    return Boolean(record && reservationHeld(record, now, token));
  }

  async release(id: string, token: string): Promise<void> {
    const record = this.records.get(id);
    if (record) this.records.set(id, release(record, token));
  }

  async markPaid(id: string, now: number, transactionId: string, payer?: string) {
    const record = this.records.get(id);
    if (!record) return null;
    const next = markPaid(record, now, transactionId, payer);
    this.records.set(id, next);
    return next;
  }

  async recordFetch(id: string, now: number): Promise<void> {
    const record = this.records.get(id);
    if (record) this.records.set(id, recordFetch(record, now));
  }

  async ack(id: string, now: number) {
    const record = this.records.get(id);
    if (!record) return null;
    const next = ack(record, now);
    this.records.set(id, next);
    return next;
  }
}
