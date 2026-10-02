// Same outcome as Express `request.accepts(["text/html", "application/json"]) ===
// "application/json"`: pick the offer with the highest q, then the most specific match,
// then the earliest Accept entry; ties go to the first offer (text/html). A missing
// Accept header means HTML.
const OFFERS = ["text/html", "application/json"] as const;

interface AcceptEntry {
  type: string;
  subtype: string;
  q: number;
  index: number;
}

function parseAccept(header: string): AcceptEntry[] {
  return header
    .split(",")
    .map((part, index) => {
      const [range = "", ...params] = part.trim().split(";");
      const [type = "", subtype = ""] = range.trim().toLowerCase().split("/");
      let q = 1;
      for (const param of params) {
        const [key, value] = param.trim().split("=");
        if (key?.trim() === "q") q = Number.parseFloat(value ?? "1");
      }
      return { type, subtype, q: Number.isFinite(q) ? q : 0, index };
    })
    .filter(entry => entry.type && entry.subtype);
}

function score(offer: string, entries: AcceptEntry[]) {
  const [type, subtype] = offer.split("/");
  let best: { q: number; specificity: number; index: number } | undefined;
  for (const entry of entries) {
    const specificity =
      entry.type === type && entry.subtype === subtype ? 2
      : entry.type === type && entry.subtype === "*" ? 1
      : entry.type === "*" && entry.subtype === "*" ? 0
      : -1;
    if (specificity < 0) continue;
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity && entry.index < best.index)
    ) {
      best = { q: entry.q, specificity, index: entry.index };
    }
  }
  return best;
}

export function prefersJson(acceptHeader: string | undefined): boolean {
  if (!acceptHeader?.trim()) return false;
  const entries = parseAccept(acceptHeader);
  let winner: (typeof OFFERS)[number] | undefined;
  let winnerScore: { q: number; specificity: number; index: number } | undefined;
  for (const offer of OFFERS) {
    const s = score(offer, entries);
    if (!s || s.q <= 0) continue;
    if (
      !winnerScore ||
      s.q > winnerScore.q ||
      (s.q === winnerScore.q && s.specificity > winnerScore.specificity) ||
      (s.q === winnerScore.q && s.specificity === winnerScore.specificity && s.index < winnerScore.index)
    ) {
      winner = offer;
      winnerScore = s;
    }
  }
  return winner === "application/json";
}
