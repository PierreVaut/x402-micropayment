import { BUDGET_CAP_ATOMIC } from "@x402-poc/shared";

const LS_KEY = "x402-poc-agent-state-v1";
const DB_NAME = "x402-poc-agent";
const DB_VERSION = 1;
const STORE = "budget";

export type PersistedBudget = {
  capAtomic: string;
  spentAtomic: string;
  ledgerAddress: `0x${string}`;
  /** When x402 Upto session was authorized (Ledger) */
  authorizedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
  });
}

function coerceBudget(raw: unknown): PersistedBudget | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.capAtomic !== "string" || typeof p.spentAtomic !== "string") return null;
  if (typeof p.ledgerAddress !== "string" || !p.ledgerAddress.startsWith("0x")) return null;
  const authorizedAt =
    typeof p.authorizedAt === "number"
      ? p.authorizedAt
      : typeof p.signedAt === "number"
        ? p.signedAt
        : 0;
  return {
    capAtomic: p.capAtomic,
    spentAtomic: p.spentAtomic,
    ledgerAddress: p.ledgerAddress as `0x${string}`,
    authorizedAt,
  };
}

async function idbRead(): Promise<PersistedBudget | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const r = store.get("current");
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const row = r.result as { id: string; payload: unknown } | undefined;
      resolve(row?.payload ? coerceBudget(row.payload) : null);
    };
  });
}

async function idbWrite(b: PersistedBudget): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const r = store.put({ id: "current", payload: b });
    r.onerror = () => reject(r.error);
    r.onsuccess = () => resolve();
  });
}

async function idbClear(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const r = store.delete("current");
    r.onerror = () => reject(r.error);
    r.onsuccess = () => resolve();
  });
}

function loadFromLocalStorage(): PersistedBudget | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return coerceBudget(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Load from IndexedDB, then migrate from localStorage if needed. */
export async function loadBudget(): Promise<PersistedBudget | null> {
  try {
    const fromIdb = await idbRead();
    if (fromIdb) return fromIdb;
  } catch {
    /* IDB unavailable (private mode, etc.) */
  }
  const fromLs = loadFromLocalStorage();
  if (fromLs) {
    try {
      await idbWrite(fromLs);
    } catch {
      /* keep LS only */
    }
    return fromLs;
  }
  return null;
}

/** Persist to IndexedDB and mirror in localStorage for simple tooling / fallback. */
export async function saveBudget(b: PersistedBudget): Promise<void> {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(b));
  } catch {
    /* quota */
  }
  try {
    await idbWrite(b);
  } catch {
    /* IDB failed; LS may still hold data */
  }
}

export async function clearBudget(): Promise<void> {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
  try {
    await idbClear();
  } catch {
    /* ignore */
  }
}

export function defaultCapAtomic(): bigint {
  return BUDGET_CAP_ATOMIC;
}
