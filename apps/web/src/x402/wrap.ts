import { x402Client, x402HTTPClient } from "@x402/core/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { toClientEvmSigner } from "@x402/evm";
import type { ClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type AppEth from "@ledgerhq/hw-app-eth";
import { ledgerSignTypedData, type LedgerTypedDataMessage } from "../ledger/signTypedData";
import {
  clearCachedPayloadForKey,
  invalidateCacheIfRequirementsDrifted,
  loadCachedPayloadJson,
  saveCachedPayloadJson,
  sessionCacheKey,
} from "../lib/uptoPayloadCache";

function createUptoLedgerHttpStack(
  appEth: AppEth,
  derivationPath: string,
  address: `0x${string}`,
  rpcUrl: string,
) {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const ledgerSignerStub: Pick<ClientEvmSigner, "address" | "signTypedData"> = {
    address,
    signTypedData: async message => {
      return ledgerSignTypedData(appEth, derivationPath, message as unknown as LedgerTypedDataMessage);
    },
  };

  const signer = toClientEvmSigner(ledgerSignerStub, publicClient);
  const client = new x402Client();
  client.register("eip155:*", new UptoEvmScheme(signer, { 8453: { rpcUrl } }));
  const httpClient = new x402HTTPClient(client);
  return { client, httpClient };
}

/**
 * One Ledger signature: GET a paywalled URL without payment headers, parse 402, build + cache Upto payload.
 * Call from "Top up" / authorize — not from per-request Send.
 */
export async function prefetchUptoPaymentAuthorization(
  appEth: AppEth,
  derivationPath: string,
  address: `0x${string}`,
  rpcUrl: string,
  paymentTriggerUrl: string,
): Promise<void> {
  const { client, httpClient } = createUptoLedgerHttpStack(appEth, derivationPath, address, rpcUrl);
  const res = await fetch(paymentTriggerUrl, { cache: "no-store", method: "GET" });
  if (res.ok) {
    throw new Error(
      "Expected HTTP 402 from a paid route (e.g. GET /demo with x402 disabled). Got 200 — wrong URL or payment middleware off.",
    );
  }
  if (res.status !== 402) {
    throw new Error(`Expected HTTP 402 Payment Required, got ${res.status}`);
  }
  const getHeader = (name: string) => res.headers.get(name);
  let body: unknown;
  try {
    const responseText = await res.text();
    if (responseText) body = JSON.parse(responseText);
  } catch {
    /* empty */
  }
  const paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body);
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const cKey = sessionCacheKey(paymentTriggerUrl, address);
  saveCachedPayloadJson(cKey, JSON.stringify(paymentPayload));
}

/**
 * Ledger + Upto fetch: uses cached PAYMENT-SIGNATURE only. Does not sign on 402 — use prefetch first.
 */
export function createLedgerPaymentFetch(
  appEth: AppEth,
  derivationPath: string,
  address: `0x${string}`,
  rpcUrl: string,
): typeof fetch {
  const { httpClient } = createUptoLedgerHttpStack(appEth, derivationPath, address, rpcUrl);

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const clonedRequest = request.clone();
    const cKey = sessionCacheKey(request.url, address);

    let outbound: Request = request;
    const cachedJson = loadCachedPayloadJson(cKey);
    if (cachedJson) {
      try {
        const cachedPayload = JSON.parse(cachedJson) as never;
        const sigHeaders = httpClient.encodePaymentSignatureHeader(cachedPayload);
        outbound = new Request(input, init);
        for (const [k, v] of Object.entries(sigHeaders)) {
          outbound.headers.set(k, v);
        }
      } catch {
        clearCachedPayloadForKey(cKey);
      }
    }

    const response = await fetch(outbound);
    if (response.status !== 402) {
      return response;
    }

    let paymentRequired: Awaited<ReturnType<typeof httpClient.getPaymentRequiredResponse>>;
    try {
      const getHeader = (name: string) => response.headers.get(name);
      let body: unknown;
      try {
        const responseText = await response.text();
        if (responseText) body = JSON.parse(responseText);
      } catch {
        /* empty */
      }
      paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body);
    } catch (error) {
      throw new Error(
        `Failed to parse payment requirements: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }

    if (cachedJson) {
      invalidateCacheIfRequirementsDrifted(paymentRequired, cachedJson, cKey);
    }

    const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired);
    if (hookHeaders) {
      const hookRequest = clonedRequest.clone();
      for (const [key, value] of Object.entries(hookHeaders)) {
        hookRequest.headers.set(key, value);
      }
      const hookResponse = await fetch(hookRequest);
      if (hookResponse.status !== 402) {
        return hookResponse;
      }
    }

    const origin = (() => {
      try {
        return new URL(request.url).origin;
      } catch {
        return "this API";
      }
    })();

    throw new Error(
      `No Upto authorization cached for ${origin}. Use "Authorize Upto (top up)" once (Ledger signs the session), then Send without new prompts.`,
    );
  };
}

export { clearAllUptoPayloadCaches } from "../lib/uptoPayloadCache";
