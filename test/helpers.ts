import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

import {
  COMPETITION_TESTNET_CAIP2,
  GOPLAUSIBLE_FACILITATOR_URL,
} from "../src/config.js";

export const TEST_ADDRESS = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";

export function validTestnetEnv(): NodeJS.ProcessEnv {
  return {
    X402_NETWORK: "testnet",
    X402_PAY_TO: TEST_ADDRESS,
    X402_PRICE_USD: "0.001",
    PUBLIC_BASE_URL: "http://localhost:4021",
    MERCHANT_ROOT_DOMAIN: "localhost",
    FACILITATOR_URL: GOPLAUSIBLE_FACILITATOR_URL,
    PORT: "4021",
    SETTLEMENT_AUDIT_PATH: "var/test-settlements.jsonl",
  };
}

export class FakeFacilitatorClient implements FacilitatorClient {
  public settleError: Error | undefined;
  public settleResponse: SettleResponse = {
    success: true,
    transaction: "TESTTRANSACTIONID",
    network: COMPETITION_TESTNET_CAIP2,
    payer: "TESTPAYER",
  };

  async verify(
    _paymentPayload: PaymentPayload,
    _paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return { isValid: true, payer: "TESTPAYER" };
  }

  async settle(
    _paymentPayload: PaymentPayload,
    _paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    if (this.settleError) {
      throw this.settleError;
    }
    return this.settleResponse;
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: COMPETITION_TESTNET_CAIP2,
          extra: { feePayer: TEST_ADDRESS },
        },
      ],
      extensions: [],
      signers: { "algorand:*": [TEST_ADDRESS] },
    };
  }
}
