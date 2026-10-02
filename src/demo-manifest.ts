// DEMO ONLY — not ABR's production verifier. Every command just prints a JSON line saying
// it is a demo; nothing is checked, no credential is read and no provider is called.
// It exists so the paid flow can be run end to end without ABR's private verifier logic.
// Swap in a real ManifestBuilder via createApp({ buildManifest }) for your own product.
import {
  VERIFIER_MANIFEST_SCHEMA_VERSION,
  type ManifestBuilder,
  type VerifierCommand,
} from "./verifier-manifest.js";

export const DEMO_BUNDLE_PREFIX = "demo-";

export const buildDemoManifest: ManifestBuilder = verifierClasses => ({
  schema_version: VERIFIER_MANIFEST_SCHEMA_VERSION,
  bundle_id: `${DEMO_BUNDLE_PREFIX}${verifierClasses.join("+")}`,
  verifier_classes: verifierClasses,
  runtime_vars: [],
  commands: verifierClasses.map(
    (verifierClass): VerifierCommand => ({
      id: `demo-${verifierClass}`,
      verifier_class: verifierClass,
      run_for_each: "eligible_finding_group",
      command: "node",
      args: ["-e", `console.log(JSON.stringify({ demo: true, verifier_class: ${JSON.stringify(verifierClass)} }))`],
      env: {},
      timeout_seconds: 5,
      output: { type: "json", captures: { demo: "$.demo" } },
    }),
  ),
});
