"use client";

import { useCallback, useEffect, useState } from "react";
import { useIdentity } from "@/components/identity";
import { Badge, Button, Card, CardHeader, Dot, Hash, Notice, PageHeader, cx, formatTime } from "@/components/ui";
import { verifyBlockShape, verifyGenesis, type Block } from "@/lib/core/ledger";
import { LedgerState } from "@/lib/core/state";

type NodeStatus = {
  id: string;
  name: string;
  url: string;
  online: boolean;
  height?: number;
  headHash?: string;
  headTime?: number;
  round?: number;
  leader?: string;
  mempool?: number;
  integrity?: { ok: boolean; lastCheck: number; checkedBlocks: number };
  incidents?: { at: number; kind: string; detail: string; quarantined?: string }[];
  error?: string;
};
type Status = {
  chainId: string;
  quorum: number;
  nodes: NodeStatus[];
  summary: Record<string, number> | null;
  vault: { blobs: number; blobBytes: number };
  watermarkEngine: boolean;
};
type RecentBlock = {
  header: { height: number; time: number; prevHash: string; txRoot: string; txCount: number };
  hash: string;
  proposer: string;
  round: number;
  votes: string[];
  txs: { id: string; type: string; signer: string }[];
};

const TX_TONE: Record<string, "good" | "bad" | "warn" | "neutral" | "info"> = {
  DECRYPT: "warn",
  DELIVERY: "neutral",
  ACK: "neutral",
  DOC_PUBLISH: "good",
  CERT_ISSUE: "info",
  CERT_REVOKE: "bad",
  FORENSIC_QUERY: "bad",
};

export default function LedgerPage() {
  const { api, config } = useIdentity();
  const [status, setStatus] = useState<Status | null>(null);
  const [blocks, setBlocks] = useState<RecentBlock[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<Record<string, { running: boolean; result?: string; ok?: boolean }>>({});

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([api.get<Status>("/api/ledger/status"), api.get<{ blocks: RecentBlock[] }>("/api/ledger/blocks?limit=30")]);
      setStatus(s);
      setBlocks(b.blocks);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  /** Download the entire chain from one validator and verify every block + state transition locally. */
  const verifyNode = async (id: string) => {
    if (!config) return;
    setAudit((a) => ({ ...a, [id]: { running: true } }));
    const t0 = performance.now();
    try {
      const g = verifyGenesis(config.genesis);
      if (!g.ok) throw new Error(`genesis: ${g.reason}`);
      const state = new LedgerState(config.genesis);
      let prev = config.genesis.chainId;
      let height = 0;
      let txs = 0;
      for (;;) {
        const { blocks: page } = await api.get<{ blocks: Block[] }>(`/api/ledger/chain?node=${id}&from=${height + 1}`);
        for (const b of page) {
          const err = verifyBlockShape(config.genesis, b, prev, height + 1);
          if (err) throw new Error(`block #${height + 1}: ${err}`);
          const terr = state.applyBlock(b.txs, b.header.height, b.header.time);
          if (terr) throw new Error(`block #${height + 1}: ${terr}`);
          prev = b.hash;
          height++;
          txs += b.txs.length;
        }
        if (page.length < 500) break;
      }
      setAudit((a) => ({
        ...a,
        [id]: { running: false, ok: true, result: `${height} blocks, ${txs} transactions, every quorum certificate and state transition verified in ${Math.round(performance.now() - t0)} ms` },
      }));
    } catch (e) {
      setAudit((a) => ({ ...a, [id]: { running: false, ok: false, result: (e as Error).message } }));
    }
  };

  const online = status?.nodes.filter((n) => n.online) ?? [];
  const maxH = Math.max(0, ...online.map((n) => n.height ?? 0));
  const heads = new Set(online.filter((n) => n.height === maxH).map((n) => n.headHash));
  const healthy = online.length >= (status?.quorum ?? 3);
  const incidents = (status?.nodes ?? []).flatMap((n) => (n.incidents ?? []).map((i) => ({ ...i, node: n.id }))).sort((a, b) => b.at - a.at);

  return (
    <div>
      <PageHeader eyebrow="Permissioned BFT ledger" title="Ledger & validators">
        Every certificate, distribution, decryption, delivery and investigation is a transaction signed with ML-DSA-65. A block becomes final only when at least {status?.quorum ?? 3} of {status?.nodes.length ?? 4} independent validators sign it. Changing history would require forging their post-quantum signatures.
      </PageHeader>
      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Consensus" value={healthy ? "Live" : "Halted"} tone={healthy ? "good" : "bad"} sub={`${online.length}/${status?.nodes.length ?? "–"} validators online · quorum ${status?.quorum ?? "–"}`} />
        <Stat label="Height" value={`#${maxH}`} sub={heads.size <= 1 ? "all online validators agree on the head" : "validators disagree (syncing)"} tone={heads.size <= 1 ? "good" : "warn"} />
        <Stat label="Records" value={String(status?.summary?.decrypts ?? "–")} sub={`decryptions · ${status?.summary?.docs ?? "–"} documents · ${status?.summary?.certs ?? "–"} identities`} />
        <Stat label="Vault" value={String(status?.vault.blobs ?? "–")} sub={`indistinguishable blobs · watermark engine ${status?.watermarkEngine ? "online" : "offline"}`} tone={status?.watermarkEngine === false ? "bad" : undefined} />
      </div>

      <Card className="mb-6">
        <CardHeader title="Validators" meta={status ? `chain ${status.chainId.slice(0, 16)}…` : ""} />
        <div className="grid divide-y divide-rule md:grid-cols-2 md:divide-y-0 lg:grid-cols-4">
          {(status?.nodes ?? []).map((n, i) => {
            const a = audit[n.id];
            return (
              <div key={n.id} className={cx("p-5", i > 0 && "md:border-l md:border-rule")}>
                <div className="flex items-center gap-2">
                  <Dot tone={!n.online ? "bad" : n.integrity?.ok === false ? "warn" : "good"} />
                  <span className="font-mono text-sm">{n.id}</span>
                  {n.online && n.leader === n.id && <Badge>leader</Badge>}
                </div>
                <div className="mt-1 text-xs text-ink-3">{n.name}</div>
                {n.online ? (
                  <dl className="mt-3 space-y-1 text-xs">
                    <div className="flex justify-between"><dt className="text-ink-3">height</dt><dd className="tabular">#{n.height}</dd></div>
                    <div className="flex justify-between"><dt className="text-ink-3">head</dt><dd><Hash value={n.headHash ?? ""} chars={6} /></dd></div>
                    <div className="flex justify-between"><dt className="text-ink-3">disk integrity</dt><dd className={n.integrity?.ok ? "text-verdigris" : "text-seal"}>{n.integrity?.ok ? "intact" : "tamper detected"}</dd></div>
                    <div className="flex justify-between"><dt className="text-ink-3">mempool</dt><dd className="tabular">{n.mempool}</dd></div>
                  </dl>
                ) : (
                  <div className="mt-3 text-xs text-seal">offline</div>
                )}
                <Button variant="outline" className="mt-4 w-full text-xs" disabled={!n.online || a?.running} onClick={() => verifyNode(n.id)}>
                  {a?.running ? "Verifying…" : "Verify full chain here"}
                </Button>
                {a?.result && <div className={cx("mt-2 text-xs", a.ok ? "text-verdigris" : "text-seal")}>{a.result}</div>}
              </div>
            );
          })}
        </div>
      </Card>

      {incidents.length > 0 && (
        <Card className="mb-6 border-seal/40">
          <CardHeader title="Integrity incidents" meta="detected and repaired by the validators themselves" />
          <ul className="ledger-rule text-sm">
            {incidents.slice(0, 12).map((i, k) => (
              <li key={k} className="flex flex-wrap gap-x-4 gap-y-1 px-5 py-3">
                <span className="font-mono text-xs text-ink-3">{formatTime(i.at)}</span>
                <span className="font-mono text-xs">{i.node}</span>
                <Badge tone={i.kind === "CHAIN_RESTORED" ? "good" : "bad"}>{i.kind.replace("_", " ").toLowerCase()}</Badge>
                <span className="text-ink-2">{i.detail}</span>
                {i.quarantined && <span className="text-xs text-ink-3">evidence kept as {i.quarantined}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title="Recent blocks" meta="auto-refreshing" />
        {blocks.length === 0 ? (
          <div className="px-5 py-8 text-sm text-ink-3">No blocks yet. The chain grows as identities are certified and documents are distributed.</div>
        ) : (
          <ul className="ledger-rule">
            {blocks.map((b) => (
              <li key={b.hash} className="grid gap-2 px-5 py-3 md:grid-cols-[110px_1fr_auto]">
                <div>
                  <div className="font-mono text-sm">#{b.header.height}</div>
                  <div className="text-xs text-ink-3">{formatTime(b.header.time)}</div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {b.txs.map((t) => (
                    <span key={t.id} className="inline-flex items-center gap-1.5" title={t.id}>
                      <Badge tone={TX_TONE[t.type]}>{t.type.replace("_", " ").toLowerCase()}</Badge>
                      <span className="font-mono text-xs text-ink-3">{t.signer}</span>
                    </span>
                  ))}
                </div>
                <div className="text-xs text-ink-3 md:text-right">
                  <Hash value={b.hash} chars={8} />
                  <div>proposer {b.proposer} · signed by {b.votes.join(", ")}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-[0.1em] text-ink-3">{label}</div>
      <div className={cx("mt-1 font-serif text-2xl tabular", tone === "bad" && "text-seal", tone === "warn" && "text-ochre")}>{value}</div>
      <div className="mt-0.5 text-xs text-ink-3">{sub}</div>
    </Card>
  );
}
