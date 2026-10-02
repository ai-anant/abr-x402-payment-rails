export const MAX_VERIFIER_CHECKS = 25;
export const AWS_STS_IDENTITY_CLASS = "aws-sts-identity";
export const OPENAI_API_KEY_CLASS = "openai-api-key";
export const ANTHROPIC_API_KEY_CLASS = "anthropic-api-key";
export const VERIFIER_MANIFEST_SCHEMA_VERSION = "abr.verifier.v1";
export const VERIFIER_MANIFEST_MEDIA_TYPE = "application/vnd.abr.verifier-manifest+json";

export const SUPPORTED_VERIFIER_CLASSES = [
  AWS_STS_IDENTITY_CLASS,
  OPENAI_API_KEY_CLASS,
  ANTHROPIC_API_KEY_CLASS,
] as const;

export type VerifierClass = (typeof SUPPORTED_VERIFIER_CLASSES)[number];

export interface VerifierManifestRequest {
  checks: Partial<Record<VerifierClass, number>>;
  totalCount: number;
  verifierClasses: VerifierClass[];
}

export interface VerifierRuntimeVar {
  name: string;
  source: string;
  required: boolean;
  pattern?: string;
}

export interface VerifierCommand {
  id: string;
  verifier_class: VerifierClass;
  run_for_each: "eligible_finding_group";
  command: string;
  args: string[];
  env: Record<string, string>;
  timeout_seconds: number;
  output: {
    type: "json";
    captures: Record<string, string>;
  };
}

export interface VerifierManifest {
  schema_version: typeof VERIFIER_MANIFEST_SCHEMA_VERSION;
  bundle_id: string;
  verifier_classes: VerifierClass[];
  runtime_vars: VerifierRuntimeVar[];
  commands: VerifierCommand[];
}

function isVerifierClass(value: string): value is VerifierClass {
  return SUPPORTED_VERIFIER_CLASSES.includes(value as VerifierClass);
}

function parseVerifierClass(value: unknown): VerifierClass {
  if (typeof value !== "string" || !isVerifierClass(value)) {
    throw new Error(`class must be one of ${SUPPORTED_VERIFIER_CLASSES.join(", ")}`);
  }
  return value;
}

export function parseEligibleCount(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`count must be an integer from 1 to ${MAX_VERIFIER_CHECKS}`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count > MAX_VERIFIER_CHECKS) {
    throw new Error(`count must be an integer from 1 to ${MAX_VERIFIER_CHECKS}`);
  }
  return count;
}

function parseChecks(value: unknown): Partial<Record<VerifierClass, number>> {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("checks must be a comma-separated verifier class/count list");
  }
  const out: Partial<Record<VerifierClass, number>> = {};
  for (const part of value.split(",")) {
    const [rawVerifierClass, rawCount, extra] = part.split(":");
    if (extra !== undefined) {
      throw new Error("checks entries must be verifier-class:count");
    }
    const verifierClass = parseVerifierClass(rawVerifierClass);
    if (out[verifierClass] !== undefined) {
      throw new Error("checks must not repeat a verifier class");
    }
    out[verifierClass] = parseEligibleCount(rawCount);
  }
  return out;
}

function orderedVerifierClasses(checks: Partial<Record<VerifierClass, number>>): VerifierClass[] {
  return SUPPORTED_VERIFIER_CLASSES.filter(verifierClass => (checks[verifierClass] ?? 0) > 0);
}

function totalCheckCount(checks: Partial<Record<VerifierClass, number>>): number {
  return Object.values(checks).reduce((sum, count) => sum + (count ?? 0), 0);
}

export function parseManifestRequest(query: Record<string, unknown>): VerifierManifestRequest {
  const keys = Object.keys(query).filter(key => query[key] !== undefined);
  // 402-first: a bare probe (agents, crawlers, x402 doctor) gets the challenge
  // for the declared Bazaar example input, and pays for exactly that if it pays.
  if (keys.length === 0) {
    return {
      checks: { [AWS_STS_IDENTITY_CLASS]: 1 },
      totalCount: 1,
      verifierClasses: [AWS_STS_IDENTITY_CLASS],
    };
  }
  if (keys.some(key => key !== "class" && key !== "count" && key !== "checks")) {
    throw new Error("unexpected query fields");
  }
  if (query.checks !== undefined) {
    if (query.class !== undefined || query.count !== undefined) {
      throw new Error("checks cannot be mixed with class/count");
    }
    const checks = parseChecks(query.checks);
    const totalCount = totalCheckCount(checks);
    if (totalCount < 1 || totalCount > MAX_VERIFIER_CHECKS) {
      throw new Error(`total checks must be an integer from 1 to ${MAX_VERIFIER_CHECKS}`);
    }
    return {
      checks,
      totalCount,
      verifierClasses: orderedVerifierClasses(checks),
    };
  }
  const verifierClass = parseVerifierClass(query.class);
  const count = parseEligibleCount(query.count);
  return {
    checks: { [verifierClass]: count },
    totalCount: count,
    verifierClasses: [verifierClass],
  };
}

/**
 * Builds the manifest a paid request delivers. ABR's production builder (the verifier
 * commands themselves) is not part of this repository; it is injected into the app.
 * src/demo-manifest.ts is a clearly labelled stand-in for local runs and tests.
 */
export type ManifestBuilder = (verifierClasses: VerifierClass[]) => VerifierManifest;

export function billableCheckCountFromQuery(query: Record<string, unknown>): number {
  return parseManifestRequest(query).totalCount;
}

export function supportedVerifierClassValues(): string[] {
  return [...SUPPORTED_VERIFIER_CLASSES];
}
