// Cloudflare Workers entry: wires bindings into worker/app.ts.
import { HTTPFacilitatorClient } from "@x402/core/server";

import { loadPaymentConfig } from "../src/config.js";
import { installFacilitatorRedirectGuard } from "../src/facilitator-redirect-guard.js";
import { buildDemoManifest } from "../src/demo-manifest.js";
import { loadManifestSigner } from "../src/manifest-signing.js";
import { createApp, type AbrApp, type RateLimitBucket } from "./app.js";
import { ClaimObject, DurableClaimStore } from "./claim-object.js";
import { D1SettlementSink } from "./d1-audit.js";

export { ClaimObject };

export interface Env {
  DB: D1Database;
  CLAIMS: DurableObjectNamespace<ClaimObject>;
  CLAIM_CREATE_LIMITER: RateLimit;
  CLAIM_POLL_LIMITER: RateLimit;
  MANIFEST_SIGNING_KEY: string;
  [name: string]: unknown;
}

let app: Promise<AbrApp> | undefined;

function configEnv(env: Env): NodeJS.ProcessEnv {
  const vars = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && key !== "MANIFEST_SIGNING_KEY") vars[key] = value;
  }
  return vars;
}

// Workers allow no I/O at global scope: build and initialize once per isolate. A failed
// initialization is not cached, so the next request retries.
function getApp(env: Env): Promise<AbrApp> {
  app ??= (async () => {
    const config = loadPaymentConfig(configEnv(env));
    if (!env.MANIFEST_SIGNING_KEY) throw new Error("MANIFEST_SIGNING_KEY secret is not set");
    installFacilitatorRedirectGuard(config.facilitatorUrl);
    const limiters: Record<RateLimitBucket, RateLimit> = {
      claim_create: env.CLAIM_CREATE_LIMITER,
      claim_poll: env.CLAIM_POLL_LIMITER,
    };
    return createApp({
      config,
      facilitatorClient: new HTTPFacilitatorClient({
        url: config.facilitatorUrl,
        timeoutMs: config.facilitatorTimeoutMs,
      }),
      settlementSink: new D1SettlementSink(env.DB),
      claims: new DurableClaimStore(env.CLAIMS, env.DB),
      signer: await loadManifestSigner(env.MANIFEST_SIGNING_KEY),
      rateLimit: async (bucket, key) => (await limiters[bucket].limit({ key })).success,
      // DEMO manifests. ABR's production deployment injects its private verifier builder here.
      buildManifest: buildDemoManifest,
    });
  })().catch(error => {
    app = undefined;
    throw error;
  });
  return app;
}

export default {
  async fetch(request, env, ctx) {
    return (await getApp(env)).fetch(request, env, ctx);
  },
  // Daily: drop index rows past the 90-day receipt retention (Durable Objects purge themselves).
  async scheduled(_controller, env) {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
    await env.DB.prepare("DELETE FROM claims_index WHERE created_at < ?").bind(cutoff).run();
  },
} satisfies ExportedHandler<Env>;
