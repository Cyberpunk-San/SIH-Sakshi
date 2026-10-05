"use client";

import { useCallback, useEffect, useState } from "react";
import { Gate } from "@/components/gate";
import { useIdentity } from "@/components/identity";
import { Badge, Button, Card, CardHeader, Empty, Hash, Notice, PageHeader, formatBytes, formatTime } from "@/components/ui";
import { decryptDocument, type DecryptMeta } from "@/lib/client/flows";
import { downloadBytes } from "@/lib/client/keystore";

type DocRow = {
  docId: string;
  title: string;
  fileName: string;
  mime: string;
  size: number;
  kind: "pdf" | "image";
  sender: string;
  createdAt: number;
  height: number;
  recipients: string[];
  mySessions: number;
};

type Opened = { doc: DocRow; url: string; bytes: Uint8Array; mime: string; meta: DecryptMeta; ackTxId: string };

const STEP_LABEL: Record<string, string> = {
  "record-committed": "Your signed decryption record was committed",
  "shares-released": "Validators released their key shares",
  decrypted: "Chunks reassembled and decrypted in memory",
  watermarked: "Unique invisible watermark embedded",
  "delivery-recorded": "Delivery recorded on the ledger",
};

export default function InboxPage() {
  return <Gate role="recipient">{(s) => <Inbox principal={s.principal} />}</Gate>;
}

function Inbox({ principal }: { principal: string }) {
  const { api, config, ensureIdentity } = useIdentity();
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<{ docId: string; steps: string[] } | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);

  const load = useCallback(() => {
    api.get<{ inbox: DocRow[] }>("/api/docs").then((r) => setDocs(r.inbox.sort((a, b) => b.createdAt - a.createdAt))).catch((e) => setError(e.message));
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => () => { if (opened) URL.revokeObjectURL(opened.url); }, [opened]);

  const open = async (doc: DocRow) => {
    if (!config) return;
    setError(null);
    setOpened(null);
    try {
      const ident = await ensureIdentity();
      setWorking({ docId: doc.docId, steps: [] });
      const r = await decryptDocument(api, config, ident, principal, doc.docId, navigator.userAgent, (s) =>
        setWorking((w) => (w ? { ...w, steps: [...w.steps, s] } : w)),
      );
      const url = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: r.mime }));
      setOpened({ doc, url, ...r });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  return (
    <div>
      <PageHeader eyebrow="Inbox" title="Documents addressed to you">
        Opening a document signs a decryption record with your private key and commits it to the ledger before any plaintext exists. The copy you receive carries an invisible watermark unique to this session.
      </PageHeader>
      {error && <div className="mb-4"><Notice tone="bad" title="Could not open the document">{error}</Notice></div>}

      {opened && <OpenedDoc o={opened} onClose={() => setOpened(null)} />}

      <Card>
        <CardHeader title="Received" meta={docs ? `${docs.length} document${docs.length === 1 ? "" : "s"}` : ""} />
        {docs === null ? (
          <div className="px-5 py-8 text-sm text-ink-3">Loading from the ledger…</div>
        ) : docs.length === 0 ? (
          <Empty title="Nothing here yet">Documents distributed to you will appear here.</Empty>
        ) : (
          <ul className="ledger-rule">
            {docs.map((d) => (
              <li key={d.docId} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge>{d.kind}</Badge>
                    <span className="truncate font-medium">{d.title}</span>
                  </div>
                  <div className="mt-1 text-xs text-ink-3">
                    from <span className="font-mono">{d.sender}</span> · {formatTime(d.createdAt)} · {formatBytes(d.size)} · {d.recipients.length} recipient{d.recipients.length === 1 ? "" : "s"} · block #{d.height}
                    {d.mySessions > 0 && <> · opened {d.mySessions}×</>}
                  </div>
                  {working?.docId === d.docId && (
                    <ol className="mt-2 space-y-0.5 text-xs text-ink-2">
                      {working.steps.map((s, i) => (
                        <li key={i}>
                          <span className={i === working.steps.length - 1 ? "pulse-dot" : "text-verdigris"}>{i === working.steps.length - 1 ? "●" : "✓"}</span> {s}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <Button variant="outline" disabled={!!working} onClick={() => open(d)}>
                  {working?.docId === d.docId ? "Opening…" : "Decrypt & open"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function OpenedDoc({ o, onClose }: { o: Opened; onClose: () => void }) {
  return (
    <Card className="mb-8 overflow-hidden">
      <CardHeader title={o.doc.title}>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => downloadBytes(o.bytes, o.meta.fileName, o.mime)}>Download</Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </CardHeader>
      <div className="grid lg:grid-cols-[1fr_320px]">
        <div className="min-h-[420px] bg-paper-2">
          {o.mime === "application/pdf" ? (
            <iframe title={o.doc.title} src={o.url} className="h-[70vh] w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.url} alt={o.doc.title} className="mx-auto max-h-[70vh] w-auto" />
          )}
        </div>
        <aside className="border-t border-rule p-5 text-sm lg:border-l lg:border-t-0">
          <div className="text-xs font-medium uppercase tracking-[0.1em] text-ink-3">Witness record</div>
          <p className="mt-2 text-ink-2">This copy looks identical to everyone else&apos;s but is forensically yours. If it leaks, it can be traced to this session.</p>
          <dl className="mt-4 space-y-2.5">
            <Row k="Watermark">{<span className="font-mono text-[12px]">{o.meta.wmId}</span>}</Row>
            <Row k="Decryption record"><Hash value={o.meta.decryptTxId} /></Row>
            <Row k="Block">#{o.meta.blockHeight}</Row>
            <Row k="Validators">{o.meta.validators.join(", ")}</Row>
            <Row k="Delivery record"><Hash value={o.meta.deliveryTxId} /></Row>
            <Row k="Your receipt"><Hash value={o.ackTxId} /></Row>
            <Row k="File SHA-256"><Hash value={o.meta.sha256} /></Row>
          </dl>
          <div className="mt-5 border-t border-rule pt-3">
            <div className="text-xs font-medium uppercase tracking-[0.1em] text-ink-3">Gateway timeline</div>
            <ol className="mt-2 space-y-1 text-xs text-ink-2">
              {o.meta.steps.map((s) => (
                <li key={s.step} className="flex justify-between gap-3">
                  <span>{STEP_LABEL[s.step] ?? s.step}</span>
                  <span className="tabular text-ink-3">{s.ms} ms</span>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </Card>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-3">{k}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
