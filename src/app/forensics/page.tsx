"use client";

import { useState } from "react";
import { Gate } from "@/components/gate";
import { useIdentity } from "@/components/identity";
import { Badge, Button, Card, CardHeader, Hash, Notice, PageHeader, cx, formatBytes, formatTime } from "@/components/ui";
import { investigate, type ForensicResult } from "@/lib/client/flows";
import { downloadBytes } from "@/lib/client/keystore";
import type { Verdict } from "@/lib/core/evidence";

type Outcome = ForensicResult & { localVerdict?: Verdict; fileName: string; size: number };

export default function ForensicsPage() {
  return <Gate role="investigator">{(s) => <Investigate principal={s.principal} />}</Gate>;
}

function Investigate({ principal }: { principal: string }) {
  const { api, ensureIdentity } = useIdentity();
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<Outcome | null>(null);

  const run = async (f: File) => {
    setError(null);
    setOut(null);
    try {
      const ident = await ensureIdentity();
      setBusy(true);
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await investigate(api, ident, principal, { bytes, name: f.name });
      setOut({ ...r, fileName: f.name, size: f.size });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader eyebrow="Forensics" title="Trace a leaked copy">
        Upload a leaked file: a forwarded PDF, a screenshot, a photo of a page or a recompressed image. Sakshi recovers the hidden watermark, finds the matching decryption on the ledger, and checks every signature and proof again in your browser. Your query is itself recorded on the ledger.
      </PageHeader>

      <label
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !busy) void run(f);
        }}
        className={cx(
          "mb-8 flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-12 text-center print:hidden",
          drag ? "border-verdigris bg-verdigris-soft" : "border-rule-2 bg-card hover:bg-paper-2",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <span className="font-serif text-xl">{busy ? "Analysing…" : "Drop the leaked file here"}</span>
        <span className="mt-1 text-sm text-ink-3">{busy ? "Searching for the watermark across offsets and zoom levels, then verifying ledger evidence" : "PDF, PNG, JPEG, WEBP, BMP or TIFF · up to 60 MB"}</span>
        <input type="file" className="sr-only" disabled={busy} onChange={(e) => e.target.files?.[0] && run(e.target.files[0])} />
      </label>

      {error && <Notice tone="bad" title="Analysis failed">{error}</Notice>}
      {out && <Report out={out} />}
    </div>
  );
}

function Report({ out }: { out: Outcome }) {
  const v = out.localVerdict;
  const ex = out.extraction;
  if (!ex.found || !out.bundle || !v) {
    return (
      <Card className="p-6">
        <div className="flex items-center gap-3">
          <Badge tone="warn">No attribution</Badge>
          <span className="font-serif text-xl">No Sakshi watermark could be tied to this file</span>
        </div>
        <p className="mt-2 text-sm text-ink-2">{out.message ?? ex.reason}</p>
        <p className="mt-2 text-xs text-ink-3">
          File {out.fileName} ({formatBytes(out.size)}) · pilot strength {ex.pilot_z ?? 0} · query <Hash value={out.queryTxId} />
        </p>
        <p className="mt-3 text-xs text-ink-3">
          Possible reasons: the file was never decrypted through Sakshi, it was heavily rotated or redrawn, or text was retyped by hand. A missing match is never treated as evidence against anyone.
        </p>
      </Card>
    );
  }
  const s = v.subject!;
  const attributed = v.verdict === "ATTRIBUTED";
  return (
    <div className="space-y-6">
      <Card className={cx("overflow-hidden", attributed ? "border-seal/50" : "border-ochre/50")}>
        <div className={cx("px-6 py-5", attributed ? "bg-seal-soft" : "bg-ochre-soft")}>
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-ink-2">{attributed ? "Attributed · cryptographically verified" : "Not verified"}</div>
          <div className="mt-1 font-serif text-3xl">{s.name}</div>
          <div className="mt-1 text-sm text-ink-2">
            <span className="font-mono">{s.userId}</span> · {s.org}
          </div>
        </div>
        <div className="grid gap-5 px-6 py-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Fact k="Document">{s.docTitle}</Fact>
          <Fact k="Decrypted">{formatTime(s.decryptedAt)}<div className="text-xs text-ink-3">block #{s.blockHeight}</div></Fact>
          <Fact k="Session">{<span className="font-mono text-xs">{s.sessionId}</span>}</Fact>
          <Fact k="Leaked copy">{s.exactCopy ? "byte-identical to the delivered file" : "modified after delivery"}{s.acknowledged && <div className="text-xs text-ink-3">recipient signed receipt</div>}</Fact>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-rule px-6 py-3 print:hidden">
          <Button variant="outline" onClick={() => downloadBytes(JSON.stringify(out.bundle, null, 2), `sakshi-evidence-${s.userId}-${out.bundle!.extraction.wmId}.json`, "application/json")}>
            Download evidence bundle
          </Button>
          <Button variant="ghost" onClick={() => window.print()}>Print report</Button>
          <span className="ml-auto text-xs text-ink-3">Verify offline: <span className="font-mono">npm run verify-evidence -- bundle.json</span></span>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Verification" meta="re-checked in this browser" />
          <ul className="ledger-rule">
            {v.checks.map((c) => (
              <li key={c.id} className="flex gap-3 px-5 py-3">
                <span className={cx("mt-0.5 font-mono text-sm", c.ok ? "text-verdigris" : c.optional ? "text-ink-3" : "text-seal")}>{c.ok ? "✓" : c.optional ? "–" : "✗"}</span>
                <div>
                  <div className="text-sm">{c.label}</div>
                  <div className="text-xs text-ink-3">{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Watermark recovery" />
          <dl className="space-y-2.5 px-5 py-4 text-sm">
            <Fact2 k="Watermark ID"><span className="font-mono">{ex.wm_id}</span></Fact2>
            <Fact2 k="Match strength">{ex.match_sigma}σ</Fact2>
            <Fact2 k="False-match probability">{ex.false_match_probability?.toExponential(1)}</Fact2>
            <Fact2 k="Bit agreement">{((ex.bit_agreement ?? 0) * 100).toFixed(1)}%</Fact2>
            <Fact2 k="Detected zoom">{ex.scale}×</Fact2>
            <Fact2 k="File">{ex.kind} · {formatBytes(out.size)}</Fact2>
            <Fact2 k="Analysis time">{ex.elapsed_ms} ms</Fact2>
            <Fact2 k="Your query record"><Hash value={out.queryTxId} chars={8} /></Fact2>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-ink-3">{k}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function Fact2({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-3">{k}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
