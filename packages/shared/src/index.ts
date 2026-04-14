/** Base mainnet (CAIP-2) */
export const BASE_MAINNET_CAIP2 = "eip155:8453" as const;

/** Native USDC on Base (Circle) */
export const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export const USDC_DECIMALS = 6;

/**0.1¢ per request = $0.001 = 0.001 USDC */
export const PRICE_PER_REQUEST_ATOMIC = 1_000n;

/** Demo budget cap: 25¢ = 0.25 USDC */
export const BUDGET_CAP_ATOMIC = 250_000n;

export const EXPLORER_TX_BASE = "https://basescan.org/tx";

/** EIP-712 for receiver-authorized batch settlement (Ledger); must match server verify + client sign. */
export const SETTLE_BATCH_PRIMARY_TYPE = "SettleBatch" as const;

export const SETTLE_BATCH_EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  SettleBatch: [
    { name: "receiver", type: "address" },
    { name: "payer", type: "address" },
    { name: "accruedAtomic", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const SETTLE_BATCH_DOMAIN = {
  name: "x402-poc-receiver",
  version: "1",
  chainId: 8453n,
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
} as const;

export function formatUsdcFromAtomic(amount: bigint): string {
  const neg = amount < 0n;
  const a = neg ? -amount : amount;
  const whole = a / 10n ** BigInt(USDC_DECIMALS);
  const frac = a % 10n ** BigInt(USDC_DECIMALS);
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "") || "0";
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}

export function parseUsdcToAtomic(usdcDecimalString: string): bigint {
  const [w, f = ""] = usdcDecimalString.trim().split(".");
  const frac = (f + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(w) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac || "0");
}
