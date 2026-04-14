import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BASE_MAINNET_CAIP2,
  BASE_MAINNET_USDC,
  BUDGET_CAP_ATOMIC,
  EXPLORER_TX_BASE,
  PRICE_PER_REQUEST_ATOMIC,
  SETTLE_BATCH_DOMAIN,
  SETTLE_BATCH_EIP712_TYPES,
  SETTLE_BATCH_PRIMARY_TYPE,
  USDC_DECIMALS,
  formatUsdcFromAtomic,
} from "@x402-poc/shared";
import { createPublicClient, formatUnits, http } from "viem";
import { base } from "viem/chains";
import { erc20Abi } from "viem";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { createLedgerTransport, getLedgerEthApp, findAddressPath, type LedgerTransportKind, type LedgerPathScheme } from "./ledger/connect";
import { ledgerSignTypedData } from "./ledger/signTypedData";
import {
  clearAllUptoPayloadCaches,
  createLedgerPaymentFetch,
  prefetchUptoPaymentAuthorization,
} from "./x402/wrap";
import {
  clearBudget,
  defaultCapAtomic,
  loadBudget,
  saveBudget,
  type PersistedBudget,
} from "./lib/storage";

function defaultApiBase(): string {
  return import.meta.env.VITE_DEFAULT_API_BASE ?? "http://localhost:4020";
}

function defaultRpc(): string {
  return import.meta.env.VITE_BASE_RPC ?? "https://mainnet.base.org";
}

function parseHeaders(text: string): Headers {
  const h = new Headers();
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    h.set(k, v);
  }
  return h;
}

function headersToRecord(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => {
    o[k] = v;
  });
  return o;
}

/** CORS may expose PAYMENT-RESPONSE or X-PAYMENT-RESPONSE depending on stack / version. */
function getPaymentResponseHeader(res: Response): string | null {
  return res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
}

function settlementTxHash(decoded: unknown): string | null {
  if (!decoded || typeof decoded !== "object") return null;
  const row = decoded as { transaction?: unknown };
  const t = row.transaction;
  if (typeof t === "string" && t.startsWith("0x")) return t;
  if (t && typeof t === "object" && "hash" in t && typeof (t as { hash: unknown }).hash === "string") {
    return (t as { hash: string }).hash;
  }
  return null;
}

function spentDeltaFromSettlement(decoded: unknown): bigint {
  if (!decoded || typeof decoded !== "object") return PRICE_PER_REQUEST_ATOMIC;
  const a = (decoded as { amount?: unknown }).amount;
  if (typeof a === "string" && /^\d+$/.test(a)) return BigInt(a);
  return PRICE_PER_REQUEST_ATOMIC;
}

/** PAYMENT-RESPONSE after a deferred micro-call: success with no on-chain tx yet. */
function isDeferredMicroSettlement(decoded: Record<string, unknown> | null): boolean {
  if (!decoded || decoded.success !== true) return false;
  const tx = settlementTxHash(decoded);
  return !tx || tx === "";
}

export function App() {
  const rpcUrl = defaultRpc();
  const [transportKind, setTransportKind] = useState<LedgerTransportKind>("hid");
  const [accountIndex, setAccountIndex] = useState(0);
  const [pathScheme, setPathScheme] = useState<LedgerPathScheme>("ledger-live");
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [ledgerAddress, setLedgerAddress] = useState<`0x${string}` | null>(null);
  const [appEthRef, setAppEthRef] = useState<{ app: import("@ledgerhq/hw-app-eth").default; path: string } | null>(
    null,
  );

  const [budget, setBudget] = useState<PersistedBudget | null>(null);
  const [budgetHydrated, setBudgetHydrated] = useState(false);

  useEffect(() => {
    void loadBudget().then(b => {
      setBudget(b);
      setBudgetHydrated(true);
    });
  }, []);

  useEffect(() => {
    void fetch(`${defaultApiBase()}/config`, { cache: "no-store" })
      .then(r => r.json() as Promise<{ payToAddress?: string }>)
      .then(j => setServerPayTo(j.payToAddress ?? null))
      .catch(() => setServerPayTo(null));
  }, []);

  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState(`${defaultApiBase()}/health`);
  const [headersText, setHeadersText] = useState("");
  const [body, setBody] = useState("");
  const [useX402, setUseX402] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [respStatus, setRespStatus] = useState<number | null>(null);
  const [respHeaders, setRespHeaders] = useState<Record<string, string> | null>(null);
  const [respBody, setRespBody] = useState<string | null>(null);

  const [chainUsdcBalance, setChainUsdcBalance] = useState<string | null>(null);
  const [settlementTxs, setSettlementTxs] = useState<string[]>([]);

  const [settlePayer, setSettlePayer] = useState("");
  const [serverPayTo, setServerPayTo] = useState<string | null>(null);
  const [pendingAccruals, setPendingAccruals] = useState<{ payer: string; accruedAtomic: string; requestCount: number }[]>(
    [],
  );
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleMessage, setSettleMessage] = useState<string | null>(null);

  const cap = budget ? BigInt(budget.capAtomic) : 0n;
  const spent = budget ? BigInt(budget.spentAtomic) : 0n;
  const remaining = cap > spent ? cap - spent : 0n;

  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: base,
        transport: http(rpcUrl),
      }),
    [rpcUrl],
  );

  useEffect(() => {
    if (ledgerAddress) setSettlePayer(ledgerAddress);
  }, [ledgerAddress]);

  useEffect(() => {
    if (!ledgerAddress) {
      setChainUsdcBalance(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const bal = await publicClient.readContract({
          address: BASE_MAINNET_USDC,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [ledgerAddress],
        });
        if (!cancelled) {
          setChainUsdcBalance(formatUnits(bal, USDC_DECIMALS));
        }
      } catch {
        if (!cancelled) setChainUsdcBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ledgerAddress, publicClient]);

  const connectLedger = useCallback(async () => {
    setLedgerError(null);
    setLedgerBusy(true);
    try {
      const transport = await createLedgerTransport(transportKind);
      const { app, address, path } = await getLedgerEthApp(transport, accountIndex, pathScheme);
      setLedgerAddress(address);
      setAppEthRef({ app, path });
    } catch (e) {
      setLedgerError(e instanceof Error ? e.message : String(e));
      setLedgerAddress(null);
      setAppEthRef(null);
    } finally {
      setLedgerBusy(false);
    }
  }, [transportKind, accountIndex, pathScheme]);

  const topUpBudget = useCallback(async () => {
    if (!appEthRef || !ledgerAddress) {
      setLedgerError("Connect Ledger first.");
      return;
    }
    setLedgerError(null);
    setLedgerBusy(true);
    try {
      const authorizeUrl = `${defaultApiBase()}/demo`;
      await prefetchUptoPaymentAuthorization(
        appEthRef.app,
        appEthRef.path,
        ledgerAddress,
        rpcUrl,
        authorizeUrl,
      );
      const capAtomic = defaultCapAtomic();
      const next: PersistedBudget = {
        capAtomic: capAtomic.toString(),
        spentAtomic: "0",
        ledgerAddress,
        authorizedAt: Date.now(),
      };
      await saveBudget(next);
      setBudget(next);
    } catch (e) {
      setLedgerError(e instanceof Error ? e.message : String(e));
    } finally {
      setLedgerBusy(false);
    }
  }, [appEthRef, ledgerAddress, rpcUrl]);

  const applyBlankHealth = () => {
    setMethod("GET");
    setUrl(`${defaultApiBase()}/health`);
    setHeadersText("");
    setBody("");
    setUseX402(false);
  };

  const applyBlankDemoUnpaid = () => {
    setMethod("GET");
    setUrl(`${defaultApiBase()}/demo`);
    setHeadersText("");
    setBody("");
    setUseX402(false);
  };

  const applyPaidDemo = () => {
    setMethod("GET");
    setUrl(`${defaultApiBase()}/demo`);
    setHeadersText("");
    setBody("");
    setUseX402(true);
  };

  const rawPreviewInitial = useMemo(() => {
    const h = parseHeaders(headersText);
    let bodyPart = "";
    if (body.trim() && !["GET", "HEAD"].includes(method.toUpperCase())) {
      bodyPart = `\n\n${body}`;
    }
    const headerLines = [...h.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    return `${method.toUpperCase()} ${url} HTTP/1.1\n${headerLines || "(no headers)"}${bodyPart}`;
  }, [method, url, headersText, body]);

  const sendRequest = async () => {
    setLastError(null);
    setBusy(true);
    setRespStatus(null);
    setRespHeaders(null);
    setRespBody(null);
    try {
      if (useX402) {
        if (!appEthRef || !ledgerAddress) {
          throw new Error("Connect Ledger before paying with x402.");
        }
        if (!budget) {
          throw new Error('Authorize Upto first: click "Authorize Upto (top up)" (one Ledger signature for the session).');
        }
        if (budget.ledgerAddress.toLowerCase() !== ledgerAddress.toLowerCase()) {
          throw new Error("Saved session is for another Ledger account. Authorize Upto again on this device.");
        }
        if (spent + PRICE_PER_REQUEST_ATOMIC > cap) {
          throw new Error("Agent budget exceeded. Top up or settle session.");
        }
      }

      const hdrs = parseHeaders(headersText);
      const init: RequestInit = {
        method,
        headers: hdrs,
        // Avoid cached GET 200 without PAYMENT-RESPONSE (breaks session spend + settlement UI).
        cache: useX402 ? "no-store" : "default",
      };
      if (body.trim() && !["GET", "HEAD"].includes(method.toUpperCase())) {
        init.body = body;
      }

      const payFetch =
        useX402 && appEthRef && ledgerAddress
          ? createLedgerPaymentFetch(appEthRef.app, appEthRef.path, ledgerAddress, rpcUrl)
          : fetch;

      const response = await payFetch(url, init);
      const text = await response.text();
      setRespStatus(response.status);
      setRespHeaders(headersToRecord(response.headers));

      let displayBody = text;
      if (response.status === 402) {
        const prHdr = response.headers.get("PAYMENT-REQUIRED");
        if (prHdr) {
          try {
            const decoded = decodePaymentRequiredHeader(prHdr);
            displayBody = `=== PAYMENT-REQUIRED (decoded) ===\n${JSON.stringify(decoded, null, 2)}\n\n=== Response body ===\n${text || "{}"}`;
          } catch {
            displayBody = `=== PAYMENT-REQUIRED (raw header) ===\n${prHdr.slice(0, 2000)}${prHdr.length > 2000 ? "…" : ""}\n\n=== Body ===\n${text}`;
          }
        }
      }

      const payHdr = getPaymentResponseHeader(response);
      let settlementDecoded: Record<string, unknown> | null = null;
      if (payHdr) {
        try {
          settlementDecoded = decodePaymentResponseHeader(payHdr) as Record<string, unknown>;
          const tx = settlementTxHash(settlementDecoded);
          if (tx) {
            setSettlementTxs(prev => (prev.includes(tx) ? prev : [...prev, tx]));
          }
        } catch {
          /* ignore */
        }
      }

      if (settlementDecoded && response.ok && response.status !== 402) {
        const tx = settlementTxHash(settlementDecoded);
        const deferredMicro = isDeferredMicroSettlement(settlementDecoded);
        const x402: Record<string, unknown> = {};
        if (typeof settlementDecoded.success === "boolean") x402.success = settlementDecoded.success;
        if (typeof settlementDecoded.network === "string") x402.network = settlementDecoded.network;
        if (settlementDecoded.payer) x402.payer = settlementDecoded.payer;
        if (deferredMicro) x402.deferredAccrual = true;
        if (tx) {
          x402.transaction = tx;
          x402.explorerUrl = `${EXPLORER_TX_BASE}/${tx}`;
        }
        try {
          const bodyObj = JSON.parse(text) as Record<string, unknown>;
          bodyObj.x402 = x402;
          displayBody = JSON.stringify(bodyObj, null, 2);
        } catch {
          displayBody = `${text}\n\n=== x402 settlement ===\n${JSON.stringify(x402, null, 2)}`;
        }
      }

      try {
        const asJson = JSON.parse(displayBody);
        setRespBody(JSON.stringify(asJson, null, 2));
      } catch {
        setRespBody(displayBody);
      }

      const paidWithX402 = useX402 && response.ok && !!payHdr && budget;
      if (paidWithX402) {
        const deferredMicro = settlementDecoded ? isDeferredMicroSettlement(settlementDecoded) : false;
        const delta = deferredMicro
          ? PRICE_PER_REQUEST_ATOMIC
          : settlementDecoded
            ? spentDeltaFromSettlement(settlementDecoded)
            : PRICE_PER_REQUEST_ATOMIC;
        const nextSpent = BigInt(budget.spentAtomic) + delta;
        const next: PersistedBudget = { ...budget, spentAtomic: nextSpent.toString() };
        await saveBudget(next);
        setBudget(next);
      }
    } catch (e) {
      setLastError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const resetSession = () => {
    clearAllUptoPayloadCaches();
    void clearBudget().then(() => {
      setBudget(null);
      setSettlementTxs([]);
    });
  };

  const fetchPendingAccruals = useCallback(async () => {
    setSettleMessage(null);
    setSettleBusy(true);
    try {
      const r = await fetch(`${defaultApiBase()}/settle/pending`, {
        cache: "no-store",
      });
      const j = (await r.json()) as { pending?: typeof pendingAccruals };
      if (!r.ok) {
        setSettleMessage((j as { error?: string }).error ?? `HTTP ${r.status}`);
        setPendingAccruals([]);
        return;
      }
      setPendingAccruals(j.pending ?? []);
    } catch (e) {
      setSettleMessage(e instanceof Error ? e.message : String(e));
      setPendingAccruals([]);
    } finally {
      setSettleBusy(false);
    }
  }, []);

  const settleAccruedBatch = useCallback(async () => {
    setSettleMessage(null);
    if (!settlePayer.trim()) {
      setSettleMessage("Enter payer address (agent wallet that accrued USDC).");
      return;
    }
    if (!appEthRef) {
      setSettleMessage("Connect Ledger first (any account). Settlement will auto-discover the PAY_TO account.");
      return;
    }

    setSettleBusy(true);
    try {
      let signApp = appEthRef.app;
      let signPath = appEthRef.path;

      if (serverPayTo && ledgerAddress?.toLowerCase() !== serverPayTo.toLowerCase()) {
        setSettleMessage("Scanning Ledger for PAY_TO account…");
        const found = await findAddressPath(signApp, serverPayTo);
        if (!found) {
          setSettleMessage(
            `Could not find PAY_TO address on this Ledger.\nExpected: ${serverPayTo}\nScanned Ledger Live & Legacy paths, indices 0-4.`,
          );
          return;
        }
        signPath = found.path;
        setSettleMessage(`Found PAY_TO at ${found.scheme} #${found.accountIndex}. Signing…`);
      }

      const chRes = await fetch(
        `${defaultApiBase()}/settle/challenge?payer=${encodeURIComponent(settlePayer.trim())}`,
        { cache: "no-store" },
      );
      const chBody = (await chRes.json()) as {
        message?: {
          receiver: string;
          payer: string;
          accruedAtomic: string;
          nonce: string;
          deadline: string;
        };
        error?: string;
      };
      if (!chRes.ok) {
        setSettleMessage(chBody.error ?? `Challenge HTTP ${chRes.status}`);
        return;
      }
      const msg = chBody.message;
      if (!msg) {
        setSettleMessage("Invalid challenge response.");
        return;
      }
      const sig = await ledgerSignTypedData(signApp, signPath, {
        domain: { ...SETTLE_BATCH_DOMAIN } as Record<string, unknown>,
        types: SETTLE_BATCH_EIP712_TYPES as Record<string, unknown>,
        primaryType: SETTLE_BATCH_PRIMARY_TYPE,
        message: {
          receiver: msg.receiver,
          payer: msg.payer,
          accruedAtomic: BigInt(msg.accruedAtomic),
          nonce: BigInt(msg.nonce),
          deadline: BigInt(msg.deadline),
        },
      });
      const r = await fetch(`${defaultApiBase()}/settle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ payer: settlePayer.trim(), signature: sig, nonce: msg.nonce }),
        cache: "no-store",
      });
      const j = (await r.json()) as {
        ok?: boolean;
        transaction?: string;
        explorerUrl?: string | null;
        settledAtomic?: string;
        requestCount?: number;
        error?: string;
      };
      if (!r.ok) {
        setSettleMessage(j.error ?? `HTTP ${r.status}`);
        return;
      }
      const count = j.requestCount ?? 0;
      const amount = j.settledAtomic ? formatUsdcFromAtomic(BigInt(j.settledAtomic)) : "?";
      if (j.transaction) {
        setSettlementTxs(prev => (prev.includes(j.transaction!) ? prev : [...prev, j.transaction!]));
        const url = j.explorerUrl ?? `${EXPLORER_TX_BASE}/${j.transaction}`;
        setSettleMessage(`Settled ✓ — ${count} request${count !== 1 ? "s" : ""}, ${amount} USDC\nTx: ${j.transaction}`);
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        setSettleMessage(`Settled ✓ — ${count} request${count !== 1 ? "s" : ""}, ${amount} USDC (no on-chain tx hash returned)`);
      }
      await fetchPendingAccruals();
    } catch (e) {
      setSettleMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSettleBusy(false);
    }
  }, [settlePayer, fetchPendingAccruals, appEthRef, ledgerAddress, serverPayTo]);

  const latestTx = settlementTxs.length ? settlementTxs[settlementTxs.length - 1] : null;

  return (
    <div className="app">
      <h1 style={{ fontSize: "1.35rem", marginBottom: "0.25rem" }}>x402 agent · Base</h1>
      <p style={{ color: "#7a8fa3", marginTop: 0, fontSize: "0.9rem" }}>
        {formatUsdcFromAtomic(PRICE_PER_REQUEST_ATOMIC)} USDC per call · Upto cap{" "}
        {formatUsdcFromAtomic(BUDGET_CAP_ATOMIC)} USDC · one Ledger sign at top-up
      </p>

      {!budgetHydrated && <p className="status-ok">Loading saved session…</p>}

      <div className="grid grid-2" style={{ marginTop: "1.25rem" }}>
        <div className="card">
          <h2>Agent balance</h2>
          <div className="label">Session cap (matches server Upto / agent budget)</div>
          <div className="balance-big">{budget ? `${formatUsdcFromAtomic(cap)} USDC` : "—"}</div>
          <div className="label" style={{ marginTop: "0.75rem" }}>
            Spent (session) / Remaining
          </div>
          <div>
            {budget ? (
              <>
                <strong>{formatUsdcFromAtomic(spent)}</strong> / <strong>{formatUsdcFromAtomic(remaining)}</strong>{" "}
                USDC
              </>
            ) : (
              "—"
            )}
          </div>
          {ledgerAddress && (
            <>
              <div className="label" style={{ marginTop: "0.75rem" }}>
                On-chain USDC (wallet)
              </div>
              <div>{chainUsdcBalance !== null ? `${chainUsdcBalance} USDC` : "…"}</div>
              <div className="mono" style={{ marginTop: "0.5rem", fontSize: "0.72rem" }}>
                {ledgerAddress}
              </div>
            </>
          )}
        </div>

        <div className="card">
          <h2>Ledger</h2>
          <div className="row" style={{ marginBottom: "0.75rem", gap: "1rem" }}>
            <label>
              Transport{" "}
              <select value={transportKind} onChange={e => setTransportKind(e.target.value as LedgerTransportKind)}>
                <option value="hid">USB (WebHID)</option>
                <option value="ble">Bluetooth (Nano X)</option>
              </select>
            </label>
            <label>
              Account{" "}
              <select value={accountIndex} onChange={e => setAccountIndex(Number(e.target.value))}>
                {[0, 1, 2, 3, 4].map(i => (
                  <option key={i} value={i}>#{i}</option>
                ))}
              </select>
            </label>
            <label>
              Path{" "}
              <select value={pathScheme} onChange={e => setPathScheme(e.target.value as LedgerPathScheme)}>
                <option value="ledger-live">Ledger Live</option>
                <option value="legacy">Legacy (MEW)</option>
              </select>
            </label>
          </div>
          <div className="row">
            <button type="button" className="btn secondary" disabled={ledgerBusy} onClick={() => void connectLedger()}>
              {ledgerBusy ? "Working…" : "Connect Ledger"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={ledgerBusy || !appEthRef}
              onClick={() => void topUpBudget()}
            >
              Authorize Upto (top up)
            </button>
          </div>
          {ledgerError && <p className="status-err">{ledgerError}</p>}
          {!ledgerError && ledgerAddress && <p className="status-ok">Ledger ready</p>}
          <p style={{ fontSize: "0.78rem", color: "#7a8fa3", marginBottom: 0 }}>
            Top up signs the Upto Permit2 payload once. Further Sends reuse it with no Ledger prompt.
            Switch account index to use a different derivation path (e.g. receiver for settlement).
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <h2>HTTP</h2>
        <div className="row" style={{ marginBottom: "0.5rem" }}>
          <label>
            Method{" "}
            <input value={method} onChange={e => setMethod(e.target.value)} style={{ width: "6rem" }} />
          </label>
          <input value={url} onChange={e => setUrl(e.target.value)} style={{ flex: 1, minWidth: "200px" }} />
        </div>
        <div className="label">Headers (one per line, Key: Value)</div>
        <textarea value={headersText} onChange={e => setHeadersText(e.target.value)} spellCheck={false} />
        <div className="label">Body</div>
        <textarea value={body} onChange={e => setBody(e.target.value)} spellCheck={false} />
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <label>
            <input type="checkbox" checked={useX402} onChange={e => setUseX402(e.target.checked)} /> Pay with x402
            (reuses cached Upto from top up — no Ledger prompt per Send)
          </label>
        </div>
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <button type="button" className="btn ghost" onClick={applyBlankHealth}>
            Blank: GET /health
          </button>
          <button type="button" className="btn ghost" onClick={applyBlankDemoUnpaid}>
            Blank: GET /demo (unpaid)
          </button>
          <button type="button" className="btn ghost" onClick={applyPaidDemo}>
            Paid: GET /demo (x402)
          </button>
        </div>
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button type="button" className="btn secondary" onClick={() => setShowRaw(s => !s)}>
            {showRaw ? "Hide" : "View"} raw request
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void sendRequest()}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
        {showRaw && (
          <div className="mono" style={{ marginTop: "0.75rem" }}>
            {rawPreviewInitial}
            {useX402 ? "\n\n# x402: PAYMENT-SIGNATURE from cached Upto (authorize via Top up first)" : ""}
          </div>
        )}
      </div>

      <div className="grid grid-2" style={{ marginTop: "1rem" }}>
        <div className="card">
          <h2>Response</h2>
          {lastError && <p className="status-err">{lastError}</p>}
          {respStatus !== null && (
            <>
              <div className="label">Status</div>
              <div>{respStatus}</div>
              <div className="label" style={{ marginTop: "0.5rem" }}>
                Headers
              </div>
              <pre className="mono" style={{ maxHeight: "160px" }}>
                {JSON.stringify(respHeaders, null, 2)}
              </pre>
              <div className="label">Body</div>
              <pre className="mono">{respBody}</pre>
            </>
          )}
          {respStatus === null && !lastError && <p style={{ color: "#7a8fa3" }}>No response yet.</p>}
        </div>

        <div className="card">
          <h2>Settlement (on-chain)</h2>

          {latestTx ? (
            <>
              <div className="label">Latest settlement tx</div>
              <div className="mono" style={{ fontSize: "0.72rem", marginBottom: "0.5rem" }}>{latestTx}</div>
              <button
                type="button"
                className="btn"
                style={{ marginBottom: "0.75rem" }}
                onClick={() => window.open(`${EXPLORER_TX_BASE}/${latestTx}`, "_blank", "noopener,noreferrer")}
              >
                View on Basescan
              </button>
            </>
          ) : (
            <p style={{ color: "#7a8fa3", marginTop: 0 }}>No settlement yet.</p>
          )}

          {settlementTxs.length > 1 && (
            <details style={{ marginBottom: "0.75rem" }}>
              <summary style={{ fontSize: "0.8rem", cursor: "pointer" }}>
                All txs ({settlementTxs.length})
              </summary>
              <ul style={{ fontSize: "0.72rem", paddingLeft: "1.25rem", margin: "0.25rem 0 0" }}>
                {settlementTxs.map(tx => (
                  <li key={tx} style={{ wordBreak: "break-all" }}>
                    <a href={`${EXPLORER_TX_BASE}/${tx}`} target="_blank" rel="noreferrer">{tx}</a>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <hr style={{ border: "none", borderTop: "1px solid #2d3a4d", margin: "0.75rem 0" }} />

          <div className="label">Receiver settle</div>
          {serverPayTo && (
            <div
              className="mono"
              style={{ fontSize: "0.7rem", padding: "0.4rem 0.6rem", marginBottom: "0.5rem" }}
            >
              PAY_TO: {serverPayTo}
            </div>
          )}

          <input
            placeholder="Payer 0x…"
            value={settlePayer}
            onChange={e => setSettlePayer(e.target.value)}
            style={{ width: "100%", marginBottom: "0.5rem", fontSize: "0.8rem" }}
          />
          <div className="row">
            <button type="button" className="btn secondary" disabled={settleBusy} onClick={() => void fetchPendingAccruals()}>
              {settleBusy ? "…" : "Refresh pending"}
            </button>
            <button type="button" className="btn" disabled={settleBusy} onClick={() => void settleAccruedBatch()}>
              Settle batch
            </button>
          </div>

          {pendingAccruals.length > 0 && (
            <pre className="mono" style={{ fontSize: "0.7rem", marginTop: "0.5rem", maxHeight: "100px", overflow: "auto" }}>
              {JSON.stringify(pendingAccruals, null, 2)}
            </pre>
          )}
          {settleMessage && (
            <p
              className={settleMessage.startsWith("Settled") || settleMessage.startsWith("Found") || settleMessage.startsWith("Scanning") ? "status-ok" : "status-err"}
              style={{ fontSize: "0.82rem", marginTop: "0.5rem", whiteSpace: "pre-wrap" }}
            >
              {settleMessage}
            </p>
          )}

          <hr style={{ border: "none", borderTop: "1px solid #2d3a4d", margin: "0.75rem 0" }} />
          <button type="button" className="btn ghost" onClick={resetSession}>
            Reset session
          </button>
        </div>
      </div>
    </div>
  );
}
