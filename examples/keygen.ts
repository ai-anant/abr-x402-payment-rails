// Generate a manifest signing key for local dev: writes worker/.dev.vars (mode 0600, gitignored)
// and prints only the public key id. For a deployment: `npx wrangler secret put MANIFEST_SIGNING_KEY`.
import { existsSync, writeFileSync } from "node:fs";

import { generateManifestSigningKey, loadManifestSigner } from "../src/manifest-signing.js";

const path = new URL("../worker/.dev.vars", import.meta.url);
if (existsSync(path)) {
  console.log("worker/.dev.vars already exists; leaving it alone.");
} else {
  const key = await generateManifestSigningKey();
  writeFileSync(path, `MANIFEST_SIGNING_KEY=${key}\n`, { mode: 0o600 });
  const signer = await loadManifestSigner(key);
  console.log(`Wrote worker/.dev.vars (kid ${signer.kid}, public key ${signer.publicKeyBase64Url}).`);
}
