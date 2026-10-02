import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPETITION_MAINNET_CAIP2,
  COMPETITION_TESTNET_CAIP2,
  MAINNET_ACK,
  loadPaymentConfig,
  usdToMicroUsdc,
} from "../src/config.js";
import { validTestnetEnv } from "./helpers.js";

describe("payment configuration", () => {
  it("loads the competition Testnet defaults", () => {
    const config = loadPaymentConfig(validTestnetEnv());

    assert.equal(config.networkName, "testnet");
    assert.equal(config.network, COMPETITION_TESTNET_CAIP2);
    assert.equal(config.usdcAssetId, "10458941");
    assert.equal(config.priceAtomic, "1000");
    assert.equal(config.challengeTag, "x402-global-challenge");
  });

  it("converts USD strings to micro-USDC without floating point", () => {
    assert.equal(usdToMicroUsdc("12.345678"), "12345678");
    assert.equal(usdToMicroUsdc("0.000001"), "1");
    assert.throws(() => usdToMicroUsdc("0"), /greater than zero/i);
    assert.throws(() => usdToMicroUsdc("0.0000001"), /six decimal places/i);
  });

  it("requires an explicit acknowledgement before Mainnet", () => {
    const env = {
      ...validTestnetEnv(),
      X402_NETWORK: "mainnet",
      PUBLIC_BASE_URL: "https://api.example.com",
      MERCHANT_ROOT_DOMAIN: "example.com",
    };

    assert.throws(() => loadPaymentConfig(env), /X402_MAINNET_ACK/);

    const config = loadPaymentConfig({ ...env, X402_MAINNET_ACK: MAINNET_ACK });
    assert.equal(config.network, COMPETITION_MAINNET_CAIP2);
    assert.equal(config.usdcAssetId, "31566704");
  });

  it("rejects unsafe Mainnet hosts and cross-domain merchant configuration", () => {
    const base = {
      ...validTestnetEnv(),
      X402_NETWORK: "mainnet",
      X402_MAINNET_ACK: MAINNET_ACK,
      MERCHANT_ROOT_DOMAIN: "example.com",
    };

    assert.throws(
      () => loadPaymentConfig({ ...base, PUBLIC_BASE_URL: "http://api.example.com" }),
      /HTTPS/i,
    );
    assert.throws(
      () => loadPaymentConfig({ ...base, PUBLIC_BASE_URL: "https://other.example.net" }),
      /MERCHANT_ROOT_DOMAIN/,
    );
  });

  it("allows local HTTP but rejects non-HTTP protocols on local hosts", () => {
    assert.doesNotThrow(() => loadPaymentConfig(validTestnetEnv()));
    assert.throws(
      () =>
        loadPaymentConfig({
          ...validTestnetEnv(),
          PUBLIC_BASE_URL: "ftp://localhost",
        }),
      /must use HTTPS.*HTTP.*local/i,
    );
  });

  it("rejects a non-GoPlausible facilitator and malformed payTo address", () => {
    assert.throws(
      () => loadPaymentConfig({ ...validTestnetEnv(), FACILITATOR_URL: "https://example.com" }),
      /GoPlausible/i,
    );
    assert.throws(
      () => loadPaymentConfig({ ...validTestnetEnv(), X402_PAY_TO: "NOT_AN_ADDRESS" }),
      /Algorand address/i,
    );
  });
});
