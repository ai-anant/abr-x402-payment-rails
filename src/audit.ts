import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { x402ResourceServer } from "@x402/core/server";

export interface SettlementAuditEvent {
  schemaVersion: 1;
  event: "payment_settled" | "payment_settlement_failed";
  occurredAt: string;
  method?: string;
  path?: string;
  phase: "before-handler" | "after-handler" | "cancel";
  network: string;
  asset: string;
  amountAtomic: string;
  payTo: string;
  transactionId?: string;
  // What was bought (claim id, or the checks query for direct buyers) and by whom, so a
  // dispute can be answered from on-chain transfer + this ledger + the claim record.
  claimId?: string;
  checks?: string;
  payer?: string;
  error?: string;
}

export interface SettlementAuditSink {
  record(event: SettlementAuditEvent): Promise<void>;
}

export class MemoryAuditSink implements SettlementAuditSink {
  readonly events: SettlementAuditEvent[] = [];

  async record(event: SettlementAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

export class JsonlAuditSink implements SettlementAuditSink {
  readonly path: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  record(event: SettlementAuditEvent): Promise<void> {
    const currentWrite = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o750 });
      await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o640 });
    });
    this.writeChain = currentWrite.catch(() => undefined);
    return currentWrite;
  }
}

function requestCoordinates(transportContext: unknown): {
  method?: string;
  path?: string;
  claimId?: string;
  checks?: string;
} {
  if (!transportContext || typeof transportContext !== "object") {
    return {};
  }
  const request = (transportContext as { request?: unknown }).request;
  if (!request || typeof request !== "object") {
    return {};
  }
  const candidate = request as {
    method?: unknown;
    path?: unknown;
    adapter?: { getQueryParam?: (name: string) => string | string[] | undefined };
  };
  const query = (name: string) => {
    const value = candidate.adapter?.getQueryParam?.(name);
    return typeof value === "string" && value.length <= 256 ? value : undefined;
  };
  const claimId = query("claim");
  const checks = query("checks");
  return {
    ...(typeof candidate.method === "string" && { method: candidate.method }),
    ...(typeof candidate.path === "string" && { path: candidate.path }),
    ...(claimId && { claimId }),
    ...(checks && { checks }),
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown settlement error";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

async function recordWithoutBreakingSettlement(
  sink: SettlementAuditSink,
  event: SettlementAuditEvent,
): Promise<void> {
  try {
    await sink.record(event);
  } catch (error) {
    console.error("Failed to persist settlement audit event", error);
  }
}

export function attachSettlementAudit(
  server: x402ResourceServer,
  sink: SettlementAuditSink,
  now: () => Date = () => new Date(),
): void {
  server.onAfterSettle(async context => {
    const coordinates = requestCoordinates(context.transportContext);
    await recordWithoutBreakingSettlement(sink, {
      schemaVersion: 1,
      event: "payment_settled",
      occurredAt: now().toISOString(),
      ...coordinates,
      phase: context.phase,
      network: context.result.network,
      asset: context.requirements.asset,
      amountAtomic: context.result.amount ?? context.requirements.amount,
      payTo: context.requirements.payTo,
      transactionId: context.result.transaction,
      ...(context.result.payer && { payer: context.result.payer }),
    });
  });

  server.onSettleFailure(async context => {
    const coordinates = requestCoordinates(context.transportContext);
    const transaction = (context.error as { transaction?: unknown }).transaction;
    await recordWithoutBreakingSettlement(sink, {
      schemaVersion: 1,
      event: "payment_settlement_failed",
      occurredAt: now().toISOString(),
      ...coordinates,
      phase: context.phase,
      network: context.requirements.network,
      asset: context.requirements.asset,
      amountAtomic: context.requirements.amount,
      payTo: context.requirements.payTo,
      ...(typeof transaction === "string" && { transactionId: transaction }),
      error: safeErrorMessage(context.error),
    });
  });
}
