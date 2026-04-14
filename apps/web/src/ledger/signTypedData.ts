import type AppEth from "@ledgerhq/hw-app-eth";
import {
  getTypesForEIP712Domain,
  hashDomain,
  hashStruct,
  serializeSignature,
} from "viem";
import type { TypedDataDomain } from "viem";

export type LedgerTypedDataMessage = {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
};

/**
 * Sign EIP-712 via Ledger `signEIP712HashedMessage` (works on Nano S; full `signEIP712Message` is not).
 */
export async function ledgerSignTypedData(
  appEth: AppEth,
  path: string,
  msg: LedgerTypedDataMessage,
): Promise<`0x${string}`> {
  const rawTypes = msg.types as Record<string, Array<{ name: string; type: string }>>;
  // Permit2 (and some wallets) omit EIP712Domain from `types`; viem's hashTypedData injects it — required for hashDomain().
  const types = {
    ...rawTypes,
    EIP712Domain: rawTypes.EIP712Domain ?? getTypesForEIP712Domain({ domain: msg.domain as TypedDataDomain }),
  };
  const domainSeparator = hashDomain({
    domain: msg.domain,
    types,
  });
  const hashStructMessage = hashStruct({
    data: msg.message,
    primaryType: msg.primaryType,
    types,
  });
  const { r, s, v } = await appEth.signEIP712HashedMessage(
    path,
    domainSeparator.replace(/^0x/, ""),
    hashStructMessage.replace(/^0x/, ""),
  );
  let vBig = BigInt(v);
  if (vBig === 0n || vBig === 1n) {
    vBig += 27n;
  }
  return serializeSignature({
    r: (`0x${r}` as `0x${string}`).length === 66 ? (`0x${r}` as `0x${string}`) : (`0x${r.padStart(64, "0")}` as `0x${string}`),
    s: (`0x${s}` as `0x${string}`).length === 66 ? (`0x${s}` as `0x${string}`) : (`0x${s.padStart(64, "0")}` as `0x${string}`),
    v: vBig,
  });
}
