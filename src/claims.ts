// Claims: a short-lived, server-side record that one paid x402 request settles into, so
// the payer (an agent's wallet tool, or a human in a browser) and the collector (the
// blast CLI/MCP, holding a secret) can be different parties. Records hold class counts,
// price and state only — never manifests, secrets in clear, or anything from the scan.
//
// Pure functions over a ClaimRecord; storage (Durable Object, memory) wraps them.

export const CLAIM_PAY_WINDOW_MS = 15 * 60_000;
// Stop accepting payment shortly before expiry so a slow wallet can't pay a dead claim.
export const CLAIM_PAY_CUTOFF_MS = 60_000;
// How long one in-flight payment holds the claim against concurrent payers.
export const CLAIM_RESERVATION_MS = 120_000;
export const CLAIM_COLLECT_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const CLAIM_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const CLAIM_POLL_INTERVAL_SECONDS = 5;
export const SUPPORTED_MANIFEST_SCHEMAS = ["abr.verifier.v1"] as const;

export type ClaimState = "created" | "paid" | "acked" | "expired";

export interface ClaimRecord {
  id: string;
  userCode: string;
  secretSha256: string;
  checks: Record<string, number>;
  totalChecks: number;
  priceAtomic: string;
  payTo: string;
  network: string;
  createdAt: number;
  expiresAt: number;
  state: ClaimState;
  reservedUntil?: number;
  reservationToken?: string;
  paidAt?: number;
  transactionId?: string;
  payer?: string;
  fetchCount: number;
  lastFetchAt?: number;
  ackedAt?: number;
  clientName?: string;
  clientVersion?: string;
}

const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"; // RFC 8628 §6.1: no vowels, no 0/O/1/I
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function randomString(alphabet: string, length: number): string {
  // Rejection sampling keeps every character uniform.
  const out: string[] = [];
  const limit = 256 - (256 % alphabet.length);
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < limit && out.length < length) out.push(alphabet[byte % alphabet.length]!);
    }
  }
  return out.join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function newClaimId(): string {
  return `clm_${randomString(ID_ALPHABET, 26)}`; // ~130 bits
}

export function newClaimSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32))); // 256 bits
}

export function newUserCode(): string {
  const raw = randomString(USER_CODE_ALPHABET, 8);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeUserCode(value: string): string | null {
  const compact = value.toUpperCase().replace(/[^A-Z]/g, "");
  if (compact.length !== 8 || [...compact].some(char => !USER_CODE_ALPHABET.includes(char))) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function isClaimId(value: unknown): value is string {
  return typeof value === "string" && /^clm_[a-z2-7]{26}$/.test(value);
}

export async function secretMatches(record: ClaimRecord, secret: string): Promise<boolean> {
  const candidate = await sha256Hex(secret);
  if (candidate.length !== record.secretSha256.length) return false;
  let diff = 0;
  for (let index = 0; index < candidate.length; index++) {
    diff |= candidate.charCodeAt(index) ^ record.secretSha256.charCodeAt(index);
  }
  return diff === 0;
}

/** The state as of `now`: an unpaid claim past its window is expired. */
export function effectiveState(record: ClaimRecord, now: number): ClaimState {
  if (record.state === "created" && now >= record.expiresAt) return "expired";
  return record.state;
}

export type PayabilityError = "claim_expired" | "claim_already_paid" | "claim_payment_in_progress";

/** Whether a payment may start now. Checked before the 402 and again before verify. */
export function payability(record: ClaimRecord, now: number): PayabilityError | null {
  const state = effectiveState(record, now);
  if (state === "paid" || state === "acked") return "claim_already_paid";
  if (state === "expired" || now >= record.expiresAt - CLAIM_PAY_CUTOFF_MS) return "claim_expired";
  if (record.reservedUntil && record.reservedUntil > now) return "claim_payment_in_progress";
  return null;
}

// One payment attempt holds the claim with its own token, so a failed or refused attempt
// can only ever release its own hold — never another payer's in-flight reservation.
export function reserve(
  record: ClaimRecord,
  now: number,
  token: string,
): { ok: true; record: ClaimRecord } | { ok: false; error: PayabilityError } {
  const error = payability(record, now);
  if (error) return { ok: false, error };
  return { ok: true, record: { ...record, reservedUntil: now + CLAIM_RESERVATION_MS, reservationToken: token } };
}

export function reservationHeld(record: ClaimRecord, now: number, token: string): boolean {
  return (
    record.state === "created" &&
    record.reservationToken === token &&
    Boolean(record.reservedUntil && record.reservedUntil > now)
  );
}

export function release(record: ClaimRecord, token: string): ClaimRecord {
  if (record.state !== "created" || record.reservationToken !== token) return record;
  const { reservedUntil: _released, reservationToken: _token, ...rest } = record;
  return rest;
}

export function markPaid(record: ClaimRecord, now: number, transactionId: string, payer: string | undefined): ClaimRecord {
  if (record.state !== "created") return record; // settle is idempotent per claim
  const { reservedUntil: _held, reservationToken: _token, ...rest } = record;
  return { ...rest, state: "paid", paidAt: now, transactionId, ...(payer ? { payer } : {}) };
}

export type CollectError = "authorization_pending" | "expired_token" | "collect_window_closed";

export function collectability(record: ClaimRecord, now: number): CollectError | null {
  const state = effectiveState(record, now);
  if (state === "created") return "authorization_pending";
  if (state === "expired") return "expired_token";
  if (record.paidAt !== undefined && now > record.paidAt + CLAIM_COLLECT_WINDOW_MS) return "collect_window_closed";
  return null;
}

export function recordFetch(record: ClaimRecord, now: number): ClaimRecord {
  return { ...record, fetchCount: record.fetchCount + 1, lastFetchAt: now };
}

export function ack(record: ClaimRecord, now: number): ClaimRecord {
  if (record.state !== "paid") return record;
  return { ...record, state: "acked", ackedAt: now };
}

/** When storage for this record may be deleted entirely. */
export function purgeAt(record: ClaimRecord): number {
  if (record.ackedAt !== undefined) return record.ackedAt + CLAIM_RECEIPT_RETENTION_MS;
  if (record.paidAt !== undefined) return record.paidAt + CLAIM_RECEIPT_RETENTION_MS;
  return record.expiresAt + CLAIM_RECEIPT_RETENTION_MS;
}

/** Public, secret-free view for status polling. */
export function publicView(record: ClaimRecord, now: number) {
  return {
    claim_id: record.id,
    state: effectiveState(record, now),
    expires_at: new Date(record.expiresAt).toISOString(),
    ...(record.paidAt !== undefined && { paid_at: new Date(record.paidAt).toISOString() }),
    interval: CLAIM_POLL_INTERVAL_SECONDS,
  };
}
