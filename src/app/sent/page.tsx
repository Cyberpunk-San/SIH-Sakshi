"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Gate } from "@/components/gate";
import { useIdentity } from "@/components/identity";
import { Badge, Card, CardHeader, Empty, Hash, Notice, PageHeader, cx, formatBytes, formatTime } from "@/components/ui";

type DocRow = { docId: string; title: string; size: number; kind: string; pdfMode: string; recipients: string[]; createdAt: number; height: number; txId: string };
type Session = {
  decryptTxId: string;
  recipientId: string;
  sessionId: string;
  wmId: string;
  at: number;
  height: number;
  delivered: { sha256: string; bytes: number; height: number } | null;
  acknowledged: { height: number } | null;
};

export default function SentPage() {
  return (
    <Gate role="sender">
      {() => (
        <Suspense>
          <AccessLog />
        </Suspense>
      )}
    </Gate>
  );
}

function AccessLog() {
  const { api } = useIdentity();
  const params = useSearchParams();
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [active, setActive] = useState<string | null>(params.get("doc"));
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ sent: DocRow[] }>("/api/docs").then((r) => {
      const list = r.sent.sort((a, b) => b.createdAt - a.createdAt);
      setDocs(list);
      setActive((a) => a ?? list[0]?.docId ?? null);
    }).catch((e) => setError(e.message));
  }, [api]);

  const loadSessions = useCallback(() => {
    if (!active) return;
    api.get<{ sessions: Session[] }>(`/api/docs/sessions?docId=${active}`).then((r) => setSessions(r.sessions)).catch((e) => setError(e.message));
  }, [api, active]);
  useEffect(loadSessions, [loadSessions]);

  const doc = docs?.find((d) => d.docId === active);

  return (
    <div>
      <PageHeader eyebrow="Sender" title="Access log">
        Every decryption of your documents, as recorded on the ledger: who, when, which watermark, and whether they signed for the exact file. No administrator can edit this list.
      </PageHeader>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <Card>
          <CardHeader title="Your documents" />
          {docs === null ? (
            <div className="px-5 py-6 text-sm text-ink-3">Loading…</div>
          ) : docs.length === 0 ? (
            <Empty title="No documents sent" />
          ) : (
            <ul className="ledger-rule">
              {docs.map((d) => (
                <li key={d.docId}>
                  <button
                    onClick={() => {
                      setSessions(null);
                      setActive(d.docId);
                    }}
                    className={cx("block w-full px-5 py-3 text-left", active === d.docId ? "bg-paper-2" : "hover:bg-paper-2/60")}
                  >
                    <div className="truncate text-sm font-medium">{d.title}</div>
                    <div className="text-xs text-ink-3">{formatTime(d.createdAt)} · {d.recipients.length} recipients</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {doc && (
          <Card>
            <CardHeader title={doc.title} meta={`block #${doc.height}`} />
            <div className="grid gap-4 border-b border-rule px-5 py-4 text-sm sm:grid-cols-3">
              <div><div className="text-xs text-ink-3">Distribution record</div><Hash value={doc.txId} /></div>
              <div><div className="text-xs text-ink-3">Size · type</div>{formatBytes(doc.size)} · {doc.kind}{doc.kind === "pdf" && ` (${doc.pdfMode})`}</div>
              <div><div className="text-xs text-ink-3">Recipients</div><span className="font-mono text-xs">{doc.recipients.join(", ")}</span></div>
            </div>
            {sessions === null ? (
              <div className="px-5 py-6 text-sm text-ink-3">Reading the ledger…</div>
            ) : sessions.length === 0 ? (
              <Empty title="Not opened yet">Nobody has decrypted this document.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-ink-3">
                      <th className="px-5 py-2 font-medium">Recipient</th>
                      <th className="px-3 py-2 font-medium">Decrypted</th>
                      <th className="px-3 py-2 font-medium">Watermark</th>
                      <th className="px-3 py-2 font-medium">Record</th>
                      <th className="px-5 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.decryptTxId} className="border-t border-rule">
                        <td className="px-5 py-3 font-mono text-xs">{s.recipientId}</td>
                        <td className="px-3 py-3">{formatTime(s.at)}<div className="text-xs text-ink-3">block #{s.height}</div></td>
                        <td className="px-3 py-3 font-mono text-xs">{s.wmId}</td>
                        <td className="px-3 py-3"><Hash value={s.decryptTxId} chars={8} /></td>
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap gap-1">
                            {s.delivered ? <Badge tone="good">delivered</Badge> : <Badge tone="warn">not delivered</Badge>}
                            {s.acknowledged && <Badge tone="good">receipt signed</Badge>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
