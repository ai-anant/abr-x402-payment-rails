// Ed25519 signatures over the exact manifest response bytes. The blast CLI pins the
// public key and refuses manifests whose `abr-signature` header doesn't verify, so a
// manifest can't be tampered with in transit or pasted in by an agent. Signing the
// bytes (not a re-serialization) avoids any cross-language canonicalization.

export const SIGNATURE_HEADER = "abr-signature";

export interface ManifestSigner {
  kid: string;
  publicKeyBase64Url: string;
  sign(body: string): Promise<string>;
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Load a signer from a base64 PKCS#8 Ed25519 private key (the MANIFEST_SIGNING_KEY secret). */
export async function loadManifestSigner(pkcs8Base64: string): Promise<ManifestSigner> {
  const pkcs8 = fromBase64(pkcs8Base64.trim());
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  if (!jwk.x) throw new Error("MANIFEST_SIGNING_KEY is not an Ed25519 private key");
  const publicKeyBase64Url = jwk.x;
  const digest = await crypto.subtle.digest("SHA-256", fromBase64(publicKeyBase64Url));
  const kid = [...new Uint8Array(digest).slice(0, 8)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return {
    kid,
    publicKeyBase64Url,
    async sign(body: string) {
      const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(body));
      return `ed25519;kid=${kid};sig=${toBase64Url(signature)}`;
    },
  };
}

/** Generate a fresh PKCS#8 key (for tests and for creating the production secret). */
export async function generateManifestSigningKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
}

export async function verifyManifestSignature(body: string, header: string, publicKeyBase64Url: string): Promise<boolean> {
  const match = /^ed25519;kid=([0-9a-f]{16});sig=([A-Za-z0-9_-]+)$/.exec(header.trim());
  if (!match) return false;
  const key = await crypto.subtle.importKey("raw", fromBase64(publicKeyBase64Url), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, fromBase64(match[2]!), new TextEncoder().encode(body));
}

export function publicKeyDocument(signer: ManifestSigner) {
  return {
    keys: [{ kid: signer.kid, alg: "Ed25519", public_key: signer.publicKeyBase64Url, use: "abr-manifest" }],
    header: SIGNATURE_HEADER,
    format: "ed25519;kid=<kid>;sig=<base64url signature over the exact response body bytes>",
  };
}
