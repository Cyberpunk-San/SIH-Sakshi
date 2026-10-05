import "server-only";
import { getGenesis } from "./config";
import { txId, verifyInclusion, type Inclusion, type Tx } from "@/lib/core/ledger";

export class LedgerError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

function nodes() {
  return getGenesis().body.validators;
}

async function call<T>(url: string, init?: RequestInit, timeoutMs = 5000): Promise<T> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new LedgerError(j.error ?? `${r.status} ${r.statusText}`, r.status);
  return j as T;
}

/** Read from the first validator that answers (start point rotates for load spreading). */
export async function query<T>(pathAndQuery: string, timeoutMs = 5000): Promise<T> {
  const list = nodes();
  const start = Math.floor(Math.random() * list.length);
  let last: unknown;
  for (let i = 0; i < list.length; i++) {
    const n = list[(start + i) % list.length];
    try {
      return await call<T>(n.url + pathAndQuery, undefined, timeoutMs);
    } catch (e) {
      // A definite answer (4xx) from a validator is final; only retry on outages.
      if (e instanceof LedgerError && e.status < 500) throw e;
      last = e;
    }
  }
  throw new LedgerError(`no validator reachable: ${(last as Error)?.message ?? "unknown"}`, 503);
}

export async function nodeStatuses() {
  return Promise.all(
    nodes().map(async (n) => {
      try {
        const s = await call<Record<string, unknown>>(n.url + "/status", undefined, 1500);
        return { ...s, url: n.url, online: true };
      } catch (e) {
        return { id: n.id, name: n.name, url: n.url, online: false, error: (e as Error).message };
      }
    }),
  );
}

export async function submit(tx: Tx): Promise<string> {
  const list = nodes();
  let last: unknown;
  for (const n of list) {
    try {
      const r = await call<{ txId: string }>(n.url + "/tx", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx }) });
      return r.txId;
    } catch (e) {
      if (e instanceof LedgerError && e.status === 400) throw e; // rejected by validation: do not retry elsewhere
      last = e;
    }
  }
  throw new LedgerError(`could not submit to any validator: ${(last as Error)?.message}`, 503);
}

export type Proven = { tx: Tx; inclusion: Inclusion };

/** Fetch a committed tx with its inclusion proof and verify the proof locally (do not trust the node). */
export async function proof(id: string): Promise<Proven | null> {
  const r = await query<{ status: string; tx?: Tx; inclusion?: Inclusion }>(`/tx?id=${id}`);
  if (r.status !== "committed" || !r.tx || !r.inclusion) return null;
  if (txId(r.tx) !== id) throw new LedgerError("validator returned a different transaction");
  const err = verifyInclusion(getGenesis(), r.tx, r.inclusion);
  if (err) throw new LedgerError(`validator returned an invalid proof: ${err}`);
  return { tx: r.tx, inclusion: r.inclusion };
}

/** Submit and block until the transaction is committed by a validator quorum. Fails closed. */
export async function submitAndWait(tx: Tx, timeoutMs = 20000): Promise<Proven> {
  const id = await submit(tx);
  const deadline = Date.now() + timeoutMs;
  let delay = 150;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 1000);
    try {
      const p = await proof(id);
      if (p) return p;
    } catch (e) {
      if (e instanceof LedgerError && e.status === 503) continue;
      throw e;
    }
  }
  throw new LedgerError("transaction was not committed in time (is a validator quorum online?)", 504);
}
