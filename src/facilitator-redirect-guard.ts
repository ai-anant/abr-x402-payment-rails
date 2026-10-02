const FACILITATOR_PROTOCOL_PATHS = ["supported", "verify", "settle"] as const;

interface RedirectGuardState {
  endpoints: Set<string>;
}

const guardedFetches = new WeakMap<typeof globalThis.fetch, RedirectGuardState>();

function protocolEndpoints(facilitatorBase: string): string[] {
  const normalizedBase = facilitatorBase.replace(/\/+$/, "");
  return FACILITATOR_PROTOCOL_PATHS.map(path => new URL(`${normalizedBase}/${path}`).href);
}

function requestUrl(input: RequestInfo | URL): string | undefined {
  try {
    if (input instanceof Request) return new URL(input.url).href;
    return new URL(String(input)).href;
  } catch {
    return undefined;
  }
}

/**
 * Prevent the pinned SDK's facilitator POSTs from forwarding signed bodies
 * across redirects while leaving every unrelated global fetch unchanged.
 */
export function installFacilitatorRedirectGuard(facilitatorBase: string): void {
  const currentFetch = globalThis.fetch;
  const existing = guardedFetches.get(currentFetch);
  if (existing) {
    for (const endpoint of protocolEndpoints(facilitatorBase)) existing.endpoints.add(endpoint);
    return;
  }

  const state: RedirectGuardState = {
    endpoints: new Set(protocolEndpoints(facilitatorBase)),
  };
  const upstreamFetch = currentFetch;
  const guardedFetch: typeof globalThis.fetch = (input, init) => {
    const url = requestUrl(input);
    if (!url || !state.endpoints.has(url)) return upstreamFetch(input, init);
    return upstreamFetch(input, { ...init, redirect: "manual" });
  };

  guardedFetches.set(guardedFetch, state);
  globalThis.fetch = guardedFetch;
}
