const LS_PREFIX = "x402-poc-upto-payload:";

export function sessionCacheKey(requestUrl: string, ledgerAddress: string): string {
  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    origin = requestUrl;
  }
  return `${ledgerAddress.toLowerCase()}|${origin}`;
}

export function loadCachedPayloadJson(cacheKey: string): string | null {
  try {
    return localStorage.getItem(LS_PREFIX + cacheKey);
  } catch {
    return null;
  }
}

export function saveCachedPayloadJson(cacheKey: string, json: string): void {
  try {
    localStorage.setItem(LS_PREFIX + cacheKey, json);
  } catch {
    /* ignore quota */
  }
}

export function clearCachedPayloadForKey(cacheKey: string): void {
  try {
    localStorage.removeItem(LS_PREFIX + cacheKey);
  } catch {
    /* ignore */
  }
}

/** Clear all cached Upto payloads (e.g. session reset). */
export function clearAllUptoPayloadCaches(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LS_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

type AcceptsEntry = {
  scheme?: string;
  network?: string;
  payTo?: string;
  amount?: string;
};

function acceptsMatches(cachedAccepted: unknown, freshAccepts: unknown): boolean {
  if (!cachedAccepted || !freshAccepts || !Array.isArray(freshAccepts)) return false;
  const a0 = freshAccepts[0] as AcceptsEntry;
  const c = cachedAccepted as AcceptsEntry;
  return (
    c.scheme === a0.scheme &&
    c.network === a0.network &&
    c.payTo?.toLowerCase() === a0.payTo?.toLowerCase() &&
    c.amount === a0.amount
  );
}

/** If PAYMENT-REQUIRED no longer matches cached authorization, drop cache. */
export function invalidateCacheIfRequirementsDrifted(
  paymentRequired: { accepts?: unknown },
  cachedPayloadJson: string,
  cacheKey: string,
): void {
  try {
    const cached = JSON.parse(cachedPayloadJson) as { accepted?: unknown };
    if (!acceptsMatches(cached.accepted, paymentRequired.accepts)) {
      clearCachedPayloadForKey(cacheKey);
    }
  } catch {
    clearCachedPayloadForKey(cacheKey);
  }
}
