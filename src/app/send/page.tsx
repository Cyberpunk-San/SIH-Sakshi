"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Gate } from "@/components/gate";
import { useIdentity } from "@/components/identity";
import { Badge, Button, Card, CardHeader, Field, Notice, PageHeader, cx, formatBytes, inputClass } from "@/components/ui";
import { sendDocument, sniffKind, type Person } from "@/lib/client/flows";

export default function SendPage() {
  return <Gate role="sender">{(s) => <Compose principal={s.principal} />}</Gate>;
}

function Compose({ principal }: { principal: string }) {
  const { api, config, ensureIdentity } = useIdentity();
  const [people, setPeople] = useState<(Person & { status: string })[]>([]);
  const [file, setFile] = useState<{ bytes: Uint8Array; name: string; mime: string } | null>(null);
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [pdfMode, setPdfMode] = useState<"preserve" | "flatten">("preserve");
  const [steps, setSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ docId: string; height: number; chunks: number; decoys: number; txId: string } | null>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    api.get<{ people: (Person & { status: string })[] }>("/api/directory").then((d) => setPeople(d.people)).catch((e) => setError(e.message));
  }, [api]);

  const recipients = useMemo(
    () => people.filter((p) => p.status === "active" && p.roles.includes("recipient")),
    [people],
  );
  const shown = recipients.filter((p) => `${p.name} ${p.userId} ${p.org}`.toLowerCase().includes(filter.toLowerCase()));
  const kind = file ? sniffKind(file.bytes) : null;

  const pick = async (f: File) => {
    setError(null);
    setResult(null);
    if (f.size > 50 * 1024 * 1024) return setError("Documents are limited to 50 MB.");
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!sniffKind(bytes)) return setError("Only PDF and image files (PNG, JPEG, WEBP, BMP, TIFF) can be watermarked.");
    setFile({ bytes, name: f.name, mime: f.type });
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  };

  const send = async () => {
    if (!file || !config) return;
    setBusy(true);
    setError(null);
    setSteps([]);
    try {
      const ident = await ensureIdentity();
      const r = await sendDocument(
        api,
        config,
        ident,
        principal,
        file,
        title.trim() || file.name,
        recipients.filter((p) => selected.includes(p.userId)),
        pdfMode,
        (s) => setSteps((x) => [...x, s]),
      );
      setResult(r);
      setFile(null);
      setSelected([]);
      setTitle("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader eyebrow="Broadcast encryption" title="Distribute a document">
        The file is encrypted once in your browser. Each recipient gets the key half wrapped to their own ML-KEM-768 key. The other half is split among the validators, who release it only after a recipient&apos;s signed decryption record is on the ledger.
      </PageHeader>

      {result && (
        <div className="mb-6">
          <Notice tone="good" title="Distributed">
            Committed in block #{result.height}. Stored as {result.chunks} encrypted chunk{result.chunks === 1 ? "" : "s"} mixed with {result.decoys} decoys under unlinkable names.{" "}
            <Link className="underline underline-offset-4" href={`/sent?doc=${result.docId}`}>Open access log</Link>
          </Notice>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <Card>
          <CardHeader title="1 · Document" />
          <div className="p-5">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void pick(f);
              }}
              className={cx(
                "flex cursor-pointer flex-col items-center justify-center rounded-[4px] border border-dashed px-4 py-10 text-center",
                drag ? "border-verdigris bg-verdigris-soft" : "border-rule-2 bg-paper-2/50 hover:bg-paper-2",
              )}
            >
              {file ? (
                <>
                  <span className="font-medium">{file.name}</span>
                  <span className="mt-1 text-sm text-ink-3">{formatBytes(file.bytes.length)} · {kind === "pdf" ? "PDF" : "image"} · click to replace</span>
                </>
              ) : (
                <>
                  <span className="font-serif text-lg">Drop a PDF or image</span>
                  <span className="mt-1 text-sm text-ink-3">or click to choose · up to 50 MB · never leaves this tab unencrypted</span>
                </>
              )}
              <input type="file" className="sr-only" accept="application/pdf,image/png,image/jpeg,image/webp,image/bmp,image/tiff" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
            </label>
            <Field label="Title (recorded on the ledger)" className="mt-4">
              <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </Field>
            {kind === "pdf" && (
              <fieldset className="mt-4">
                <legend className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-ink-2">PDF watermark policy</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    { id: "preserve" as const, t: "Preserve", d: "Keeps selectable text and small size. Watermark is an invisible page layer." },
                    { id: "flatten" as const, t: "Flatten", d: "Pages become images with the mark baked into the pixels. Harder to strip, larger files." },
                  ].map((o) => (
                    <label key={o.id} className={cx("cursor-pointer rounded-[4px] border px-3 py-2", pdfMode === o.id ? "border-verdigris bg-verdigris-soft" : "border-rule-2")}>
                      <input type="radio" className="sr-only" checked={pdfMode === o.id} onChange={() => setPdfMode(o.id)} />
                      <span className="block text-sm font-medium">{o.t}</span>
                      <span className="block text-xs text-ink-3">{o.d}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="2 · Recipients" meta={`${selected.length} selected`} />
          <div className="p-5">
            <input className={inputClass} placeholder="Filter by name, ID or organisation" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="mt-3 max-h-72 divide-y divide-rule overflow-auto rounded-[4px] border border-rule-2">
              {shown.length === 0 && <div className="px-3 py-4 text-sm text-ink-3">No certified recipients{filter ? " match" : " yet"}.</div>}
              {shown.map((p) => (
                <label key={p.userId} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-paper-2">
                  <input
                    type="checkbox"
                    className="accent-[var(--verdigris)]"
                    checked={selected.includes(p.userId)}
                    onChange={(e) => setSelected(e.target.checked ? [...selected, p.userId] : selected.filter((x) => x !== p.userId))}
                  />
                  <span className="flex-1">
                    <span className="block text-sm">{p.name}{p.userId === principal && <span className="text-ink-3"> (you)</span>}</span>
                    <span className="block font-mono text-xs text-ink-3">{p.userId} · {p.org}</span>
                  </span>
                </label>
              ))}
            </div>
            {recipients.length > 0 && (
              <div className="mt-2 flex gap-3 text-xs">
                <button className="text-ink-2 underline underline-offset-2" onClick={() => setSelected(shown.map((p) => p.userId))}>Select shown</button>
                <button className="text-ink-2 underline underline-offset-2" onClick={() => setSelected([])}>Clear</button>
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card className="mt-6 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm text-ink-2">
            {file && selected.length ? (
              <>
                <span className="font-medium text-ink">{title || file.name}</span> to {selected.length} recipient{selected.length === 1 ? "" : "s"}. Each decryption will be signed by the recipient, witnessed by ≥{config?.quorum ?? 3} validators and individually watermarked.
              </>
            ) : (
              "Choose a document and at least one recipient."
            )}
          </div>
          <Button disabled={!file || !selected.length || busy || !config} onClick={send}>
            {busy ? "Encrypting…" : "Encrypt & distribute"}
          </Button>
        </div>
        {steps.length > 0 && (
          <ol className="mt-4 space-y-1 border-t border-rule pt-3 text-sm">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2">
                <Badge tone={i === steps.length - 1 && busy ? "warn" : "good"}>{i === steps.length - 1 && busy ? "…" : "done"}</Badge>
                <span className="text-ink-2">{s}</span>
              </li>
            ))}
          </ol>
        )}
        {error && <div className="mt-4"><Notice tone="bad">{error}</Notice></div>}
      </Card>
    </div>
  );
}
