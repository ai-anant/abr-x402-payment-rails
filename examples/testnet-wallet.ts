// Throwaway TESTNET wallets for one real x402 settlement through your local Worker.
// Refuses to run against anything but Algorand testnet (checks algod's genesis hash).
// Never prints keys; stores them in ~/.abr-payment-rails-testnet/wallets.json (mode 0600).
//
//   npm run testnet:setup             create/load wallets, wait for faucets, opt in to USDC
//   npm run testnet:receiver          print the receiver address (use it as X402_PAY_TO)
//   npm run testnet:pay -- <url>      exactly one paid request, then verify on-chain
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import algosdk from "algosdk";

const ALGOD_URL = "https://testnet-api.algonode.cloud";
const TESTNET_GENESIS_HASH = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const TESTNET_CAIP2 = `algorand:${TESTNET_GENESIS_HASH}`;
const TESTNET_USDC = 10458941;
const PRICE_ATOMIC = 100_000n; // 0.10 USDC per check, matches worker/wrangler.jsonc X402_PRICE_USD
const WALLET_FILE = process.env.ABR_TESTNET_WALLET_FILE ?? join(homedir(), ".abr-payment-rails-testnet", "wallets.json");
const RESULT_FILE = join(dirname(WALLET_FILE), "settle-result.json");
const POLL_MS = 5_000;
// Payer needs 0.2 ALGO locked (account + USDC opt-in), 0.25 to seed the receiver and a few
// 0.001 fees; payment fees are sponsored by the facilitator. 0.6 ALGO covers it all.
const PAYER_MIN_ALGO = 600_000n;
const RECEIVER_SEED_ALGO = 250_000;
const WAIT_LIMIT_MS = 20 * 60_000;

const algod = new algosdk.Algodv2("", ALGOD_URL, "");

interface StoredAccount {
  address: string;
  secretKeyBase64: string;
}
interface Wallets {
  network: "algorand-testnet";
  createdAt: string;
  payer: StoredAccount;
  receiver: StoredAccount;
}

function newAccount(): StoredAccount {
  const account = algosdk.generateAccount();
  return { address: account.addr.toString(), secretKeyBase64: Buffer.from(account.sk).toString("base64") };
}

function secretKey(account: StoredAccount): Uint8Array {
  return new Uint8Array(Buffer.from(account.secretKeyBase64, "base64"));
}

function loadOrCreateWallets(): Wallets {
  if (existsSync(WALLET_FILE)) {
    return JSON.parse(readFileSync(WALLET_FILE, "utf8")) as Wallets;
  }
  mkdirSync(dirname(WALLET_FILE), { recursive: true, mode: 0o700 });
  const wallets: Wallets = {
    network: "algorand-testnet",
    createdAt: new Date().toISOString(),
    payer: newAccount(),
    receiver: newAccount(),
  };
  writeFileSync(WALLET_FILE, JSON.stringify(wallets, null, 2), { mode: 0o600 });
  chmodSync(WALLET_FILE, 0o600);
  console.log(`Created throwaway testnet wallets in ${WALLET_FILE} (mode 0600).`);
  return wallets;
}

async function assertTestnet(): Promise<algosdk.SuggestedParams> {
  const params = await algod.getTransactionParams().do();
  const genesis = Buffer.from(params.genesisHash ?? new Uint8Array()).toString("base64");
  if (genesis !== TESTNET_GENESIS_HASH) {
    throw new Error(`Refusing to continue: algod is not Algorand testnet (genesis ${genesis}).`);
  }
  return params;
}

async function algoBalance(address: string): Promise<bigint> {
  const info = await algod.accountInformation(address).do();
  return BigInt(info.amount);
}

async function usdcBalance(address: string): Promise<bigint | null> {
  try {
    const info = await algod.accountAssetInformation(address, TESTNET_USDC).do();
    return BigInt(info.assetHolding?.amount ?? 0);
  } catch {
    return null; // not opted in
  }
}

async function waitFor(label: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  let dots = 0;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out after 20 minutes waiting for: ${label}`);
    if (dots++ % 12 === 0) console.log(`  …still waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

async function submit(txn: algosdk.Transaction, sk: Uint8Array, label: string): Promise<string> {
  const { txid } = await algod.sendRawTransaction(txn.signTxn(sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 8);
  console.log(`  ✓ ${label}: https://lora.algokit.io/testnet/transaction/${txid}`);
  return txid;
}

async function optIn(account: StoredAccount, label: string): Promise<void> {
  if ((await usdcBalance(account.address)) !== null) {
    console.log(`  ✓ ${label} already opted in to testnet USDC`);
    return;
  }
  const suggestedParams = await assertTestnet();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.address,
    receiver: account.address,
    amount: 0,
    assetIndex: TESTNET_USDC,
    suggestedParams,
  });
  await submit(txn, secretKey(account), `${label} opted in to testnet USDC (${TESTNET_USDC})`);
}

async function setup(): Promise<void> {
  await assertTestnet();
  const wallets = loadOrCreateWallets();
  const { payer, receiver } = wallets;
  console.log("\nThrowaway TESTNET wallets (no real value):");
  console.log(`  payer:    ${payer.address}`);
  console.log(`  receiver: ${receiver.address}  (stands in for our payTo)\n`);

  if ((await algoBalance(payer.address)) < PAYER_MIN_ALGO) {
    console.log("STEP 1 — get at least 0.6 testnet ALGO to the PAYER (any source):");
    console.log("  Official dispenser (sign-in + captcha): https://lora.algokit.io/testnet/fund");
    console.log("  or send testnet ALGO from any testnet wallet you have (Pera/Lute developer mode).");
    console.log(`  Payer address:  ${payer.address}\n`);
    await waitFor("testnet ALGO on the payer", async () => (await algoBalance(payer.address)) >= PAYER_MIN_ALGO);
  }
  console.log(`  ✓ payer has ${(Number(await algoBalance(payer.address)) / 1e6).toFixed(3)} testnet ALGO`);

  await optIn(payer, "payer");

  if ((await algoBalance(receiver.address)) < 200_000n) {
    const suggestedParams = await assertTestnet();
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: payer.address,
      receiver: receiver.address,
      amount: RECEIVER_SEED_ALGO,
      suggestedParams,
    });
    await submit(txn, secretKey(payer), "funded receiver with 0.25 testnet ALGO");
  }
  await optIn(receiver, "receiver");

  if (((await usdcBalance(payer.address)) ?? 0n) < PRICE_ATOMIC) {
    console.log("\nSTEP 2 — get free testnet USDC for the PAYER:");
    console.log("  Open https://faucet.circle.com  (Network: Algorand Testnet · Token: USDC)");
    console.log("  or the same Lora dispenser, which also dispenses testnet USDC.");
    console.log(`  Address:  ${payer.address}\n`);
    await waitFor("testnet USDC on the payer", async () => ((await usdcBalance(payer.address)) ?? 0n) >= PRICE_ATOMIC);
  }
  console.log(`  ✓ payer has ${(Number(await usdcBalance(payer.address)) / 1e6).toFixed(2)} testnet USDC`);
  console.log("\nWallets ready.");
}

async function pay(url: string): Promise<void> {
  await assertTestnet();
  const wallets = loadOrCreateWallets();
  const before = (await usdcBalance(wallets.receiver.address)) ?? 0n;

  const [{ toClientAvmSigner }, { ExactAvmScheme }, { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader }] =
    await Promise.all([import("@x402/avm"), import("@x402/avm/exact/client"), import("@x402/fetch")]);
  const signer = toClientAvmSigner(wallets.payer.secretKeyBase64);

  // Exactly one unpaid probe and one signed retry; anything more fails closed.
  let requests = 0;
  const boundedFetch: typeof fetch = (input, init) => {
    requests += 1;
    if (requests > 2) throw new Error("Refusing a third request: one paid attempt only.");
    return fetch(input, init);
  };
  const paidFetch = wrapFetchWithPaymentFromConfig(boundedFetch, {
    schemes: [{ network: TESTNET_CAIP2, client: new ExactAvmScheme(signer, { algodUrl: ALGOD_URL }) }],
    spendControls: {
      maxAmountPerPayment: false,
      allowedAssets: [{ network: TESTNET_CAIP2, asset: String(TESTNET_USDC), maxAmountPerPayment: PRICE_ATOMIC.toString() }],
    },
    policies: [
      (_version, requirements) =>
        requirements.filter(r => r.network === TESTNET_CAIP2 && r.payTo === wallets.receiver.address),
    ],
  });

  console.log(`\nSending one paid testnet request to ${url}`);
  const response = await paidFetch(url, { method: "GET" });
  const body = await response.text();
  const paymentResponse = response.headers.get("payment-response");
  const settlement = paymentResponse ? decodePaymentResponseHeader(paymentResponse) : null;
  const txid = (settlement as { transaction?: string } | null)?.transaction;

  console.log(`  HTTP ${response.status} after ${requests} request(s)`);
  if (txid) console.log(`  settlement tx: https://lora.algokit.io/testnet/transaction/${txid}`);

  let manifest: { schema_version?: string; commands?: unknown[] } | null = null;
  try {
    manifest = JSON.parse(body);
  } catch {
    manifest = null;
  }

  let after = before;
  for (let i = 0; i < 12 && after - before < PRICE_ATOMIC; i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    after = (await usdcBalance(wallets.receiver.address)) ?? 0n;
  }

  const result = {
    check: "one settled testnet payment through the local Worker",
    at: new Date().toISOString(),
    url,
    httpStatus: response.status,
    requests,
    settlementTx: txid ?? null,
    receiver: wallets.receiver.address,
    receiverUsdcDeltaAtomic: (after - before).toString(),
    manifestSchema: manifest?.schema_version ?? null,
    manifestCommands: Array.isArray(manifest?.commands) ? manifest.commands.length : null,
    pass: response.status === 200 && Boolean(txid) && after - before === PRICE_ATOMIC && manifest?.schema_version === "abr.verifier.v1",
  };
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(`  receiver USDC +${(Number(after - before) / 1e6).toFixed(2)}`);
  console.log(`  manifest: ${result.manifestSchema ?? "none"} (${result.manifestCommands ?? 0} commands)`);
  console.log(`\nRESULT: ${result.pass ? "PASS ✅" : "FAIL ❌"}  (details in ${RESULT_FILE})`);
  if (!result.pass) process.exitCode = 1;
}

const [command, arg] = process.argv.slice(2);
const run =
  command === "setup" ? setup()
  : command === "receiver" ? Promise.resolve(console.log(loadOrCreateWallets().receiver.address))
  : command === "pay" && arg ? pay(arg)
  : Promise.reject(new Error("usage: testnet-wallet.ts setup | receiver | pay <url>"));
run.catch(error => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
