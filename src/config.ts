import { isValidAlgorandAddress } from "@x402/avm";

export const GOPLAUSIBLE_FACILITATOR_URL = "https://facilitator.goplausible.xyz";
export const CHALLENGE_TAG = "x402-global-challenge";
export const MAINNET_ACK = "I_UNDERSTAND_MAINNET_USES_REAL_USDC";

// GoPlausible currently advertises the full Algorand genesis hashes. These are
// intentionally not imported from @x402/avm because v2.25 exports shortened
// CAIP-2 identifiers that do not yet match the competition facilitator.
export const COMPETITION_MAINNET_CAIP2 =
  "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
export const COMPETITION_TESTNET_CAIP2 =
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

export type NetworkName = "mainnet" | "testnet";

export interface PaymentConfig {
  networkName: NetworkName;
  network: typeof COMPETITION_MAINNET_CAIP2 | typeof COMPETITION_TESTNET_CAIP2;
  usdcAssetId: "31566704" | "10458941";
  payTo: string;
  priceAtomic: string;
  publicBaseUrl: string;
  facilitatorUrl: typeof GOPLAUSIBLE_FACILITATOR_URL;
  facilitatorTimeoutMs: number;
  algodUrl: string;
  indexerUrl: string;
  challengeTag: typeof CHALLENGE_TAG;
  auditPath: string;
  port: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function requireValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`${name} is required`);
  }
  return value;
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be an absolute URL`);
  }
}

function normalizeServiceUrl(value: string, name: string): string {
  const url = parseUrl(value, name);
  if (url.protocol !== "https:") {
    throw new ConfigurationError(`${name} must use HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigurationError(`${name} must not contain credentials, query parameters, or a fragment`);
  }
  return url.toString().replace(/\/$/, "");
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.")
  );
}

function hostnameMatchesRootDomain(hostname: string, rootDomain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const root = rootDomain.toLowerCase().replace(/\.$/, "");
  return host === root || host.endsWith(`.${root}`);
}

function parsePositiveInteger(value: string, name: string, maximum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new ConfigurationError(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

export function usdToMicroUsdc(value: string): string {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new ConfigurationError("X402_PRICE_USD must be a plain positive decimal amount");
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > 6) {
    throw new ConfigurationError("X402_PRICE_USD supports at most six decimal places");
  }
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0");
  if (atomic <= 0n) {
    throw new ConfigurationError("X402_PRICE_USD must be greater than zero");
  }
  return atomic.toString();
}

export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const networkName = (env.X402_NETWORK?.trim().toLowerCase() || "testnet") as NetworkName;
  if (networkName !== "testnet" && networkName !== "mainnet") {
    throw new ConfigurationError("X402_NETWORK must be either testnet or mainnet");
  }

  const payTo = requireValue(env, "X402_PAY_TO");
  if (!isValidAlgorandAddress(payTo)) {
    throw new ConfigurationError("X402_PAY_TO must be a checksum-valid 58-character Algorand address");
  }

  const publicUrl = parseUrl(requireValue(env, "PUBLIC_BASE_URL"), "PUBLIC_BASE_URL");
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) {
    throw new ConfigurationError(
      "PUBLIC_BASE_URL must not contain credentials, query parameters, or a fragment",
    );
  }
  if (publicUrl.pathname !== "/") {
    throw new ConfigurationError("PUBLIC_BASE_URL must be an origin without a path");
  }
  const isLocalHttp =
    publicUrl.protocol === "http:" && isLocalHostname(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !isLocalHttp) {
    throw new ConfigurationError(
      "PUBLIC_BASE_URL must use HTTPS, except HTTP is allowed for accepted local hostnames",
    );
  }

  const merchantRootDomain = requireValue(env, "MERCHANT_ROOT_DOMAIN")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    merchantRootDomain.includes(":") ||
    merchantRootDomain.includes("/") ||
    !hostnameMatchesRootDomain(publicUrl.hostname, merchantRootDomain)
  ) {
    throw new ConfigurationError(
      "PUBLIC_BASE_URL must be on MERCHANT_ROOT_DOMAIN; one payTo must not span root domains",
    );
  }

  if (networkName === "mainnet") {
    if (env.X402_MAINNET_ACK !== MAINNET_ACK) {
      throw new ConfigurationError(`X402_MAINNET_ACK must equal ${MAINNET_ACK}`);
    }
    if (publicUrl.protocol !== "https:" || isLocalHostname(publicUrl.hostname)) {
      throw new ConfigurationError("Mainnet requires a public HTTPS PUBLIC_BASE_URL");
    }
  }

  const facilitatorCandidate = normalizeServiceUrl(
    env.FACILITATOR_URL?.trim() || GOPLAUSIBLE_FACILITATOR_URL,
    "FACILITATOR_URL",
  );
  if (facilitatorCandidate !== GOPLAUSIBLE_FACILITATOR_URL) {
    throw new ConfigurationError(
      `The competition requires the GoPlausible facilitator at ${GOPLAUSIBLE_FACILITATOR_URL}`,
    );
  }

  const priceUsd = env.X402_PRICE_USD?.trim() || "0.001";
  const isMainnet = networkName === "mainnet";
  const port = parsePositiveInteger(env.PORT?.trim() || "4021", "PORT", 65_535);
  const facilitatorTimeoutMs = parsePositiveInteger(
    env.FACILITATOR_TIMEOUT_MS?.trim() || "10000",
    "FACILITATOR_TIMEOUT_MS",
    120_000,
  );

  return {
    networkName,
    network: isMainnet ? COMPETITION_MAINNET_CAIP2 : COMPETITION_TESTNET_CAIP2,
    usdcAssetId: isMainnet ? "31566704" : "10458941",
    payTo,
    priceAtomic: usdToMicroUsdc(priceUsd),
    publicBaseUrl: publicUrl.origin,
    facilitatorUrl: GOPLAUSIBLE_FACILITATOR_URL,
    facilitatorTimeoutMs,
    algodUrl: normalizeServiceUrl(
      env.ALGOD_URL?.trim() ||
        (isMainnet
          ? "https://mainnet-api.algonode.cloud"
          : "https://testnet-api.algonode.cloud"),
      "ALGOD_URL",
    ),
    indexerUrl: normalizeServiceUrl(
      env.INDEXER_URL?.trim() ||
        (isMainnet
          ? "https://mainnet-idx.algonode.cloud"
          : "https://testnet-idx.algonode.cloud"),
      "INDEXER_URL",
    ),
    challengeTag: CHALLENGE_TAG,
    auditPath: env.SETTLEMENT_AUDIT_PATH?.trim() || "var/settlements.jsonl",
    port,
  };
}
