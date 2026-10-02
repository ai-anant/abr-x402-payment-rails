import type { PaymentOption, RouteConfig, RoutesConfig } from "@x402/core/http";
import {
  declareDiscoveryExtension,
  validateDiscoveryExtension,
} from "@x402-avm/extensions";

import type { PaymentConfig } from "./config.js";
import {
  AWS_STS_IDENTITY_CLASS,
  VERIFIER_MANIFEST_MEDIA_TYPE,
  billableCheckCountFromQuery,
  supportedVerifierClassValues,
} from "./verifier-manifest.js";

export const PRODUCT_ROUTE = "/v1/verifier-manifest";

// Browser payers (pay pages, GoPlausible's client) call the paid route cross-origin and
// must be able to read the x402 headers. The route uses no cookies or credentials.
export const PAID_ROUTE_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, ABR-SIGNATURE",
} as const;
export const PAID_ROUTE_PREFLIGHT_HEADERS = {
  ...PAID_ROUTE_CORS_HEADERS,
  "access-control-allow-methods": "GET",
  "access-control-allow-headers": "PAYMENT-SIGNATURE, Content-Type, Accept",
  "access-control-max-age": "86400",
} as const;
export const PRODUCT_DESCRIPTION =
  "ABR CLI buys a local verifier command manifest for eligible secret findings. Secrets, profile names, paths, scan reports, and provider identities stay on the user's machine.";

export interface PaymentRouteOptions {
  // Workers forbid runtime code generation, which Ajv-based Bazaar validation
  // needs. The Worker builds the same routes without it; Node tests and the
  // Express server keep validating, so the metadata served is pre-validated.
  validateDiscovery?: boolean;
  // Claim-bound pricing (Workers): resolves a claim id to its total check count, or
  // throws for an unknown claim. Without it, `claim` requests are rejected.
  claimTotalChecks?: (claimId: string) => Promise<number>;
}

function buildDiscoveryExtension(validate: boolean) {
  const extensions = declareDiscoveryExtension({
    input: { checks: `${AWS_STS_IDENTITY_CLASS}:1` },
    inputSchema: {
      type: "object",
      properties: {
        checks: {
          type: "string",
          pattern: "^[a-z0-9-]+:[1-9][0-9]*(,[a-z0-9-]+:[1-9][0-9]*)*$",
          description:
            "Comma-separated verifier class/count list, e.g. aws-sts-identity:1,openai-api-key:1. Total count must be 1 to 25; $0.10 per check.",
        },
        class: {
          type: "string",
          enum: supportedVerifierClassValues(),
          description: "Legacy single verifier class shape. Prefer checks for multi-class requests.",
        },
        count: {
          type: "string",
          pattern: "^[1-9][0-9]*$",
          description: "Legacy count for a single class, 1 to 25; $0.10 per check.",
        },
        claim: {
          type: "string",
          pattern: "^clm_[a-z2-7]{26}$",
          description:
            "Claim id from POST /v1/claims (created by `blast verify`). Priced from the claim; the manifest is collected by the claim holder, not returned to the payer. Use alone.",
        },
      },
      additionalProperties: false,
    },
    output: {
      example: {
        schema_version: "abr.verifier.v1",
        runsOn: "ABR CLI client machine",
        commands: ["aws sts get-caller-identity", "OpenAI models API probe", "Anthropic models API probe"],
        serverReceives: ["verifier_class", "eligible_check_count"],
      },
    },
  });
  const bazaar = extensions.bazaar;
  if (!bazaar) {
    throw new Error("Discovery declaration did not produce a Bazaar extension");
  }
  if (!validate) {
    return extensions;
  }
  const validation = validateDiscoveryExtension(bazaar);
  if (!validation.valid) {
    const errors = validation.errors?.join(", ") || "unknown validation error";
    throw new Error(`Invalid Bazaar discovery extension: ${errors}`);
  }
  return extensions;
}

export function buildPaymentRoutes(
  config: PaymentConfig,
  options: PaymentRouteOptions = {},
): Record<string, RouteConfig> {
  const validateDiscovery = options.validateDiscovery ?? true;
  const routes = {
    [`GET ${PRODUCT_ROUTE}`]: {
      accepts: {
        scheme: "exact",
        network: config.network,
        payTo: config.payTo,
        price: async context => {
          const claimId = context.adapter.getQueryParam?.("claim");
          let count: number;
          if (typeof claimId === "string" && claimId) {
            if (!options.claimTotalChecks) throw new Error("claims are not supported here");
            count = await options.claimTotalChecks(claimId);
          } else {
            count = billableCheckCountFromQuery({
              checks: context.adapter.getQueryParam?.("checks"),
              class: context.adapter.getQueryParam?.("class"),
              count: context.adapter.getQueryParam?.("count"),
            });
          }
          return {
            amount: (BigInt(config.priceAtomic) * BigInt(count)).toString(),
            asset: config.usdcAssetId,
            extra: { name: "USDC", decimals: 6 },
          };
        },
        extra: { tag: config.challengeTag },
      },
      resource: `${config.publicBaseUrl}${PRODUCT_ROUTE}`,
      description: PRODUCT_DESCRIPTION,
      mimeType: VERIFIER_MANIFEST_MEDIA_TYPE,
      serviceName: "Agent Blast Radius Paid Verification Manifests",
      tags: ["algorand", "usdc", "security", "local-verification", config.challengeTag],
      extensions: buildDiscoveryExtension(validateDiscovery),
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          error: "payment_required",
          message: "Pay the advertised x402 requirement through the ABR CLI flow to download a local verifier command manifest. Secrets and profile names are not sent.",
        },
      }),
    },
  } satisfies RoutesConfig;

  assertCompetitionRoutes(routes, config, { validateDiscovery });
  return routes;
}

function asPaymentOptions(accepts: PaymentOption | PaymentOption[]): PaymentOption[] {
  return Array.isArray(accepts) ? accepts : [accepts];
}

export function assertCompetitionRoutes(
  routes: RoutesConfig,
  config: PaymentConfig,
  options: PaymentRouteOptions = {},
): void {
  const validateDiscovery = options.validateDiscovery ?? true;
  if ("accepts" in routes) {
    throw new Error("Competition routes must be keyed by HTTP method and path");
  }

  const entries = Object.entries(routes);
  if (entries.length === 0) {
    throw new Error("At least one paid route is required");
  }

  for (const [routeKey, route] of entries) {
    if (!/^([A-Z]+) \//.test(routeKey)) {
      throw new Error(`Invalid paid route key: ${routeKey}`);
    }
    if (!route.description || route.description.trim().length < 24) {
      throw new Error(`${routeKey} needs a concrete Bazaar description`);
    }
    if (!route.resource || new URL(route.resource).origin !== config.publicBaseUrl) {
      throw new Error(`${routeKey} must stay on the configured merchant root domain`);
    }
    if (!route.extensions?.bazaar) {
      throw new Error(`${routeKey} must declare the Bazaar discovery extension`);
    }
    if (validateDiscovery) {
      const discoveryValidation = validateDiscoveryExtension(
        route.extensions.bazaar as Parameters<typeof validateDiscoveryExtension>[0],
      );
      if (!discoveryValidation.valid) {
        throw new Error(`${routeKey} has invalid Bazaar discovery metadata`);
      }
    }

    for (const option of asPaymentOptions(route.accepts)) {
      if (typeof option.payTo !== "string" || option.payTo !== config.payTo) {
        throw new Error(`${routeKey} must use the shared payTo for this one root domain`);
      }
      if (option.network !== config.network) {
        throw new Error(`${routeKey} must use the configured Algorand network`);
      }
      if (option.extra?.tag !== config.challengeTag) {
        throw new Error(`${routeKey} must include the competition attribution tag`);
      }
      if (typeof option.price === "function" && routeKey === `GET ${PRODUCT_ROUTE}`) {
        continue;
      }
      if (typeof option.price !== "object" || !("asset" in option.price)) {
        throw new Error(`${routeKey} must use an explicit USDC asset amount`);
      }
      if (option.price.asset !== config.usdcAssetId || option.price.amount !== config.priceAtomic) {
        throw new Error(`${routeKey} must use the configured Algorand USDC price`);
      }
    }
  }
}
