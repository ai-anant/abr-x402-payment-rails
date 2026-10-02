// Minimal claim client: what the blast CLI does around a payment, without the scanner.
//
//   npm run client -- create [checks]            open a claim, print how to pay it
//   npm run client -- collect <claim_id> <secret> wait for payment, fetch + verify the manifest
//
// ABR_ENDPOINT defaults to http://localhost:8787 (npm run dev). Creating a claim is free and
// sends only class counts. Set ABR_MANIFEST_PUBLIC_KEY to pin the signing key; otherwise the
// key is fetched from /.well-known/abr-manifest-key (trust on first use; the CLI pins it).
import { SIGNATURE_HEADER, verifyManifestSignature } from "../src/manifest-signing.js";

const endpoint = (process.env.ABR_ENDPOINT ?? "http://localhost:8787").replace(/\/$/, "");

async function create(checks: string): Promise<void> {
  const response = await fetch(`${endpoint}/v1/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checks, schemas: ["abr.verifier.v1"], client: { name: "claim-client", version: "0.1.0" } }),
  });
  const body = (await response.json()) as Record<string, any>;
  if (response.status !== 201) throw new Error(`create failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  console.log(`Claim ${body.claim_id}  code ${body.user_code}  $${body.price_usd} USDC on ${body.network_name}`);
  console.log(`Pay in a browser:   ${body.browser_pay_url}`);
  console.log(`Or an agent wallet: ${JSON.stringify(body.agent_pay)}`);
  console.log(`Expires: ${body.expires_at}`);
  console.log(`\nThen: npm run client -- collect ${body.claim_id} <claim_secret>`);
  console.log("The claim secret is printed to stderr so you can keep it out of logs.");
  console.error(body.claim_secret);
}

async function publicKey(): Promise<string> {
  if (process.env.ABR_MANIFEST_PUBLIC_KEY) return process.env.ABR_MANIFEST_PUBLIC_KEY;
  const doc = (await (await fetch(`${endpoint}/.well-known/abr-manifest-key`)).json()) as { keys: Array<{ public_key: string }> };
  return doc.keys[0]!.public_key;
}

async function collect(claimId: string, secret: string): Promise<void> {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${endpoint}/v1/claims/${claimId}/manifest`, { headers: { authorization: `Bearer ${secret}` } });
    if (response.status === 200) {
      const body = await response.text();
      const valid = await verifyManifestSignature(body, response.headers.get(SIGNATURE_HEADER) ?? "", await publicKey());
      if (!valid) throw new Error("manifest signature did not verify; refusing it");
      console.log(`Signed manifest verified:\n${JSON.stringify(JSON.parse(body), null, 2)}`);
      await fetch(`${endpoint}/v1/claims/${claimId}/ack`, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
      return;
    }
    const error = (await response.json().catch(() => ({}))) as { error?: string; interval?: number };
    if (response.status !== 409 && response.status !== 429) throw new Error(`collect failed: HTTP ${response.status} ${error.error ?? ""}`);
    process.stdout.write(".");
    await new Promise(resolve => setTimeout(resolve, (error.interval ?? 5) * 1000));
  }
  throw new Error("claim was not paid within 15 minutes");
}

const [command, ...args] = process.argv.slice(2);
const run =
  command === "create" ? create(args[0] ?? "aws-sts-identity:1")
  : command === "collect" && args[0] && args[1] ? collect(args[0], args[1])
  : Promise.reject(new Error("usage: claim-client.ts create [checks] | collect <claim_id> <claim_secret>"));
run.catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
