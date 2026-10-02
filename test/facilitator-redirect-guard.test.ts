import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installFacilitatorRedirectGuard } from "../src/facilitator-redirect-guard.js";

describe("facilitator redirect guard", () => {
  it("forces manual redirects only for exact facilitator protocol endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const upstreamFetch: typeof globalThis.fetch = async (input, init) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        redirect: init?.redirect,
      });
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.invalid" } });
    };
    globalThis.fetch = upstreamFetch;

    try {
      const facilitatorBase = "https://facilitator.example";
      installFacilitatorRedirectGuard(facilitatorBase);
      const installedFetch = globalThis.fetch;
      installFacilitatorRedirectGuard(`${facilitatorBase}/`);

      assert.equal(globalThis.fetch, installedFetch, "install must be idempotent");

      await globalThis.fetch(`${facilitatorBase}/supported`, { redirect: "follow" });
      await globalThis.fetch(
        new Request(`${facilitatorBase}/verify`, {
          method: "POST",
          redirect: "error",
          body: "signed-verify-body",
        }),
      );
      await globalThis.fetch(`${facilitatorBase}/settle`, {
        method: "POST",
        redirect: "follow",
        body: "signed-settle-body",
      });
      await globalThis.fetch(`${facilitatorBase}/supported?verbose=1`, { redirect: "follow" });
      await globalThis.fetch(`${facilitatorBase}/discovery/resources`, { redirect: "error" });
      await globalThis.fetch("https://unrelated.example/verify", { redirect: "follow" });

      assert.deepEqual(calls, [
        { url: `${facilitatorBase}/supported`, redirect: "manual" },
        { url: `${facilitatorBase}/verify`, redirect: "manual" },
        { url: `${facilitatorBase}/settle`, redirect: "manual" },
        { url: `${facilitatorBase}/supported?verbose=1`, redirect: "follow" },
        { url: `${facilitatorBase}/discovery/resources`, redirect: "error" },
        { url: "https://unrelated.example/verify", redirect: "follow" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
