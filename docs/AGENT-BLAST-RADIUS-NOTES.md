# Agent Blast Radius — what it is, how it works, and a secret-flow review

Independent technical notes on **Agent Blast Radius** (`abr.kloudle.dev`), by Kloudle
(Akash Mahajan / `makash`). Written from: the public site + `llms.txt`, the public
distribution repo `makash/agent-blast-radius`, the npm launcher source, black-box
dynamically observed behaviour of the `blast` binary, and full source review of the
public Apache-2.0 server component `makash/abr-x402-payment-rails`.

Every behavioural claim below is marked **[verified]** (observed/reproduced here),
**[source]** (read in the public server code), or **[inferred]** (deduced, not proven).

---

## 1. What it is

A credential-exposure inventory for the machine an *unsandboxed coding agent* runs on,
plus an optional paid "is this key actually live?" step.

Threat model: a coding agent (Claude Code, Codex, Cursor, Windsurf/Devin, Cline, any MCP
client) inherits your shell, environment variables, dotfiles and cloud profiles. `blast`
enumerates what it *could* read, scores it 0–100, and produces a shareable card. It is a
measurement tool, **not** a sandbox or a blocking control (stated explicitly in the FAQ).

Two licenses, two codebases:

- **Client** (`blast` CLI/MCP server, npm `@kloudle/agent-blast-radius`): **proprietary**.
  Scanner source is private. `makash/agent-blast-radius` only distributes binaries,
  plugin manifests, skills, rules and `SHA256SUMS`. License text: *"Proprietary
  software, not open-source software. No license to the scanner source code is granted.
  No permission is granted to redistribute modified copies, sell or sublicense the
  software, or operate a hosted scanning service using it."*
- **Payment/claims rails** (`makash/abr-x402-payment-rails`): **Apache-2.0, public** —
  Cloudflare Worker serving `/v1/claims*` and the paid `/v1/verifier-manifest` route.
  The production *verifier commands* are injected at deploy time and are not in the repo
  **[source]**. This repo is the one forked here.

## 2. Component map

| Piece | What it is | How you get it |
|---|---|---|
| `blast` binary | Go, static, stripped, ~7.8 MB; macOS/Linux × amd64/arm64 | GitHub Releases, checksum-pinned |
| npm launcher | `bin/blast.cjs` + `lib/launcher.cjs`; downloads, verifies, execs the binary | `npx -y @kloudle/agent-blast-radius@0.3.1` |
| `install.sh` | checksum-verified install, no sudo | `curl -fsSL https://abr.kloudle.dev/install.sh \| sh` |
| MCP server | `blast mcp` (stdio). Tools: `blast_radius`, `explain_credential`, `blast_card`, `blast_verify_quote`, `blast_claim_status`, `blast_collect` | `.mcp.json` / plugin / `.mcpb` |
| Agent integration | Claude Code + Codex plugin marketplace, Claude Desktop `.mcpb`, Cursor/VS Code one-click, rules files, `skills/blast` skill | docs `/install/*` |
| Site + `llms.txt` | Marketing/agent-facing instructions; agents are told to read `llms.txt` and follow it | `abr.kloudle.dev` |
| Claims API | Cloudflare Worker: create claim, status, bearer-authenticated manifest, ack | `abr-x402-payment-rails` (Apache-2.0) |
| Settlement | x402 over **Algorand mainnet, USDC (ASA 31566704)**, $0.10/check, 1–25 checks/request; facilitator `facilitator.goplausible.xyz`; listed on the GoPlausible Bazaar | protocol + docs |

## 3. The free scan (`blast`, no flags)

### 3.1 Collectors

From the scan report's own `coverage.collectors` **[verified]** and Go symbol names in
the binary **[verified]**: `aws`, `gcloud`, `azure`, `kubernetes`, `docker`,
`github-cli`, `package-managers`, `ssh`, `terraform`, `platforms`, `mcp`, `projects`,
`environment`, `history`. Matching Go functions: `collectAWS`, `collectGCloud`,
`collectAzure`, `collectKube`, `collectDocker`, `collectGH`, `collectPackages`,
`collectSSH`, `collectTerraform`, `collectPlatforms`, `collectAgents`, `collectProjects`,
`collectEnvironment`, `collectHistory`, plus `findReuse`, `entropy`, `hash`, `classify`,
`scoring`, `reachability`, `redact`.

Paths/patterns visible in the binary **[verified]**: `~/.aws/credentials`, `~/.aws/sso/cache`,
`~/.aws/cli/cache`, `~/.config/gcloud/application_default_credentials.json`,
`~/.config/gcloud/legacy_credentials`, `~/.azure`, `~/.kube/config`, `~/.docker`,
`~/.terraformrc`, `~/.terraform.d/credentials.tfrc.json`, `~/.npmrc`, `~/.netrc`,
`~/.zsh_history`, `~/.bash_history`, `~/.claude.json`, `~/.claude/settings.json`,
`~/.gemini/settings.json`, `~/.codeium/windsurf/mcp_config.json`, `.github/workflows`,
`Jenkinsfile`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`, project `.env` files,
`docker-credential-*` helpers, `private-key-header-only` (SSH key headers without bodies).
Collector guard strings such as `symlink-skipped`, `unreadable-or-unsafe-file-skipped`,
`directory-symlink-or-nondirectory-skipped`, `file-byte-limit`, `depth-limit`,
`gitignore-status-unavailable` show defensive, bounded traversal.

### 3.2 Detection

Regexes observed **[verified]** include AWS access keys (`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`),
Stripe (`\b(?:sk_(?:live|test)_|rk_(?:live|test)_)[A-Za-z0-9_]{12,}`), GitHub PATs,
Supabase service-role JWTs (`\beyJ...` three-part), env-substitution references
(`\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`), plus entropy
heuristics and a `generic-secret` category. Redaction classes carry explicit caveats, e.g.
`kubernetes-yaml-scalar-inspection-no-policy-resolution`, `gcloud-sqlite-store-not-decoded`,
`docker-credential-helper-not-executed`, `kubernetes-exec-plugin-not-executed`,
`opaque-store-not-decoded`, `public-certificate-not-secret`, `[redacted-incomplete-inventory]`.

### 3.3 Output

- Terminal table: `ID  CREDENTIAL  LOCATION  AGENT REACHABLE  SCOPE  FINGERPRINT`.
- `-json`: `schema_version`, `score`, `headlines`, `credentials[]`, `mcp_servers`, `reuse`,
  `history`, `coverage`, `resolution`, `assumptions` **[verified — see §6 sample]**.
- Card: 1080×1350 PNG or SVG + copy text; `-anonymous` drops the username, `-no-card`
  skips files, existing files are never overwritten.
- Only **fingerprints** are emitted, never values. Observed format: `sha256:<16 hex chars>`
  of the secret bytes — i.e. a **truncated 64-bit** hash **[verified]**.
- Category counts on the card: `CLOUD`, `CODE`, `CI SECRETS`, `MONEY & DATA`, `AI KEYS`,
  `UNCOUNTED`, `AGENT WIRING`; verdict labels observed: `TOASTY` (45/100); others in the
  binary include `LOCKED DOWN`, `SPICY`.
- Coverage honesty: when traversal is bounded the report sets `coverage.capped: true` with
  `limit_reasons`, and the card prints `INCOMPLETE SCAN: COUNTS REFLECT THE SCANNED SUBSET`.

### 3.4 Flags (from `-help`, verbatim)

`-home`, `-cwd`, `-projects-root` (repeatable), `-budget` (default 2s), `-max-depth` (6),
`-max-file-bytes` (262144), `-max-files` (10000), `-no-env`, `-json`, `-explain <id>`,
`-anonymous`, `-card`, `-card-output`, `-no-card`, `-dry-run-report`,
`-resolve` ("v1 remains offline"), `-report` ("Not implemented in v1"), `-version`.

### 3.5 Offline claim — **[verified empirically]**

Ran the scan under `strace -f -e trace=network`: **zero** `socket()`/`connect()`/
`sendto()`/`sendmsg()` calls during a full scan. No telemetry, no update check, no
network. `-dry-run-report` prints the *would-be* report with locations/fingerprints
stripped and `"mode":"dry-run-no-transmission"` — and that JSON was produced with no
network syscalls either. The scan path is genuinely offline.

## 4. `blast verify` — the paid flow

### 4.1 Protocol (client behaviour observed + server source)

1. CLI counts **eligible** findings locally and POSTs **class counts only** to
   `/v1/claims`. Body captured verbatim on a local interception endpoint **[verified]**:
   ```json
   {"checks":"anthropic-api-key:1,aws-sts-identity:2,openai-api-key:1",
    "client":{"name":"blast","version":"0.3.1"},"schemas":["abr.verifier.v1"]}
   ```
   No values, no profile names, no env-var names, no paths. **[source]** The server
   validates `schemas` and `checks` and ignores everything else it doesn't know.
2. Server returns 201 with `claim_id` (`clm_` + 26 chars from a 32-symbol alphabet,
   ~130 bits), `claim_secret` (256-bit, base64url), `user_code` (8 chars, RFC 8628-style
   unambiguous alphabet `BCDFGHJKLMNPQRSTVWXZ`, shown as `XXXX-XXXX`), `price_atomic`,
   `price_usd`, `pay_to`, `network`, `expires_at`, `interval`, and an
   `agent_pay` block shaped for GoPlausible's `algorand-mcp`
   `make_http_request_with_x402` tool **[source]**, **[verified in a live claim]**.
3. Live claim observed: 4 checks → `price_usd 0.40`, `pay_to`
   `QVWVG355ZDC3ZP6TVEQEDUOGQJVKGKT53RB4VI3AQWABUUHU7V7WFFTHGY`, `network mainnet`,
   15-minute pay window.
4. Payer pays either from the agent's x402 wallet (against `/v1/verifier-manifest?claim=…`
   with `maxAmountPerRequest` = price) or in-browser via `/pay?code=USER_CODE`
   (Pera / Defly / Lute). Payments are final.
5. CLI polls `GET /v1/claims/{id}` (no auth) for state, then fetches
   `GET /v1/claims/{id}/manifest` with `Authorization: Bearer <claim_secret>` **[source]**.
6. Manifest is Ed25519-signed over the **exact response bytes** and delivered in the
   `abr-signature` header, format `ed25519;kid=<16 hex>;sig=<base64url>`; `kid` is the
   first 8 bytes of `SHA-256(public_key)` **[source]**. The CLI **pins the public key**
   and refuses to execute anything if the signature does not verify — confirmed by the
   binary's own strings: `Refused: the manifest signature did not verify. Nothing was
   executed.`, `Refusing to run: the manifest signature did not verify.`,
   `manifest signature did not verify` **[verified in binary]**.
7. Manifest schema `abr.verifier.v1` (media type
   `application/vnd.abr.verifier-manifest+json`): `bundle_id`, `verifier_classes[]`,
   `runtime_vars[]` (name/source/required/pattern) and `commands[]` where each command has
   `id`, `verifier_class`, `run_for_each: "eligible_finding_group"`, `command`, `args[]`,
   `env{}`, `timeout_seconds`, and a JSON `output.captures` map **[source]**. The CLI
   rejects commands needing a shell, checks classes are ones it requested, and runs them
   with a minimal environment — evidenced by strings `verifier command %q is not allowed`,
   `undeclared verifier command class`, `manifest has no command for this check`,
   `no child processes`, `verifier output was not JSON`, `provider refused the
   credential.` **[verified in binary]**.
8. Results are reported as `live` / `rejected` / `error`; the CLI then POSTs
   `/v1/claims/{id}/ack` and deletes locally sensible state ("Live: rotate these first").
   If ack fails the claim stays in `blast verify --list`.

Supported classes (all three in `SUPPORTED_VERIFIER_CLASSES` **[source]**):
`aws-sts-identity` (→ `aws sts get-caller-identity`), `openai-api-key` (→ provider
model-list probe), `anthropic-api-key` (→ provider model-list probe). Max 25 checks/claim,
$0.10 each. Note the CLI has no other verifier class strings, so the marketing's
"1 to 25 checks" is the full current surface.

### 4.2 Server-side state machine (`abr-x402-payment-rails` **[source]**)

- **Windows:** pay window 15 min (`CLAIM_PAY_WINDOW_MS`), payment refused in the last 60 s
  (`CLAIM_PAY_CUTOFF_MS`), single-payer reservation 120 s (`CLAIM_RESERVATION_MS`),
  collect window 30 days after payment (`CLAIM_COLLECT_WINDOW_MS`), receipt retention
  90 days (`CLAIM_RECEIPT_RETENTION_MS`), poll interval advertised as 5 s.
- **States:** `created → paid → acked`, plus computed `expired`; `reserve/release/markPaid/
  recordFetch/ack` are pure functions over the record, wrapped by a Durable Object
  (one claim = one DO, transactional) with `MemoryClaimStore` for tests.
- **Storage:** D1/Durable Object record holds: id, user code, **`secretSha256`**, class
  counts, total, price, payTo, network, timestamps, state, reservation, tx id, payer,
  fetch counters, client name/version. `purgeAt()` defines deletion.
- **Routes:** `POST /v1/claims` (rate-limited, 413 body cap), `GET /v1/claims/:id`
  (unauthenticated, `publicView` = id/state/expires/paid_at/interval only), `GET
  /v1/claims/:id/manifest` (Bearer), `POST /v1/claims/:id/ack` (Bearer), `GET /pay`
  (X-Frame-Options DENY, no-referrer), `GET /v1/verifier-manifest` (x402 402-first;
  a bare probe is priced as `aws-sts-identity:1`).

## 5. Investigating "the secret never leaves the system"

The claim appears on the site as *"Never receives: Secrets, API keys or tokens; AWS
profile or environment variable names; File paths or scan reports"* and in the README as
*"Never sent: credential values, profile names, environment variable names, file paths,
scan output."* Findings:

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Scan makes no network calls | **True** | `strace -e trace=network` on a full scan: 0 socket/connect syscalls (and on `-dry-run-report`) |
| 2 | Only class counts reach the server on claim creation | **True** | Intercepted POST body on a local endpoint: counts + client name/version + schema only |
| 3 | Server never sees values / names / paths / fingerprints | **True by construction** | Nothing else is sent; server code parses only `checks`, `schemas`, `client` |
| 4 | Claim secret is not stored in clear server-side | **True** | `secretSha256` only; comparison is a constant-time loop (`secretMatches`) |
| 5 | The claim secret never leaves the machine | **False, by design** | It is a **bearer token** sent as `Authorization: Bearer` on the manifest + ack calls — it *must* go to the server to authenticate the claim. It authenticates a claim, not a credential |
| 6 | Local storage of the claim secret | **Plaintext, 0600** | `$HOME/.config/blast/claims/<claim_id>.json`, dirs 0700, file 0600, contains `claim_secret`, counts, price, payTo, URL — no credential values, names, paths or fingerprints |
| 7 | Manifest cannot be forged in transit | **True, if key pinning holds** | Ed25519 over exact bytes; server signs with a Workers secret; upstream comment says the CLI pins the key; binary refuses on verify failure |
| 8 | Payment rail integrity | **Reasonable** | Per-payer reservation tokens, idempotent settle, single-use transitions, 402-before-payment validation, no wallet creation/holding by vendor |

### 5.1 Deviations and residual risk found

1. **No TLS enforcement on the claims endpoint.** `--endpoint` / `$ABR_ENDPOINT` accepts a
   plaintext origin: a `verify` run pointed at `http://127.0.0.1:8899` **did** send the
   claim POST there over HTTP **[verified]**. Default is `https://abr.kloudle.dev`, so
   this only matters when the environment is hostile or careless — but it is exactly the
   environment an agent lives in (repo `.env`, MCP config `env:` blocks, shell rc, a
   wrapper script). Anyone who can set that variable can (a) receive the claim request,
   and (b) receive the **claim secret** on the subsequent manifest fetch over cleartext,
   then fetch/ack that manifest themselves. Impact is bounded — the request carries no
   credentials, the manifest is signature-checked, and the worst case is paying for or
   burning someone else's *unpaid* claim — but "the privacy boundary is enforced in the
   API shape" would be stronger with an https-only origin check, and the string
   `endpoint must be an origin like https://abr.kloudle.dev` suggests that was the intent.
2. **Fingerprints are truncated SHA-256 (8 bytes / 64 bits) of the secret bytes.** Fine for
   high-entropy tokens, but a *publicly shared card* is not the risk (the card contains no
   fingerprints) — the risk is any workflow that publishes the JSON report: for a
   low-entropy secret (a weak password, a short token) a 64-bit fingerprint is an offline
   confirmation oracle. Cheap fix: hash with a per-scan random salt, or keep fingerprints
   out of `-json` unless asked.
3. **Unsigned/notarized binaries.** Upstream states this plainly. Trust reduces to:
   GitHub release + SHA256SUMS + a checksum pinned inside the npm package, verified by the
   launcher `[source-reviewed launcher: URL allowlist (github.com + GitHub release-asset
   hosts), https/:443 only, no userinfo/hash, redirect limit 3, 64 MB cap, 30 s timeout,
   SHA-256 compare, cache dirs must be 0700/owned/non-symlinked, `O_NOFOLLOW`, nlink==1,
   `spawn(..., {shell:false})`]`. That launcher is genuinely careful code. But the scanner
   itself is an opaque stripped Go binary that reads your credentials; reproducibility and
   provenance (SLSA/provenance attestation, keyless cosign, build log) would be the natural
   next step — note Kloudle's *other* product signs its binaries with cosign/OIDC, so the
   capability exists in-house.
4. **No code signing** (macOS Gatekeeper/Windows): user-visible friction, and it weakens
   the "verify what your agent runs" story for the agent-installed path.
5. **Agent-facing payment surface.** `llms.txt` + the `blast` skill instruct an **agent** to
   create claims and pay $0.10/check with the user's wallet, with the skill text correctly
   requiring explicit confirmation and forbidding wallet creation. This is a fair design
   for 2026's agent ecosystem, but note the shape: a page an agent is told to fetch and
   follow can ask that agent to spend money. Any org adopting this should set
   `maxAmountPerRequest`, `--only`, and `--max-checks` caps in policy, not in the prompt.
6. **Unauthenticated status endpoint** leaks claim state (state, expiry, paid_at) to anyone
   holding the 130-bit claim id. Not enumerable, but the id is printed in share text/logs;
   no harm found, worth noting for completeness.

### 5.2 Open questions (not resolvable from the public code)

- Where the client pins the manifest public key (embedded constant vs. fetched key document)
  — the server exposes `publicKeyDocument()`, but the CLI is closed source; a *fetched*
  key would make the signature decorative. The binary contains the header/kid format strings
  and the refusal paths, but no readable pinned key material or JWKS URL was found.
- The production `ManifestBuilder` (the real verifier commands, their env, timeouts and
  capture patterns) is deliberately not in the public repo.
- Whether the CLI validates `runtime_vars[].pattern` against local material (it must, to
  run `aws sts get-caller-identity` per profile) — the schema supports it; behaviour is
  unverifiable without a paid manifest.

## 6. Reproduction

```sh
# verify the launcher/binary chain
curl -sSL -o abr.tgz https://registry.npmjs.org/@kloudle/agent-blast-radius/-/agent-blast-radius-0.3.1.tgz
tar xzf abr.tgz && sed -n 1,200p package/lib/launcher.cjs          # audit the launcher
curl -sSL -o blast-linux-amd64 https://github.com/makash/agent-blast-radius/releases/download/v0.3.1/blast-linux-amd64
sha256sum blast-linux-amd64                                          # compare with release-manifest.json

# prove the scan is offline
strace -f -e trace=network ./blast-linux-amd64 -json > scan.json 2>/dev/null; grep -c connect strace.log

# prove the claim request carries counts only (local plaintext sink, no vendor involved)
python3 sink.py &                    # logs requests, answers 402
ABR_ENDPOINT=http://127.0.0.1:8899 OPENAI_API_KEY=... ./blast-linux-amd64 verify -home ./fakehome --json

# inspect local claim state
ls -l $HOME/.config/blast/claims/ && cat $HOME/.config/blast/claims/<id>.json

# server-side ground truth
git clone https://github.com/makash/abr-x402-payment-rails
sed -n 1,190p src/claims.ts; sed -n 1,70p src/manifest-signing.ts; sed -n 230,400p worker/app.ts
```

Sanitised sample of the scan JSON (this container; `GH_TOKEN`/`GITHUB_TOKEN` in the
environment, no cloud profiles):

```json
{"schema_version":"1.0","score":45,
 "headlines":{"accounts_reachable":0,"live_payment_keys":0,"databases_full_access":0,
              "accounts_basis":"distinct declared account hints on readable credential material; lower bound, not verified access"},
 "credentials":[{"id":"cred_…","type":"github","collector":"environment","location":"env:GITHUB_TOKEN",
                 "fingerprint":"sha256:411b767d55a74a8d","fingerprint_basis":"secret-bytes","scope":["unknown"],
                 "liveness":"unknown","score":39,
                 "reachability":{"current_uid_readable":true,"agent_reachable":true,
                                 "basis":"inherited-process-environment","in_git_repo":false}}],
 "coverage":{"files_visited":20,"files_read":4,"elapsed_ms":20,"capped":true,"limit_reasons":["depth-limit"]},
 "resolution":"offline"}
```

## 7. Assessment in one paragraph

The **privacy engineering is real**: offline scan (verified by syscall trace), class-counts-only
requests (verified by interception), hash-only server-side claim storage, signed manifests,
strict local execution with a command allowlist, and a defensively written launcher. The
weakest links are not the privacy boundary but (a) no TLS enforcement on an
environment-overridable endpoint, (b) trust in an unsigned, opaque scanner binary on the
machine that holds your credentials, and (c) a 64-bit secret fingerprint in the JSON report.
The commercial split (free offline scan, $0.10/check for liveness) is coherent; the main
strategic constraint is that only three verifier classes exist today (AWS identity, OpenAI
key, Anthropic key), so "which of my keys are live" covers a small slice of what the free
scan enumerates.
