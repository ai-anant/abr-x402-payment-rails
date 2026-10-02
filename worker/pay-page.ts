// Browser pay flow for claims. /pay?code= is our own confirmation page (code, price,
// payTo, countdown, live status) so a human checks it matches their terminal before any
// wallet opens; "Continue" goes to the paid route, where the x402 Algorand paywall
// (Pera, Defly, Lute) signs. Only the AVM handler is bundled.
import { avmPaywall } from "@x402/paywall/avm";
import type { PaywallConfig, PaywallProvider } from "@x402/core/server";

import type { ClaimRecord } from "../src/claims.js";
import { effectiveState } from "../src/claims.js";
import type { PaymentConfig } from "../src/config.js";
import { PRODUCT_ROUTE } from "../src/payment.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

// Minimal standalone layout (the production site wraps these bodies in its own template).
function renderPage(_config: PaymentConfig, page: { title: string; description: string; body: string; path: string; noindex?: boolean }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(page.title)}</title><meta name="description" content="${escapeHtml(page.description)}">
${page.noindex ? '<meta name="robots" content="noindex">' : ""}
<style>:root{--ink:#16131f;--line:#ddd8e8;--surface:#f7f5fb}body{font:16px/1.6 system-ui,sans-serif;color:var(--ink);max-width:720px;margin:0 auto;padding:16px}
.card{border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--surface)}.note{color:#555}.button{display:inline-block;background:#5b3df5;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none}
th{text-align:left;padding-right:12px;vertical-align:top}</style></head>
<body><main>
${page.body}
</main><script>for (const button of document.querySelectorAll("[data-copy]")) button.addEventListener("click", () => navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent));</script></body></html>`;
}

export function avmPaywallProvider(): PaywallProvider {
  return {
    generateHtml(paymentRequired, config) {
      const requirement = paymentRequired.accepts.find(entry => avmPaywall.supports(entry as never));
      if (!requirement) return "<!doctype html><title>Payment required</title><p>No Algorand payment option.</p>";
      return avmPaywall.generateHtml(requirement as never, paymentRequired as never, (config ?? {}) as never);
    },
  };
}

export function paywallConfig(config: PaymentConfig): PaywallConfig {
  return {
    appName: "Agent Blast Radius",
    testnet: config.networkName === "testnet",
  } as PaywallConfig;
}

const CLASS_NAMES: Record<string, string> = {
  "aws-sts-identity": "AWS profile",
  "openai-api-key": "OpenAI key",
  "anthropic-api-key": "Anthropic key",
};

export function payPage(config: PaymentConfig, claim: ClaimRecord, now: number): string {
  const state = effectiveState(claim, now);
  const price = (Number(claim.priceAtomic) / 1_000_000).toFixed(2);
  const checks = Object.entries(claim.checks)
    .map(([name, count]) => `${count} × ${escapeHtml(CLASS_NAMES[name] ?? name)}`)
    .join(", ");
  const payUrl = `${PRODUCT_ROUTE}?claim=${encodeURIComponent(claim.id)}`;
  const net = config.networkName === "mainnet" ? "Algorand" : "Algorand Testnet";
  const action =
    state === "created"
      ? `<p class="note"><strong>Only continue if this code matches the one in your terminal or agent.</strong> Payments are final.</p>
    <p><a class="button" id="continue" href="${payUrl}">Continue to wallet</a> <span class="note">Pera or Defly (scan a QR with your phone) or Lute (browser extension)</span></p>`
      : state === "expired"
        ? `<p class="note">This code expired unpaid; nothing was charged. Run <code>blast verify</code> again for a new one.</p>`
        : `<p class="note">Already paid. Return to your terminal; <code>blast</code> collects the checks.</p>`;
  const body = `  <section class="pay" aria-labelledby="pay-title" style="border-top:0;padding-top:24px">
    <h1 id="pay-title" style="font-size:clamp(28px,5vw,40px);letter-spacing:-.03em;margin:0 0 8px">Pay for verification</h1>
    <p class="sub">Agent Blast Radius runs these checks on <em>your</em> machine once this is paid. Nothing about your credentials is sent here.</p>
    <div class="card" style="max-width:560px">
      <p class="note" style="margin:0">Code</p>
      <p style="font:600 clamp(32px,8vw,48px) 'Geist Mono',monospace;letter-spacing:.08em;margin:0 0 12px">${escapeHtml(claim.userCode)}</p>
      <table>
        <tbody>
          <tr><th scope="row">Checks</th><td>${checks}</td></tr>
          <tr><th scope="row">Price</th><td><strong>$${price} USDC</strong> on ${net} · network fee covered</td></tr>
          <tr><th scope="row">Pay to</th><td><code id="payto" style="word-break:break-all">${escapeHtml(claim.payTo)}</code> <button class="copy" type="button" data-copy="payto" style="color:var(--ink);border-color:var(--line)">Copy</button></td></tr>
          <tr><th scope="row">Status</th><td><span id="status" aria-live="polite">${state === "created" ? "Waiting for payment" : state === "expired" ? "Expired" : "Paid ✓"}</span> <span id="countdown" aria-live="off"></span></td></tr>
        </tbody>
      </table>
    </div>
    ${action}
    <p class="note">You need an Algorand wallet holding USDC and about 0.3 ALGO.</p>
  </section>
<script>
(() => {
  const claimId = ${JSON.stringify(claim.id)};
  const expiresAt = ${claim.expiresAt};
  const status = document.getElementById("status");
  const countdown = document.getElementById("countdown");
  const go = document.getElementById("continue");
  const tick = () => {
    const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    countdown.textContent = left > 0 ? "· " + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + " left" : "";
    if (left < 60 && go) { go.remove(); status.textContent = "Too close to expiry — run blast verify again"; }
  };
  const poll = async () => {
    try {
      const r = await fetch("/v1/claims/" + claimId, { headers: { accept: "application/json" } });
      if (r.ok) {
        const s = await r.json();
        if (s.state === "paid" || s.state === "acked") { status.textContent = "Paid ✓ — return to your terminal"; go?.remove(); return; }
        if (s.state === "expired") { status.textContent = "Expired — nothing was charged"; go?.remove(); return; }
      }
    } catch {}
    setTimeout(poll, 5000);
  };
  tick(); setInterval(tick, 1000);
  if (${JSON.stringify(state)} === "created") setTimeout(poll, 5000);
})();
</script>
`;
  return renderPage(config, {
    path: "/pay",
    title: `Pay ${claim.userCode} · Agent Blast Radius`,
    description: "Confirm and pay for local credential verification with your Algorand wallet.",
    body,
    noindex: true,
  });
}

export function paidPage(config: PaymentConfig, claim: ClaimRecord): string {
  const body = `  <section style="border-top:0;padding-top:32px">
    <h1 style="font-size:clamp(28px,5vw,40px);letter-spacing:-.03em;margin:0 0 8px">Paid ✓</h1>
    <p class="sub">Payment for code <strong>${escapeHtml(claim.userCode)}</strong> settled. Return to your terminal or agent: <code>blast</code> picks up the signed verifier manifest and runs the checks on your machine.</p>
    <p class="note">If it isn't waiting, run <code>blast verify --claim ${escapeHtml(claim.id)}</code>.</p>
  </section>
`;
  return renderPage(config, {
    path: "/pay",
    title: "Paid · Agent Blast Radius",
    description: "Payment settled; return to your terminal.",
    body,
    noindex: true,
  });
}
