# ABR x402 payment rails

The Algorand [x402](https://x402.org) payment integration behind
[Agent Blast Radius](https://abr.kloudle.dev) (ABR), extracted so it can be read, run and
tested on its own. It's a Cloudflare Worker that sells a small JSON *verifier manifest* for
USDC on Algorand. Payments go through the GoPlausible facilitator, the route is listed in
Bazaar discovery, a "claim" flow lets one party pay and a different party collect, and
delivery is Ed25519-signed.

> **Status:** an extracted snapshot of the code that runs `abr.kloudle.dev`, not the
> deployment source. The payment, claim, signing, storage and audit modules are
> byte-for-byte copies of production. The differences are listed in
> [What differs from production](#what-differs-from-production).

## What's in scope

| In this repo | Not in this repo |
| --- | --- |
| x402 v2 resource server and paid route (`src/payment.ts`, `worker/app.ts`) | The ABR scanner (the `blast` CLI) and its detection rules |
| GoPlausible facilitator client, plus a redirect guard (`src/facilitator-redirect-guard.ts`) | Credential discovery, scan reports, findings |
| Bazaar discovery metadata with the `x402-global-challenge` tag | ABR's production verifier builder (the actual check commands) |
| Claims: create, pay, poll, collect, ack (`src/claims.ts`, `worker/claim-object.ts`) | The abr.kloudle.dev website, install guides, SEO pages |
| Signed manifest delivery (`src/manifest-signing.ts`) | Production keys, wallets, logs and customer data |
| Settlement ledger in D1, and SQL migrations | |
| Browser pay page using the x402 Algorand paywall (Pera, Defly, Lute) | |
| Offline demo, claim client, testnet payer, tests | |

The scanner is proprietary. Its binaries ship from
[makash/agent-blast-radius](https://github.com/makash/agent-blast-radius) under a proprietary
licence. This repo contains none of its code.

## The payment flow (as implemented)

```
collector (blast CLI/MCP)          ABR Worker                     payer (agent wallet / person)      GoPlausible
 1 POST /v1/claims {checks} ───▶ claim: id, secret, user code,
                                   price = $0.10 × checks
   ◀── claim_id, claim_secret, agent_pay args, browser_pay_url
                                                                2 GET /v1/verifier-manifest?claim=…
                                   validate claim (unpayable ⇒ 4xx, never a 402)
                                   402 + PAYMENT-REQUIRED ─────▶ (exact, USDC ASA, amount, payTo, tag)
                                                                3 sign USDC transfer group
                                   ◀──────────────────────────── retry with PAYMENT-SIGNATURE
                                   onBeforeVerify: reserve claim ──────────────────────────────────▶ /verify
                                   onBeforeSettle: reservation still held? ────────────────────────▶ /settle (fee payer)
                                   onAfterSettle: claim → paid (txid, payer); ledger row in D1
                                   200 receipt (payer never gets the manifest) ─▶
 4 GET /v1/claims/:id  (poll: created → paid)
 5 GET /v1/claims/:id/manifest  (Bearer claim_secret)
   ◀── manifest JSON + abr-signature: ed25519;kid=…;sig=…
 6 verify signature against pinned key, run commands locally, POST …/ack
```

A direct buyer can also pay `GET /v1/verifier-manifest?checks=aws-sts-identity:1`. That
returns the signed manifest in the same response, with no claim involved. A bare `GET` gets
the 402 challenge for the Bazaar example input.

Concurrency: each claim is a Durable Object, so `reserve`, `markPaid` and the rest are
atomic per claim. Each payment attempt holds the claim with its own token. A failed,
refused or cancelled attempt releases only its own hold, so two wallets can't both pay one
claim. Unpaid claims expire after 15 minutes, and payment is refused in the final minute.

## Endpoints (from `worker/app.ts`)

| Method and path | Paid | Purpose |
| --- | --- | --- |
| `GET /v1/verifier-manifest?checks=<class>:<n>[,…]` | **yes**, $0.10 × checks | Signed manifest, delivered directly |
| `GET /v1/verifier-manifest?claim=clm_…` | **yes**, priced from the claim | Pays a claim; returns a receipt |
| `POST /v1/claims` | no | Open a claim. Body: `{"checks":"…","schemas":["abr.verifier.v1"]}` |
| `GET /v1/claims/:id` | no | Claim state (`created`, `paid`, `acked` or `expired`) |
| `GET /v1/claims/:id/manifest` | no, needs the claim secret | Collect the signed manifest |
| `POST /v1/claims/:id/ack` | no, needs the claim secret | Mark collected |
| `GET /pay?code=XXXX-XXXX` | no | Human confirmation page, which then opens the paywall |
| `GET /.well-known/abr-manifest-key` | no | Ed25519 public key(s) |
| `GET /healthz`, `GET /` | no | Health and route descriptor |

The live ABR deployment is **https://abr.kloudle.dev**: Algorand mainnet, USDC ASA
`31566704`, $0.10 per check. Try `curl -i https://abr.kloudle.dev/v1/verifier-manifest`
to see the real 402 challenge. Don't pay it for testing; use the testnet setup below.

## What data goes where

The *scanner* runs offline and isn't part of this repo. For the *payment* path:

- **This Worker receives**
  - verifier class names and counts (for example `openai-api-key:2`)
  - an optional client name and version
  - the claim id and secret, when collecting
  - the x402 payment payload, which is a signed Algorand transaction group
  - your IP address, which Cloudflare sees and the rate limiter uses as a key

  It does **not** receive credentials, file paths, profile names or scan results.
- **Stored in D1 and the Durable Object**
  - claim state, checks, price and timestamps
  - the settlement transaction id and payer address
  - client name and version

  Receipts are purged after 90 days. Cloudflare observability logs are enabled in
  `wrangler.jsonc`.
- **GoPlausible facilitator receives** the payment payload and payment requirements
  (`/verify` and `/settle`), and pays the network fee. Anything settled is public on the
  Algorand chain: the payer and payTo addresses, the amount and the transaction id.
- **Browser payers** load the x402 Algorand paywall. Its wallet connectors (WalletConnect
  for Pera and Defly, or the Lute extension) talk to the wallet's own infrastructure.
- **Provider verification** happens on the buyer's machine when they run the manifest's
  commands. ABR's real commands call AWS STS, OpenAI or Anthropic with the user's own
  credentials. The Worker never sees those calls or their results. The demo manifests here
  make no network calls at all.

## Quick start

Requirements: Node 22 or later. You don't need a Cloudflare account or a wallet for steps
1–3.

```sh
npm ci
npm run check        # typecheck (Node and Worker) and run the 28 tests
npm run demo         # offline walk-through of the claim flow (mock facilitator, see below)
```

### Run the Worker locally (testnet, no payment)

```sh
npm run keygen                                          # writes worker/.dev.vars (gitignored)
(cd worker && npx wrangler d1 migrations apply DB --local)
npm run dev -- --var X402_PAY_TO:<your testnet address>
curl -i http://localhost:8787/v1/verifier-manifest     # 402 with PAYMENT-REQUIRED
npm run client -- create aws-sts-identity:1            # opens a claim and prints how to pay it
```

At startup the Worker calls GoPlausible's `/supported` endpoint, so this step needs
network access.

### One real testnet payment (no real money)

```sh
npm run testnet:setup     # throwaway testnet wallets in ~/.abr-payment-rails-testnet (0600);
                          # guides you through the testnet ALGO and USDC faucets
npm run dev -- --var X402_PAY_TO:$(npm run -s testnet:receiver)
npm run testnet:pay -- "http://127.0.0.1:8787/v1/verifier-manifest?checks=aws-sts-identity:1"
```

`testnet-wallet.ts` checks algod's genesis hash and refuses to run on anything but
testnet. It allows exactly one paid request, caps the amount, and checks the receiver's
balance on-chain afterwards.

### Mainnet

Set `X402_NETWORK=mainnet`, `X402_MAINNET_ACK=I_UNDERSTAND_MAINNET_USES_REAL_USDC`, an HTTPS
`PUBLIC_BASE_URL` on your `MERCHANT_ROOT_DOMAIN`, and your own `X402_PAY_TO`. Then run
`wrangler d1 create`, `wrangler secret put MANIFEST_SIGNING_KEY` and `wrangler deploy`.
Config validation (`src/config.ts`) refuses mainnet without the acknowledgement, without
HTTPS, or with any facilitator other than GoPlausible.

## Mocks and demos (clearly not production)

- **`src/demo-manifest.ts`: DEMO manifest builder.** Every command prints
  `{"demo":true,…}`. Nothing is checked, and no credential is read. ABR's production
  deployment injects its own private builder through `createApp({ buildManifest })`.
- **`examples/local-demo.ts`: MOCK facilitator.** It approves every payment and returns a
  fake transaction id, and the "payment" is a synthetic payload. Everything else runs the
  real code.
- **`test/helpers.ts`: `FakeFacilitatorClient`,** used only by the tests.

## What differs from production

| File | Difference |
| --- | --- |
| `src/verifier-manifest.ts` | Production builder (the verifier commands) removed; request parsing and types unchanged; adds the `ManifestBuilder` type |
| `worker/app.ts` | Website, SEO, install-guide routes and host redirects removed; manifest builder injected; `/` returns JSON |
| `worker/index.ts` | Injects the demo builder; IndexNow and search-console variables removed |
| `worker/pay-page.ts` | Inline minimal layout instead of the site template |
| `worker/wrangler.jsonc` | Placeholders instead of ABR's account, database ids and payTo; a single testnet environment |
| `src/{config,payment,claims,manifest-signing,audit,facilitator-redirect-guard}.ts`, `worker/{claim-object,claim-store,d1-audit,negotiate}.ts`, `worker/migrations/*` | Identical to production |

## Known limitations and security assumptions

- **Claim secret.** Whoever holds the claim secret can collect the manifest. The secret is
  256 bits and only its SHA-256 is stored.
- **Trust on first use.** The claim client fetches the signing key from
  `/.well-known/abr-manifest-key` unless `ABR_MANIFEST_PUBLIC_KEY` is set. The real CLI pins
  production keys.
- **Bazaar validation** can't run inside Workers, because it needs runtime code generation.
  The same route builder is validated in the Node tests instead.
- **Claim tokens are per request.** Verify and settle happen inside one request, so the
  in-memory reservation-token map only has to live for that request. Only one payer at a
  time can hold a claim's reservation, which the Durable Object enforces, and the hold
  lapses after 2 minutes.
- **Facilitator.** Config rejects any facilitator other than GoPlausible, as the challenge
  requires.
- **Dependencies.** `npm audit` reports moderate and high advisories in the wallet-connector
  packages pulled in by `@x402/paywall` (WalletConnect, MetaMask SDK, `ws`). Production has
  the same set.
- **Untested here.** Pay-page wallets in a real browser, and mainnet. Mainnet is exercised
  only by the live deployment.

## Licence

**Not yet chosen; owner decision pending.** Until a licence is added, no rights are
granted. Runtime dependencies are mostly Apache-2.0 and MIT (`@x402/*`, `hono`).
