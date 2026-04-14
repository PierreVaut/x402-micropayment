/**
 * In-memory accrual per payer for deferred Upto settlement (POC).
 * Production should use durable storage + replay/idempotency guards.
 */

import type { PaymentRequirements } from "@x402/express";

export type PaymentPayloadV2 = {
  x402Version: number;
  payload: unknown;
  accepted: PaymentRequirements;
  resource?: unknown;
  extensions?: unknown;
};

export type PendingBatch = {
  payer: `0x${string}`;
  accruedAtomic: bigint;
  requestCount: number;
  lastPaymentPayload: PaymentPayloadV2;
  lastRequirements: PaymentRequirements;
};

const byPayer = new Map<string, PendingBatch>();

function key(addr: string): string {
  return addr.toLowerCase();
}

export function accrueVerifiedPayment(
  payer: `0x${string}`,
  paymentPayload: PaymentPayloadV2,
  requirements: PaymentRequirements,
  deltaAtomic: bigint,
): void {
  const k = key(payer);
  const cur = byPayer.get(k);
  if (!cur) {
    byPayer.set(k, {
      payer,
      accruedAtomic: deltaAtomic,
      requestCount: 1,
      lastPaymentPayload: paymentPayload,
      lastRequirements: requirements,
    });
    return;
  }
  cur.accruedAtomic += deltaAtomic;
  cur.requestCount += 1;
  cur.lastPaymentPayload = paymentPayload;
  cur.lastRequirements = requirements;
}

export function listPending(): PendingBatch[] {
  return [...byPayer.values()].filter(b => b.accruedAtomic > 0n);
}

export function getPending(payer: `0x${string}`): PendingBatch | undefined {
  return byPayer.get(key(payer));
}

/** Remove batch after successful on-chain settlement. */
export function clearPending(payer: `0x${string}`): void {
  byPayer.delete(key(payer));
}

/**
 * Take snapshot for settlement (caller settles on-chain, then must clear).
 */
export function takeForSettle(payer: `0x${string}`): PendingBatch | null {
  const b = byPayer.get(key(payer));
  if (!b || b.accruedAtomic <= 0n) return null;
  return {
    payer: b.payer,
    accruedAtomic: b.accruedAtomic,
    requestCount: b.requestCount,
    lastPaymentPayload: b.lastPaymentPayload,
    lastRequirements: b.lastRequirements,
  };
}
