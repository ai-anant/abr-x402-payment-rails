import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateDiscoveryExtension } from "@x402-avm/extensions";

import { loadPaymentConfig } from "../src/config.js";
import {
  PRODUCT_ROUTE,
  assertCompetitionRoutes,
  buildPaymentRoutes,
} from "../src/payment.js";
import { validTestnetEnv } from "./helpers.js";

describe("competition payment routes", () => {
  it("binds the verifier manifest route to USDC, one payTo, and Bazaar attribution", async () => {
    const config = loadPaymentConfig(validTestnetEnv());
    const routes = buildPaymentRoutes(config);
    const route = routes[`GET ${PRODUCT_ROUTE}`];

    assert.ok(route);
    assert.equal(Array.isArray(route.accepts), false);
    const accepts = Array.isArray(route.accepts) ? route.accepts[0] : route.accepts;
    assert.ok(accepts);
    assert.equal(accepts.network, config.network);
    assert.equal(accepts.payTo, config.payTo);
    assert.equal(typeof accepts.price, "function");
    if (typeof accepts.price !== "function") return;
    const price = await accepts.price({
      adapter: { getQueryParam: (name: string) => (name === "count" ? "2" : name === "class" ? "aws-sts-identity" : undefined) },
    } as unknown as Parameters<typeof accepts.price>[0]);
    assert.deepEqual(price, {
      amount: "2000",
      asset: "10458941",
      extra: { name: "USDC", decimals: 6 },
    });
    assert.equal(accepts.extra?.tag, "x402-global-challenge");
    assert.equal(route.resource, "http://localhost:4021/v1/verifier-manifest");
    assert.match(route.description ?? "", /ABR CLI buys a local verifier command manifest/);
    assert.ok(route.extensions?.bazaar);

    const discoveryValidation = validateDiscoveryExtension(
      route.extensions?.bazaar as Parameters<typeof validateDiscoveryExtension>[0],
    );
    assert.equal(discoveryValidation.valid, true);
    assert.doesNotThrow(() => assertCompetitionRoutes(routes, config));
  });

  it("prices multi-class verifier requests by total eligible checks", async () => {
    const config = loadPaymentConfig(validTestnetEnv());
    const routes = buildPaymentRoutes(config);
    const route = routes[`GET ${PRODUCT_ROUTE}`];
    assert.ok(route && !Array.isArray(route.accepts));
    const accepts = route.accepts;
    assert.equal(typeof accepts.price, "function");
    if (typeof accepts.price !== "function") return;
    const price = await accepts.price({
      adapter: {
        getQueryParam: (name: string) =>
          name === "checks" ? "aws-sts-identity:2,openai-api-key:1,anthropic-api-key:1" : undefined,
      },
    } as unknown as Parameters<typeof accepts.price>[0]);
    assert.deepEqual(price, {
      amount: "4000",
      asset: "10458941",
      extra: { name: "USDC", decimals: 6 },
    });
  });

  it("fails closed when a route drifts to another payTo", () => {
    const config = loadPaymentConfig(validTestnetEnv());
    const routes = buildPaymentRoutes(config);
    const route = routes[`GET ${PRODUCT_ROUTE}`];
    assert.ok(route && !Array.isArray(route.accepts));
    route.accepts.payTo = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

    assert.throws(() => assertCompetitionRoutes(routes, config), /shared payTo/i);
  });
});
