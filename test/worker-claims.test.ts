import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

import { MemoryAuditSink } from "../src/audit.js";
import { CLAIM_PAY_CUTOFF_MS, CLAIM_PAY_WINDOW_MS } from "../src/claims.js";
import { loadPaymentConfig } from "../src/config.js";
import {
  SIGNATURE_HEADER,
  generateManifestSigningKey,
  loadManifestSigner,
  verifyManifestSignature,
} from "../src/manifest-signing.js";
import { PRODUCT_ROUTE } from "../src/payment.js";
import { createApp } from "../worker/app.js";
import { MemoryClaimStore } from "../worker/claim-store.js";
import { buildDemoManifest } from "../src/demo-manifest.js";
import { FakeFacilitatorClient, validTestnetEnv } from "./helpers.js";

class CountingFacilitator extends FakeFacilitatorClient {
  settles = 0;
  verifies = 0;
  settleGate: Promise<void> | undefined;
  override async verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    this.verifies += 1;
    return super.verify(payload, requirements);
  }
  override async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settles += 1;
    await this.settleGate;
    const response = await super.settle(payload, requirements);
    return { ...response, transaction: `TX${this.settles}` };
  }
}

async function setup(options: { rateLimited?: boolean } = {}) {
  let clock = Date.parse("2026-10-01T12:00:00Z");
  const facilitator = new CountingFacilitator();
  const sink = new MemoryAuditSink();
  const claims = new MemoryClaimStore();
  const signer = await loadManifestSigner(await generateManifestSigningKey());
  const config = loadPaymentConfig({ ...validTestnetEnv(), X402_PRICE_USD: "0.10" });
  const app = await createApp({
    config,
    facilitatorClient: facilitator,
    settlementSink: sink,
    claims,
    signer,
    buildManifest: buildDemoManifest,
    now: () => clock,
    ...(options.rateLimited && { rateLimit: async () => false }),
  });
  const request = (path: string, init?: RequestInit) => app.request(`http://localhost:4021${path}`, init);
  const createClaim = async (checks = "aws-sts-identity:1,openai-api-key:2") => {
    const response = await request("/v1/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checks, schemas: ["abr.verifier.v1"], client: { name: "blast", version: "0.3.0" } }),
    });
    return { response, body: (await response.json()) as Record<string, any> };
  };
  let nonce = 0;
  const paymentHeaderFor = async (path: string) => {
    const unpaid = await request(path);
    assert.equal(unpaid.status, 402);
    const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
    nonce += 1;
    return encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0]!,
      payload: { paymentGroup: [`synthetic-${nonce}`], paymentIndex: 0 },
    } as PaymentPayload);
  };
  const pay = (path: string, header: string) =>
    request(path, { headers: { "payment-signature": header, accept: "application/json" } });
  return {
    app, request, createClaim, paymentHeaderFor, pay, facilitator, sink, claims, signer,
    advance: (ms: number) => { clock += ms; },
  };
}

describe("worker claims", () => {
  it("creates a claim priced from its checks with agent and browser pay instructions", async () => {
    const { createClaim } = await setup();
    const { response, body } = await createClaim();
    assert.equal(response.status, 201);
    assert.match(body.claim_id, /^clm_[a-z2-7]{26}$/);
    assert.match(body.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.ok(body.claim_secret.length >= 40);
    assert.equal(body.total_checks, 3);
    assert.equal(body.price_atomic, "300000");
    assert.equal(body.price_usd, "0.30");
    assert.deepEqual(body.agent_pay.arguments.queryParams, { claim: body.claim_id });
    assert.equal(body.agent_pay.arguments.maxAmountPerRequest, 300000);
    assert.equal(body.agent_pay.arguments.preferredNetwork, "testnet");
    assert.match(body.browser_pay_url, new RegExp(`/pay\\?code=${body.user_code}$`));
  });

  it("rejects clients without a supported manifest schema, bad checks and rate-limited callers", async () => {
    const { request } = await setup();
    const post = (body: unknown) =>
      request("/v1/claims", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ checks: "aws-sts-identity:1" })).status, 400);
    assert.equal((await post({ checks: "nope:1", schemas: ["abr.verifier.v1"] })).status, 400);
    assert.equal((await post({ checks: "aws-sts-identity:26", schemas: ["abr.verifier.v1"] })).status, 400);
    const limited = await setup({ rateLimited: true });
    assert.equal((await limited.createClaim()).response.status, 429);
  });

  it("offers a 402 for the claim's price and refuses malformed or unknown claims before payment", async () => {
    const { request, createClaim } = await setup();
    const { body } = await createClaim();
    const unpaid = await request(`${PRODUCT_ROUTE}?claim=${body.claim_id}`);
    assert.equal(unpaid.status, 402);
    const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
    assert.equal(required.accepts[0]?.amount, "300000");
    assert.equal((await request(`${PRODUCT_ROUTE}?claim=${body.claim_id}&checks=aws-sts-identity:1`)).status, 400);
    assert.equal((await request(`${PRODUCT_ROUTE}?claim=clm_${"a".repeat(26)}`)).status, 404);
    assert.equal((await request(`${PRODUCT_ROUTE}?claim=not-a-claim`)).status, 400);
  });

  it("settles a paid claim, returns a receipt (not the manifest) and lets only the secret holder collect", async () => {
    const { createClaim, paymentHeaderFor, pay, request, claims, sink, signer } = await setup();
    const { body } = await createClaim();
    const path = `${PRODUCT_ROUTE}?claim=${body.claim_id}`;
    const pending = await request(`/v1/claims/${body.claim_id}/manifest`, {
      headers: { authorization: `Bearer ${body.claim_secret}` },
    });
    assert.equal(pending.status, 409);

    const paid = await pay(path, await paymentHeaderFor(path));
    assert.equal(paid.status, 200);
    const receipt = (await paid.json()) as Record<string, unknown>;
    assert.equal(receipt.status, "paid");
    assert.equal(receipt.claim_id, body.claim_id);
    assert.equal("commands" in receipt, false);

    const record = await claims.get(body.claim_id);
    assert.equal(record?.state, "paid");
    assert.equal(record?.transactionId, "TX1");
    assert.equal(record?.payer, "TESTPAYER");
    const settled = sink.events.find(event => event.event === "payment_settled");
    assert.equal(settled?.claimId, body.claim_id);
    assert.equal(settled?.payer, "TESTPAYER");

    const wrongSecret = await request(`/v1/claims/${body.claim_id}/manifest`, {
      headers: { authorization: `Bearer ${"x".repeat(43)}` },
    });
    assert.equal(wrongSecret.status, 404);

    for (let attempt = 0; attempt < 2; attempt++) {
      const manifest = await request(`/v1/claims/${body.claim_id}/manifest`, {
        headers: { authorization: `Bearer ${body.claim_secret}` },
      });
      assert.equal(manifest.status, 200, "collect is repeatable until ack");
      const text = await manifest.text();
      assert.equal(JSON.parse(text).schema_version, "abr.verifier.v1");
      assert.equal(
        await verifyManifestSignature(text, manifest.headers.get(SIGNATURE_HEADER) ?? "", signer.publicKeyBase64Url),
        true,
      );
    }
    const acked = await request(`/v1/claims/${body.claim_id}/ack`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.claim_secret}` },
    });
    assert.equal(acked.status, 204);
    const status = (await (await request(`/v1/claims/${body.claim_id}`)).json()) as Record<string, unknown>;
    assert.equal(status.state, "acked");
  });

  it("refuses a second payment on a paid claim before anything settles", async () => {
    const { createClaim, paymentHeaderFor, pay, request, facilitator } = await setup();
    const { body } = await createClaim();
    const path = `${PRODUCT_ROUTE}?claim=${body.claim_id}`;
    const header = await paymentHeaderFor(path);
    assert.equal((await pay(path, header)).status, 200);
    assert.equal(facilitator.settles, 1);
    assert.equal((await request(path)).status, 409);
    const again = await pay(path, header);
    assert.equal(again.status, 409);
    assert.equal(facilitator.settles, 1);
  });

  it("lets exactly one of two concurrent payments settle", async () => {
    const { createClaim, paymentHeaderFor, pay, facilitator, claims } = await setup();
    const { body } = await createClaim();
    const path = `${PRODUCT_ROUTE}?claim=${body.claim_id}`;
    const [first, second] = [await paymentHeaderFor(path), await paymentHeaderFor(path)];
    let open!: () => void;
    facilitator.settleGate = new Promise(resolve => { open = resolve; });
    const racing = [pay(path, first!), pay(path, second!)];
    await new Promise(resolve => setTimeout(resolve, 50));
    open();
    const statuses = (await Promise.all(racing)).map(response => response.status).sort();
    assert.deepEqual(statuses.includes(200), true);
    assert.equal(statuses.filter(status => status === 200).length, 1);
    assert.equal(facilitator.settles, 1);
    assert.equal((await claims.get(body.claim_id))?.state, "paid");
  });

  it("expires unpaid claims and stops taking payment before the window closes", async () => {
    const { createClaim, request, advance } = await setup();
    const { body } = await createClaim();
    const path = `${PRODUCT_ROUTE}?claim=${body.claim_id}`;
    advance(CLAIM_PAY_WINDOW_MS - CLAIM_PAY_CUTOFF_MS + 1);
    assert.equal((await request(path)).status, 410);
    advance(CLAIM_PAY_CUTOFF_MS);
    const status = (await (await request(`/v1/claims/${body.claim_id}`)).json()) as Record<string, unknown>;
    assert.equal(status.state, "expired");
    const manifest = await request(`/v1/claims/${body.claim_id}/manifest`, {
      headers: { authorization: `Bearer ${body.claim_secret}` },
    });
    assert.equal(manifest.status, 410);
  });

  it("releases the claim when settlement fails so it can be paid again", async () => {
    const { createClaim, paymentHeaderFor, pay, facilitator, claims } = await setup();
    const { body } = await createClaim();
    const path = `${PRODUCT_ROUTE}?claim=${body.claim_id}`;
    facilitator.settleError = new Error("facilitator unavailable");
    const failed = await pay(path, await paymentHeaderFor(path));
    assert.notEqual(failed.status, 200);
    assert.equal((await claims.get(body.claim_id))?.state, "created");
    assert.equal((await claims.get(body.claim_id))?.reservedUntil, undefined);
    facilitator.settleError = undefined;
    assert.equal((await pay(path, await paymentHeaderFor(path))).status, 200);
    assert.equal((await claims.get(body.claim_id))?.state, "paid");
  });

  it("signs direct manifests and exposes the signature and key to browsers", async () => {
    const { paymentHeaderFor, pay, request, signer } = await setup();
    const path = `${PRODUCT_ROUTE}?checks=aws-sts-identity:1`;
    const paid = await pay(path, await paymentHeaderFor(path));
    assert.equal(paid.status, 200);
    const text = await paid.text();
    assert.equal(await verifyManifestSignature(text, paid.headers.get(SIGNATURE_HEADER) ?? "", signer.publicKeyBase64Url), true);
    assert.match(paid.headers.get("access-control-expose-headers") ?? "", /ABR-SIGNATURE/);
    const key = (await (await request("/.well-known/abr-manifest-key")).json()) as { keys: Array<{ kid: string }> };
    assert.equal(key.keys[0]?.kid, signer.kid);
  });

  it("renders a confirmation page for a pay code and 404s unknown codes", async () => {
    const { createClaim, request } = await setup();
    const { body } = await createClaim();
    const page = await request(`/pay?code=${body.user_code.toLowerCase()}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    const html = await page.text();
    assert.ok(html.includes(body.user_code));
    assert.ok(html.includes("$0.30 USDC"));
    assert.ok(html.includes(body.pay_to));
    assert.ok(html.includes(`href="${PRODUCT_ROUTE}?claim=${body.claim_id}"`));
    assert.match(html, /Only continue if this code matches/);
    assert.equal((await request("/pay?code=BBBB-BBBB")).status, 404);
  });

  it("serves the Algorand paywall to browsers and a paid page after payment", async () => {
    const { createClaim, request, paymentHeaderFor } = await setup();
    const { body } = await createClaim();
    const path = `${PRODUCT_ROUTE}?claim=${body.claim_id}`;
    const browser = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)", accept: "text/html,application/xhtml+xml" };
    const paywall = await request(path, { headers: browser });
    assert.equal(paywall.status, 402);
    assert.match(paywall.headers.get("content-type") ?? "", /text\/html/);
    assert.ok((await paywall.text()).length > 100_000, "AVM paywall bundle served");
    const header = await paymentHeaderFor(path);
    const paid = await request(path, { headers: { ...browser, "payment-signature": header } });
    assert.equal(paid.status, 200);
    assert.match(await paid.text(), /Paid ✓/);
  });

  it("describes the paid route at / and keeps machine 404s as JSON", async () => {
    const { request } = await setup();
    const root = (await (await request("/")).json()) as { paidRoute: { payTo: string; network: string; priceAtomicPerCheck: string } };
    assert.equal(root.paidRoute.priceAtomicPerCheck, "100000");
    assert.match(root.paidRoute.network, /^algorand:/);
    const missing = await request("/nope");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
  });
});
