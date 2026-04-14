/**
 * One-time EIP-712 challenges for POST /settle (receiver signs on Ledger).
 */

import { randomBytes } from "node:crypto";
import { getPending } from "./settlementQueue.js";

export type SettleChallenge = {
  payer: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
  accruedAtomic: bigint;
};

const store = new Map<string, SettleChallenge>();

function payerKey(addr: string): string {
  return addr.toLowerCase();
}

function challengeKey(payer: string, nonce: bigint): string {
  return `${payerKey(payer)}|${nonce.toString()}`;
}

function purgeExpired(): void {
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const [k, v] of store) {
    if (v.deadline < now) store.delete(k);
  }
}

/** Create a challenge for the current pending accrual snapshot (or null if none). */
export function createSettleChallenge(payer: `0x${string}`): SettleChallenge | null {
  purgeExpired();
  const batch = getPending(payer);
  if (!batch || batch.accruedAtomic <= 0n) return null;
  const nonce = BigInt(`0x${randomBytes(32).toString("hex")}`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 15 * 60);
  const rec: SettleChallenge = {
    payer: batch.payer,
    nonce,
    deadline,
    accruedAtomic: batch.accruedAtomic,
  };
  store.set(challengeKey(payer, nonce), rec);
  return rec;
}

/** Peek a challenge without consuming (for debugging); prefer consume after verify. */
export function getSettleChallenge(payer: `0x${string}`, nonce: bigint): SettleChallenge | null {
  purgeExpired();
  return store.get(challengeKey(payer, nonce)) ?? null;
}

export function deleteSettleChallenge(payer: `0x${string}`, nonce: bigint): void {
  store.delete(challengeKey(payer, nonce));
}
