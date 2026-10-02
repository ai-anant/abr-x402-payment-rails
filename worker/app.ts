// The x402 payment application behind abr.kloudle.dev, for Cloudflare Workers, built from
// injected dependencies so the same code runs under workerd (worker/index.ts) and in Node
// tests. A paid request either returns a signed manifest directly, or settles into a claim
// that the blast CLI/MCP collects with a secret. Extracted from the ABR server without the
// website, SEO pages and the production verifier builder (see README).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import type { FacilitatorClient } from "@x402/core/server";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";

import { attachSettlementAudit, type SettlementAuditSink } from "../src/audit.js";
import {
  CLAIM_PAY_WINDOW_MS,
  CLAIM_POLL_INTERVAL_SECONDS,
  SUPPORTED_MANIFEST_SCHEMAS,
  collectability,
  isClaimId,
  newClaimId,
  newClaimSecret,
  newUserCode,
  normalizeUserCode,
  payability,
  publicView,
  secretMatches,
  sha256Hex,
  type ClaimRecord,
} from "../src/claims.js";
import type { PaymentConfig } from "../src/config.js";
import { SIGNATURE_HEADER, publicKeyDocument, type ManifestSigner } from "../src/manifest-signing.js";
import {
  PAID_ROUTE_CORS_HEADERS,
  PAID_ROUTE_PREFLIGHT_HEADERS,
  PRODUCT_ROUTE,
  buildPaymentRoutes,
} from "../src/payment.js";
import {
  VERIFIER_MANIFEST_MEDIA_TYPE,
  parseManifestRequest,
  supportedVerifierClassValues,
  type ManifestBuilder,
  type VerifierClass,
} from "../src/verifier-manifest.js";
import type { ClaimStore } from "./claim-store.js";
import { avmPaywallProvider, paidPage, payPage, paywallConfig } from "./pay-page.js";
import { prefersJson } from "./negotiate.js";

export type RateLimitBucket = "claim_create" | "claim_poll";

export interface AppDeps {
  config: PaymentConfig;
  facilitatorClient: FacilitatorClient;
  settlementSink: SettlementAuditSink;
  claims: ClaimStore;
  signer: ManifestSigner;
  /** Builds what a paid request delivers. ABR's production builder is private; see src/demo-manifest.ts. */
  buildManifest: ManifestBuilder;
  /** Returns false when the caller is over its limit. Absent = unlimited (tests). */
  rateLimit?: (bucket: RateLimitBucket, key: string) => Promise<boolean>;
  now?: () => number;
}

const PUBLIC_CACHE = "public, max-age=300";
const MAX_CLAIM_BODY_BYTES = 4096;
const CLIENT_FIELD = /^[A-Za-z0-9._+-]{1,64}$/;

type QueryReader = { getQueryParam?: (name: string) => string | string[] | undefined };

function claimIdFromTransport(transportContext: unknown): string | undefined {
  const request = (transportContext as { request?: { adapter?: QueryReader } } | undefined)?.request;
  const value = request?.adapter?.getQueryParam?.("claim");
  return typeof value === "string" && isClaimId(value) ? value : undefined;
}

function bearer(c: Context): string | undefined {
  const header = c.req.header("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(header.trim());
  return match?.[1];
}

function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

function priceUsd(atomic: string): string {
  return (Number(atomic) / 1_000_000).toFixed(2);
}

export type AbrApp = Hono<{ Variables: { claim?: ClaimRecord } }>;

export async function createApp(deps: AppDeps): Promise<AbrApp> {
  const { config, claims, signer } = deps;
  const now = deps.now ?? (() => Date.now());
  const allowed = (bucket: RateLimitBucket, key: string) =>
    deps.rateLimit ? deps.rateLimit(bucket, key) : Promise.resolve(true);

  // --- x402 server with claim-aware hooks -------------------------------------------
  const resourceServer = new x402ResourceServer(deps.facilitatorClient).register(
    config.network,
    new ExactAvmScheme(),
  );
  attachSettlementAudit(resourceServer, deps.settlementSink);

  // Reservation tokens per in-flight payment, keyed by the signed payload. A refused or
  // failed attempt releases only its own hold.
  const reservations = new Map<string, { claimId: string; token: string }>();
  const payloadKey = (payload: unknown) => JSON.stringify(payload);

  resourceServer.onBeforeVerify(async context => {
    const claimId = claimIdFromTransport(context.transportContext);
    if (!claimId) return;
    const token = newClaimSecret();
    const result = await claims.reserve(claimId, now(), token);
    if (!result.ok) {
      return { abort: true as const, reason: result.error, message: `Claim cannot be paid: ${result.error}` };
    }
    reservations.set(payloadKey(context.paymentPayload), { claimId, token });
    return;
  });
  resourceServer.onBeforeSettle(async context => {
    const held = reservations.get(payloadKey(context.paymentPayload));
    if (!held) return;
    if (!(await claims.reservationHeld(held.claimId, now(), held.token))) {
      reservations.delete(payloadKey(context.paymentPayload));
      return { abort: true as const, reason: "claim_reservation_lost", message: "Claim is no longer payable." };
    }
    return;
  });
  resourceServer.onAfterSettle(async context => {
    const key = payloadKey(context.paymentPayload);
    const held = reservations.get(key);
    reservations.delete(key);
    const claimId = held?.claimId ?? claimIdFromTransport(context.transportContext);
    if (!claimId) return;
    await claims.markPaid(claimId, now(), context.result.transaction, context.result.payer);
  });
  const releaseHeld = async (context: { paymentPayload: unknown }) => {
    const key = payloadKey(context.paymentPayload);
    const held = reservations.get(key);
    reservations.delete(key);
    if (held) await claims.release(held.claimId, held.token);
  };
  resourceServer.onVerifyFailure(async context => {
    await releaseHeld(context);
  });
  resourceServer.onSettleFailure(async context => {
    await releaseHeld(context);
  });
  resourceServer.onVerifiedPaymentCanceled(async context => {
    await releaseHeld(context);
  });

  // Bazaar metadata is validated by the Node test suite (same builder); Workers forbid
  // the runtime code generation that validation needs.
  const httpServer = new x402HTTPResourceServer(
    resourceServer,
    buildPaymentRoutes(config, {
      validateDiscovery: false,
      claimTotalChecks: async claimId => {
        const record = await claims.get(claimId);
        if (!record) throw new Error("claim_not_found");
        return record.totalChecks;
      },
    }),
  );
  await httpServer.initialize();
  const payment: MiddlewareHandler = paymentMiddlewareFromHTTPServer(
    httpServer,
    paywallConfig(config),
    avmPaywallProvider(),
    false,
  );

  const manifestKey = publicKeyDocument(signer);
  const rootDescriptor = {
    name: "ABR x402 payment rails",
    paidRoute: {
      method: "GET",
      url: `${config.publicBaseUrl}${PRODUCT_ROUTE}?checks=aws-sts-identity:1`,
      priceAtomicPerCheck: config.priceAtomic,
      asset: config.usdcAssetId,
      network: config.network,
      payTo: config.payTo,
      verifierClasses: supportedVerifierClassValues(),
    },
    claims: `${config.publicBaseUrl}/v1/claims`,
    manifestKey: `${config.publicBaseUrl}/.well-known/abr-manifest-key`,
    health: `${config.publicBaseUrl}/healthz`,
  };

  async function signedManifest(c: Context, verifierClasses: VerifierClass[]) {
    const body = JSON.stringify(deps.buildManifest(verifierClasses));
    c.header("cache-control", "private, no-store");
    c.header("content-type", VERIFIER_MANIFEST_MEDIA_TYPE);
    c.header(SIGNATURE_HEADER, await signer.sign(body));
    return c.body(body);
  }

  // --- routes -------------------------------------------------------------------------
  const app: AbrApp = new Hono();

  app.use("*", async (c, next) => {
    c.header("x-request-id", c.req.header("x-request-id") || crypto.randomUUID());
    await next();
    if (c.req.path === PRODUCT_ROUTE) {
      for (const [name, value] of Object.entries(PAID_ROUTE_CORS_HEADERS)) c.res.headers.set(name, value);
    }
    // Match Express: JSON responses declare UTF-8 explicitly.
    if (c.res.headers.get("content-type") === "application/json") {
      c.res.headers.set("content-type", "application/json; charset=utf-8");
    }
  });

  app.get("/healthz", c =>
    c.json({
      status: "ok",
      network: config.networkName,
      asset: "USDC",
      challengeTag: config.challengeTag,
      paidRoute: `GET ${PRODUCT_ROUTE}`,
    }),
  );

  app.get("/", c => {
    c.header("cache-control", PUBLIC_CACHE);
    return c.json(rootDescriptor);
  });
  app.get("/.well-known/abr-manifest-key", c => {
    c.header("cache-control", PUBLIC_CACHE);
    c.header("access-control-allow-origin", "*");
    return c.json(manifestKey);
  });

  // --- claims API (free) ----------------------------------------------------------------
  app.post("/v1/claims", async c => {
    c.header("cache-control", "no-store");
    if (!(await allowed("claim_create", clientIp(c)))) {
      return c.json({ error: "rate_limited", retry_after: 60 }, 429);
    }
    const length = Number(c.req.header("content-length") ?? "0");
    if (length > MAX_CLAIM_BODY_BYTES) return c.json({ error: "payload_too_large" }, 413);
    let body: { checks?: unknown; schemas?: unknown; client?: { name?: unknown; version?: unknown } };
    try {
      const text = await c.req.text();
      if (text.length > MAX_CLAIM_BODY_BYTES) return c.json({ error: "payload_too_large" }, 413);
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const schemas = Array.isArray(body.schemas) ? body.schemas : [];
    if (!SUPPORTED_MANIFEST_SCHEMAS.some(schema => schemas.includes(schema))) {
      return c.json({ error: "unsupported_client", supported_schemas: SUPPORTED_MANIFEST_SCHEMAS }, 400);
    }
    if (typeof body.checks !== "string" || !body.checks) {
      return c.json({ error: "invalid_checks" }, 400);
    }
    let request;
    try {
      request = parseManifestRequest({ checks: body.checks });
    } catch {
      return c.json({ error: "invalid_checks" }, 400);
    }
    const clientName = typeof body.client?.name === "string" && CLIENT_FIELD.test(body.client.name) ? body.client.name : undefined;
    const clientVersion =
      typeof body.client?.version === "string" && CLIENT_FIELD.test(body.client.version) ? body.client.version : undefined;

    const createdAt = now();
    const secret = newClaimSecret();
    const priceAtomic = (BigInt(config.priceAtomic) * BigInt(request.totalCount)).toString();
    let record: ClaimRecord | undefined;
    for (let attempt = 0; attempt < 3 && !record; attempt++) {
      const candidate: ClaimRecord = {
        id: newClaimId(),
        userCode: newUserCode(),
        secretSha256: await sha256Hex(secret),
        checks: request.checks as Record<string, number>,
        totalChecks: request.totalCount,
        priceAtomic,
        payTo: config.payTo,
        network: config.network,
        createdAt,
        expiresAt: createdAt + CLAIM_PAY_WINDOW_MS,
        state: "created",
        fetchCount: 0,
        ...(clientName && { clientName }),
        ...(clientVersion && { clientVersion }),
      };
      try {
        await claims.create(candidate);
        record = candidate;
      } catch {
        // id or user code collision: retry with fresh values
      }
    }
    if (!record) return c.json({ error: "claim_unavailable" }, 503);

    const base = config.publicBaseUrl;
    return c.json(
      {
        claim_id: record.id,
        claim_secret: secret,
        user_code: record.userCode,
        checks: record.checks,
        total_checks: record.totalChecks,
        price_atomic: priceAtomic,
        price_usd: priceUsd(priceAtomic),
        asset: config.usdcAssetId,
        network: config.network,
        network_name: config.networkName,
        pay_to: config.payTo,
        expires_at: new Date(record.expiresAt).toISOString(),
        interval: CLAIM_POLL_INTERVAL_SECONDS,
        agent_pay: {
          tool: "make_http_request_with_x402",
          arguments: {
            baseURL: base,
            path: PRODUCT_ROUTE,
            method: "GET",
            queryParams: { claim: record.id },
            preferredNetwork: config.networkName,
            maxAmountPerRequest: Number(priceAtomic),
          },
        },
        browser_pay_url: `${base}/pay?code=${record.userCode}`,
        status_url: `${base}/v1/claims/${record.id}`,
        manifest_url: `${base}/v1/claims/${record.id}/manifest`,
      },
      201,
    );
  });

  app.get("/v1/claims/:id", async c => {
    c.header("cache-control", "no-store");
    const id = c.req.param("id");
    if (!(await allowed("claim_poll", `status:${id}`))) {
      return c.json({ error: "slow_down", interval: CLAIM_POLL_INTERVAL_SECONDS * 2 }, 429);
    }
    const record = isClaimId(id) ? await claims.get(id) : null;
    if (!record) return c.json({ error: "not_found" }, 404);
    return c.json(publicView(record, now()));
  });

  async function authorizedClaim(c: Context): Promise<ClaimRecord | null> {
    const id = c.req.param("id");
    const secret = bearer(c);
    if (!id || !isClaimId(id) || !secret) return null;
    const record = await claims.get(id);
    if (!record || !(await secretMatches(record, secret))) return null;
    return record;
  }

  app.get("/v1/claims/:id/manifest", async c => {
    c.header("cache-control", "no-store");
    if (!(await allowed("claim_poll", `manifest:${c.req.param("id")}`))) {
      return c.json({ error: "slow_down", interval: CLAIM_POLL_INTERVAL_SECONDS * 2 }, 429);
    }
    const record = await authorizedClaim(c);
    if (!record) return c.json({ error: "not_found" }, 404);
    const error = collectability(record, now());
    if (error === "authorization_pending") {
      return c.json({ error, state: "created", interval: CLAIM_POLL_INTERVAL_SECONDS }, 409);
    }
    if (error) return c.json({ error }, 410);
    await claims.recordFetch(record.id, now());
    const verifierClasses = Object.keys(record.checks).filter(name => (record.checks[name] ?? 0) > 0);
    return signedManifest(c, parseManifestRequest({
      checks: verifierClasses.map(name => `${name}:${record.checks[name]}`).join(","),
    }).verifierClasses);
  });

  app.post("/v1/claims/:id/ack", async c => {
    c.header("cache-control", "no-store");
    const record = await authorizedClaim(c);
    if (!record) return c.json({ error: "not_found" }, 404);
    if (collectability(record, now()) === "authorization_pending") {
      return c.json({ error: "authorization_pending" }, 409);
    }
    await claims.ack(record.id, now());
    return c.body(null, 204);
  });

  app.get("/pay", async c => {
    c.header("cache-control", "no-store");
    c.header("x-frame-options", "DENY");
    c.header("referrer-policy", "no-referrer");
    const code = normalizeUserCode(c.req.query("code") ?? "");
    const id = code ? await claims.idForUserCode(code) : null;
    const record = id ? await claims.get(id) : null;
    if (!record) {
      return c.html(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code not found · Agent Blast Radius</title><body style="font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px"><h1>Code not found</h1><p>Check the code in your terminal, or run <code>blast verify</code> again for a new one.</p></body>`,
        404,
      );
    }
    return c.html(payPage(config, record, now()));
  });

  // --- the paid route -----------------------------------------------------------------
  app.options(PRODUCT_ROUTE, c => c.body(null, 204, PAID_ROUTE_PREFLIGHT_HEADERS));
  app.on("HEAD", PRODUCT_ROUTE, c => c.body(null, 405, { allow: "GET" }));

  // Validate before asking a wallet for payment: an unpayable claim never gets a 402.
  app.get(PRODUCT_ROUTE, async (c, next) => {
    const query = c.req.query();
    if ("claim" in query) {
      if (Object.keys(query).length !== 1 || !isClaimId(query.claim)) {
        return c.json({ error: "invalid_verifier_manifest_request" }, 400);
      }
      const record = await claims.get(query.claim);
      if (!record) return c.json({ error: "claim_not_found" }, 404);
      const error = payability(record, now());
      if (error === "claim_expired") return c.json({ error }, 410);
      if (error) return c.json({ error }, 409);
      c.set("claim", record);
      return next();
    }
    try {
      parseManifestRequest(query);
    } catch {
      return c.json({ error: "invalid_verifier_manifest_request" }, 400);
    }
    return next();
  });
  app.use(PRODUCT_ROUTE, payment);

  app.get(PRODUCT_ROUTE, async c => {
    const claim = c.get("claim");
    if (claim) {
      // The payer gets a receipt, not the manifest: the claim holder collects that.
      c.header("cache-control", "no-store");
      const next = {
        claim_id: claim.id,
        user_code: claim.userCode,
        status: "paid",
        collect: { cli: `blast verify --claim ${claim.id}`, mcp: "blast_collect", manifest_url: `${config.publicBaseUrl}/v1/claims/${claim.id}/manifest` },
      };
      // Browsers (the paywall page) get a page; agents and wallets get JSON.
      const browser = (c.req.header("user-agent") ?? "").includes("Mozilla") && !prefersJson(c.req.header("accept"));
      return browser ? c.html(paidPage(config, claim)) : c.json(next);
    }
    const request = parseManifestRequest(c.req.query());
    if (request.verifierClasses.length === 0) {
      return c.json({ error: "unsupported_verifier_class" }, 400);
    }
    return signedManifest(c, request.verifierClasses);
  });

  app.notFound(c => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    console.error("Unhandled request error", error instanceof Error ? error.message : error);
    return c.json({ error: "internal_server_error" }, 500);
  });

  return app;
}
