import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  paymentMiddleware,
  setSettlementOverrides,
  x402ResourceServer,
  type PaymentRequirements,
} from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import {
  BASE_MAINNET_CAIP2,
  BUDGET_CAP_ATOMIC,
  EXPLORER_TX_BASE,
  PRICE_PER_REQUEST_ATOMIC,
  formatUsdcFromAtomic,
} from "@x402-poc/shared";
import { getAddress, verifyTypedData } from "viem";
import {
  SETTLE_BATCH_DOMAIN,
  SETTLE_BATCH_EIP712_TYPES,
  SETTLE_BATCH_PRIMARY_TYPE,
} from "@x402-poc/shared";
import {
  accrueVerifiedPayment,
  clearPending,
  getPending,
  listPending,
  takeForSettle,
  type PaymentPayloadV2,
  type PendingBatch,
} from "./settlementQueue.js";
import {
  createSettleChallenge,
  deleteSettleChallenge,
  getSettleChallenge,
} from "./settleChallenge.js";

const payTo = process.env.PAY_TO_ADDRESS as `0x${string}` | undefined;
if (!payTo) {
  throw new Error("Set PAY_TO_ADDRESS to your Base mainnet EVM address (receives USDC).");
}

const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://x402.dexter.cash";
const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173").split(",").map(s => s.trim());

/** Session permit cap aligned with agent budget cap (USDC). */
const SESSION_CAP_PRICE = `$${formatUsdcFromAtomic(BUDGET_CAP_ATOMIC)}`;

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(BASE_MAINNET_CAIP2, new UptoEvmScheme());

resourceServer.onAfterVerify(async ctx => {
  const raw = ctx.paymentPayload.payload as { permit2Authorization?: { from?: string } } | undefined;
  const from = raw?.permit2Authorization?.from;
  if (!from || !from.startsWith("0x")) return;
  accrueVerifiedPayment(
    from as `0x${string}`,
    ctx.paymentPayload as PaymentPayloadV2,
    ctx.requirements as PaymentRequirements,
    PRICE_PER_REQUEST_ATOMIC,
  );
});

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE", "X-PAYMENT"],
    exposedHeaders: [
      "PAYMENT-REQUIRED",
      "PAYMENT-RESPONSE",
      "X-PAYMENT-RESPONSE",
      "PAYMENT-SIGNATURE",
      "X-PAYMENT",
    ],
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** Public: configured USDC receiver (must sign batch settle on Ledger). */
app.get("/config", (_req, res) => {
  res.json({ payToAddress: getAddress(payTo) });
});

/** Receiver: EIP-712 challenge for POST /settle (Ledger signs as payToAddress). */
app.get("/settle/challenge", (req, res) => {
  const payerRaw = (req.query.payer as string | undefined)?.trim();
  if (!payerRaw?.startsWith("0x")) {
    res.status(400).json({ error: 'Query param payer=0x... required.' });
    return;
  }
  const rec = createSettleChallenge(payerRaw as `0x${string}`);
  if (!rec) {
    res.status(404).json({ error: "No pending accrual for that payer." });
    return;
  }
  const receiver = getAddress(payTo);
  const payerAddr = getAddress(rec.payer);
  // Client signs with shared domain/types from @x402-poc/shared (JSON cannot encode bigint chainId).
  res.json({
    message: {
      receiver,
      payer: payerAddr,
      accruedAtomic: rec.accruedAtomic.toString(),
      nonce: rec.nonce.toString(),
      deadline: rec.deadline.toString(),
    },
  });
});

/** Receiver: list accrued batches (POC). */
app.get("/settle/pending", (_req, res) => {
  const pending = listPending().map((b: PendingBatch) => ({
    payer: b.payer,
    accruedAtomic: b.accruedAtomic.toString(),
    requestCount: b.requestCount,
  }));
  res.json({ pending });
});

/** Receiver: settle one payer's accrued total on-chain (single L2 tx); requires Ledger signature from PAY_TO_ADDRESS. */
app.post("/settle", async (req, res) => {
  const payerRaw = req.body?.payer as string | undefined;
  const signature = req.body?.signature as string | undefined;
  const nonceRaw = req.body?.nonce as string | undefined;
  if (!payerRaw?.startsWith("0x")) {
    res.status(400).json({ error: 'Body must include payer: "0x..."' });
    return;
  }
  if (!signature?.startsWith("0x")) {
    res.status(400).json({ error: 'Body must include signature: "0x..."' });
    return;
  }
  let nonce: bigint;
  try {
    nonce = BigInt(nonceRaw ?? "");
  } catch {
    res.status(400).json({ error: "Body must include nonce from /settle/challenge." });
    return;
  }
  const payer = payerRaw as `0x${string}`;
  const rec = getSettleChallenge(payer, nonce);
  if (!rec) {
    res.status(400).json({
      error: "Unknown or expired settle challenge. GET /settle/challenge?payer=... first.",
    });
    return;
  }
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (rec.deadline < now) {
    deleteSettleChallenge(payer, nonce);
    res.status(400).json({ error: "Settle challenge expired." });
    return;
  }
  const cur = getPending(payer);
  if (!cur || cur.accruedAtomic !== rec.accruedAtomic) {
    res.status(409).json({
      error: "Accrual changed since challenge was issued. Request a new challenge.",
    });
    return;
  }
  const receiver = getAddress(payTo);
  const payerAddr = getAddress(rec.payer);
  const message = {
    receiver,
    payer: payerAddr,
    accruedAtomic: rec.accruedAtomic,
    nonce: rec.nonce,
    deadline: rec.deadline,
  };
  const ok = await verifyTypedData({
    address: receiver,
    domain: SETTLE_BATCH_DOMAIN,
    types: { SettleBatch: [...SETTLE_BATCH_EIP712_TYPES.SettleBatch] },
    primaryType: SETTLE_BATCH_PRIMARY_TYPE,
    message,
    signature: signature as `0x${string}`,
  });
  if (!ok) {
    res.status(401).json({ error: "Invalid receiver signature (sign with Ledger for PAY_TO_ADDRESS)." });
    return;
  }
  deleteSettleChallenge(payer, nonce);
  const batch = takeForSettle(payer);
  if (!batch) {
    res.status(400).json({ error: "No pending accrual for that payer." });
    return;
  }
  try {
    const requirementsWithPayTo = { ...batch.lastRequirements, payTo } as PaymentRequirements;
    // #region agent log
    const _reqStr = JSON.stringify(requirementsWithPayTo, (_k, v) => typeof v === "bigint" ? v.toString() : v);
    fetch('http://127.0.0.1:7632/ingest/d35131a6-a7ca-4321-8e6a-d02af3bb921e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'40d4fe'},body:JSON.stringify({sessionId:'40d4fe',location:'index.ts:settleInput',message:'settle inputs',data:{accruedAtomic:batch.accruedAtomic.toString(),requestCount:batch.requestCount,reqAmount:requirementsWithPayTo.amount,reqScheme:(requirementsWithPayTo as Record<string,unknown>).scheme,reqPayTo:(requirementsWithPayTo as Record<string,unknown>).payTo,overrideAmount:batch.accruedAtomic.toString(),requirements:_reqStr.slice(0,1500)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const result = await resourceServer.settlePayment(
      batch.lastPaymentPayload as never,
      requirementsWithPayTo as never,
      undefined,
      {},
      { amount: batch.accruedAtomic.toString() },
    );
    const settled = result as { success?: boolean; errorReason?: string; transaction?: unknown };
    // #region agent log
    const _resultKeys = Object.keys(result as object);
    const _resultStr = JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v);
    fetch('http://127.0.0.1:7632/ingest/d35131a6-a7ca-4321-8e6a-d02af3bb921e',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'40d4fe'},body:JSON.stringify({sessionId:'40d4fe',location:'index.ts:settleResult',message:'raw settlePayment result',data:{keys:_resultKeys,raw:_resultStr.slice(0,2000),txType:typeof settled.transaction,txValue:typeof settled.transaction === 'object' ? JSON.stringify(settled.transaction,(_k,v)=>typeof v==='bigint'?v.toString():v) : String(settled.transaction)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (settled.success === false) {
      res.status(502).json({
        error: settled.errorReason ?? "Settlement failed",
        details: settled,
      });
      return;
    }
    clearPending(batch.payer);
    let tx = "";
    if (typeof settled.transaction === "string" && settled.transaction.startsWith("0x")) {
      tx = settled.transaction;
    } else if (settled.transaction && typeof settled.transaction === "object" && "hash" in settled.transaction) {
      const h = (settled.transaction as { hash: unknown }).hash;
      if (typeof h === "string") tx = h;
    }
    res.json({
      ok: true,
      payer: batch.payer,
      settledAtomic: batch.accruedAtomic.toString(),
      requestCount: batch.requestCount,
      transaction: tx,
      explorerUrl: tx ? `${EXPLORER_TX_BASE}/${tx}` : null,
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({
      error: e instanceof Error ? e.message : "Settlement error",
    });
  }
});

app.use(
  paymentMiddleware(
    {
      "GET /demo": {
        accepts: {
          scheme: "upto",
          price: SESSION_CAP_PRICE,
          network: BASE_MAINNET_CAIP2,
          payTo,
          maxTimeoutSeconds: 86_400,
        },
        description: "x402 POC demo — session Upto cap; $0.001 accrues server-side per call; receiver settles batch.",
        mimeType: "application/json",
        extensions: { eip2612GasSponsoring: true },
      },
    },
    resourceServer,
    undefined,
    undefined,
    true,
  ),
);

app.get("/demo", (_req, res) => {
  setSettlementOverrides(res, { amount: "0" });
  res.json({
    ok: true,
    message: "Paid demo resource (deferred settlement; accrual per request)",
    x402: { deferredSettlement: true, perRequestAtomic: PRICE_PER_REQUEST_ATOMIC.toString() },
  });
});

const port = Number(process.env.PORT ?? 4020);
app.listen(port, () => {
  console.log(`x402 POC server listening on http://localhost:${port}`);
  console.log(`Facilitator: ${facilitatorUrl}`);
  console.log(`Upto session cap price: ${SESSION_CAP_PRICE}`);
});
