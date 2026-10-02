import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { x402ResourceServer } from "@x402/core/server";
import type { Network, PaymentPayload, PaymentRequirements } from "@x402/core/types";

import {
  JsonlAuditSink,
  MemoryAuditSink,
  attachSettlementAudit,
  type SettlementAuditEvent,
} from "../src/audit.js";
import { loadPaymentConfig } from "../src/config.js";
import { FakeFacilitatorClient, TEST_ADDRESS, validTestnetEnv } from "./helpers.js";

function paymentObjects(network: Network): {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
} {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    asset: "10458941",
    amount: "1000",
    payTo: TEST_ADDRESS,
    maxTimeoutSeconds: 60,
    extra: { tag: "x402-global-challenge" },
  };
  return {
    requirements,
    payload: {
      x402Version: 2,
      accepted: requirements,
      payload: { paymentGroup: [], paymentIndex: 0 },
    },
  };
}

function auditEvent(transactionId: string): SettlementAuditEvent {
  return {
    schemaVersion: 1,
    event: "payment_settled",
    occurredAt: "2026-09-05T12:00:00.000Z",
    phase: "after-handler",
    network: "algorand:testnet",
    asset: "10458941",
    amountAtomic: "1000",
    payTo: TEST_ADDRESS,
    transactionId,
  };
}

describe("settlement audit", () => {
  it("recovers the write queue after one append fails", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "agoraland-audit-"));
    const auditPath = join(temporaryDirectory, "settlements.jsonl");

    try {
      await mkdir(auditPath);
      const sink = new JsonlAuditSink(auditPath);

      await assert.rejects(sink.record(auditEvent("FAILED-WRITE")));
      await rm(auditPath, { recursive: true });

      await sink.record(auditEvent("RECOVERED-WRITE"));

      const records = (await readFile(auditPath, "utf8")).trim().split("\n");
      assert.equal(records.length, 1);
      assert.equal(JSON.parse(records[0] ?? "").transactionId, "RECOVERED-WRITE");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("records a minimal successful settlement without payment credentials", async () => {
    const config = loadPaymentConfig(validTestnetEnv());
    const facilitator = new FakeFacilitatorClient();
    const sink = new MemoryAuditSink();
    const server = new x402ResourceServer(facilitator).register(
      config.network,
      new ExactAvmScheme(),
    );
    attachSettlementAudit(server, sink, () => new Date("2026-09-05T12:00:00Z"));
    await server.initialize();

    const { payload, requirements } = paymentObjects(config.network);
    await server.settlePayment(payload, requirements, {}, {
      request: { method: "GET", path: "/v1/verifier-manifest" },
    });

    assert.equal(sink.events.length, 1);
    assert.deepEqual(sink.events[0], {
      schemaVersion: 1,
      event: "payment_settled",
      occurredAt: "2026-09-05T12:00:00.000Z",
      method: "GET",
      path: "/v1/verifier-manifest",
      phase: "after-handler",
      network: config.network,
      asset: "10458941",
      amountAtomic: "1000",
      payTo: TEST_ADDRESS,
      transactionId: "TESTTRANSACTIONID",
      payer: sink.events[0]?.payer,
    });
    assert.equal(typeof sink.events[0]?.payer, "string");
    assert.equal(JSON.stringify(sink.events).includes("paymentGroup"), false);
  });

  it("records settlement failure and preserves the thrown error", async () => {
    const config = loadPaymentConfig(validTestnetEnv());
    const facilitator = new FakeFacilitatorClient();
    facilitator.settleError = new Error("facilitator unavailable");
    const sink = new MemoryAuditSink();
    const server = new x402ResourceServer(facilitator).register(
      config.network,
      new ExactAvmScheme(),
    );
    attachSettlementAudit(server, sink, () => new Date("2026-09-05T12:00:00Z"));
    await server.initialize();

    const { payload, requirements } = paymentObjects(config.network);
    await assert.rejects(
      server.settlePayment(payload, requirements, {}, {
        request: { method: "GET", path: "/v1/verifier-manifest" },
      }),
      /facilitator unavailable/,
    );

    assert.equal(sink.events.length, 1);
    assert.equal(sink.events[0]?.event, "payment_settlement_failed");
    assert.equal(sink.events[0]?.error, "facilitator unavailable");
  });
});
