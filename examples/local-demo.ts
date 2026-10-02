// Offline walk-through of the whole paid flow, in-process, with no network and no wallet.
//
//   npm run demo
//
// MOCK: the facilitator below approves every payment and returns a fake transaction id, and
// the "payment" is a synthetic payload. Everything else is the real code: config, x402
// resource server and Bazaar route, claim state machine, hooks, pay-page routing, Ed25519
// manifest signing. Manifests come from the DEMO builder (src/demo-manifest.ts).
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";

import { MemoryAuditSink } from "../src/audit.js";
import { COMPETITION_TESTNET_CAIP2, loadPaymentConfig } from "../src/config.js";
import { buildDemoManifest } from "../src/demo-manifest.js";
import { SIGNATURE_HEADER, generateManifestSigningKey, loadManifestSigner, verifyManifestSignature } from "../src/manifest-signing.js";
import { PRODUCT_ROUTE } from "../src/payment.js";
import { createApp } from "../worker/app.js";
import { MemoryClaimStore } from "../worker/claim-store.js";

// GoPlausible's public fee-payer address, used here only as a checksum-valid stand-in.
// Nothing is paid in this demo, so nothing is ever sent to it.
const DEMO_ADDRESS = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";

class MockFacilitator implements FacilitatorClient {
  async verify(): Promise<VerifyResponse> {
    return { isValid: true, payer: "MOCKPAYER" };
  }
  async settle(): Promise<SettleResponse> {
    return { success: true, transaction: "MOCK-TX-NOT-ON-CHAIN", network: COMPETITION_TESTNET_CAIP2, payer: "MOCKPAYER" };
  }
  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: COMPETITION_TESTNET_CAIP2, extra: { feePayer: DEMO_ADDRESS } }],
      extensions: [],
      signers: { "algorand:*": [DEMO_ADDRESS] },
    };
  }
}

function step(title: string, detail: unknown): void {
  console.log(`\n== ${title}`);
  console.log(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
}

async function main(): Promise<void> {
  const config = loadPaymentConfig({
    X402_NETWORK: "testnet",
    X402_PAY_TO: DEMO_ADDRESS,
    X402_PRICE_USD: "0.10",
    PUBLIC_BASE_URL: "http://localhost:8787",
    MERCHANT_ROOT_DOMAIN: "localhost",
  });
  const sink = new MemoryAuditSink();
  const app = await createApp({
    config,
    facilitatorClient: new MockFacilitator(),
    settlementSink: sink,
    claims: new MemoryClaimStore(),
    signer: await loadManifestSigner(await generateManifestSigningKey()),
    buildManifest: buildDemoManifest,
  });
  const request = (path: string, init?: RequestInit) => app.request(`${config.publicBaseUrl}${path}`, init);

  // 1. The collector (blast CLI/MCP) opens a claim. It sends class counts only.
  const created = (await (
    await request("/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checks: "aws-sts-identity:1,openai-api-key:2", schemas: ["abr.verifier.v1"], client: { name: "demo", version: "0.1.0" } }),
    })
  ).json()) as Record<string, any>;
  step("1. POST /v1/claims (collector keeps claim_secret)", {
    claim_id: created.claim_id,
    user_code: created.user_code,
    price_usd: created.price_usd,
    agent_pay: created.agent_pay,
    browser_pay_url: created.browser_pay_url,
  });

  // 2. The payer (agent wallet tool or a person) hits the paid route and gets a 402.
  const payPath = `${PRODUCT_ROUTE}?claim=${created.claim_id}`;
  const unpaid = await request(payPath, { headers: { accept: "application/json" } });
  const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
  const accepted = required.accepts[0]!;
  step(`2. GET ${payPath} → HTTP ${unpaid.status} with PAYMENT-REQUIRED`, {
    scheme: accepted.scheme,
    network: accepted.network,
    asset: accepted.asset,
    amount: accepted.amount,
    payTo: accepted.payTo,
    tag: accepted.extra?.tag,
  });

  // 3. MOCK payment: a real wallet would sign an Algorand USDC transfer group here.
  const paymentSignature = encodePaymentSignatureHeader({
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { paymentGroup: ["MOCK-SIGNED-TXN"], paymentIndex: 0 },
  } as PaymentPayload);
  const paid = await request(payPath, { headers: { "payment-signature": paymentSignature, accept: "application/json" } });
  step(`3. Retry with PAYMENT-SIGNATURE (mock) → HTTP ${paid.status}; payer gets a receipt, not the manifest`, await paid.json());

  // 4. The collector polls, then collects the signed manifest with its secret.
  const status = await (await request(`/v1/claims/${created.claim_id}`)).json();
  step("4. GET /v1/claims/:id", status);
  const collected = await request(`/v1/claims/${created.claim_id}/manifest`, {
    headers: { authorization: `Bearer ${created.claim_secret}` },
  });
  const body = await collected.text();
  const signature = collected.headers.get(SIGNATURE_HEADER) ?? "";

  // 5. Verify the Ed25519 signature over the exact bytes with the published key.
  const keyDoc = (await (await request("/.well-known/abr-manifest-key")).json()) as { keys: Array<{ public_key: string }> };
  const valid = await verifyManifestSignature(body, signature, keyDoc.keys[0]!.public_key);
  step(`5. GET /v1/claims/:id/manifest → HTTP ${collected.status}; signature valid: ${valid}`, JSON.parse(body));
  await request(`/v1/claims/${created.claim_id}/ack`, { method: "POST", headers: { authorization: `Bearer ${created.claim_secret}` } });

  step("6. Settlement ledger event (D1 in production; memory here)", sink.events);
  if (!valid || collected.status !== 200) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
