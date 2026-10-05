"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useIdentity } from "@/components/identity";
import { Card, Dot } from "@/components/ui";

type Status = { quorum: number; nodes: { online: boolean; height?: number }[]; summary: Record<string, number> | null; watermarkEngine: boolean };

const STEPS = [
  { n: "01", t: "Encrypt once", d: "The sender's browser encrypts the file with AES-256-GCM. The key is split into a recipient half and a validator half." },
  { n: "02", t: "Wrap per recipient", d: "The recipient half is wrapped separately to each recipient's ML-KEM-768 key. The validator half is Shamir-split across the validators." },
  { n: "03", t: "Store in pieces", d: "The ciphertext is cut into equal-size encrypted chunks with unlinkable names and mixed with decoys." },
  { n: "04", t: "Sign to open", d: "A recipient signs a decryption record with their own ML-DSA-65 key. They cannot later deny it." },
  { n: "05", t: "Witness first", d: "The record must be committed by a validator quorum before any plaintext exists. No commit, no document." },
  { n: "06", t: "Release the shares", d: "Each validator checks the committed record and releases its share for that one session only." },
  { n: "07", t: "Mark the copy", d: "An invisible watermark derived from the session is embedded and read back before delivery." },
  { n: "08", t: "Trace a leak", d: "Watermark → ledger record → recipient signature → validator certificates. A self-contained bundle anyone can verify offline." },
];

export default function Home() {
  const { api, session } = useIdentity();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    api.get<Status>("/api/ledger/status").then(setStatus).catch(() => setStatus(null));
  }, [api]);
  const online = status?.nodes.filter((n) => n.online).length ?? 0;
  const live = status ? online >= status.quorum : false;

  return (
    <div>
      <section className="grid gap-10 border-b border-rule pb-12 lg:grid-cols-[1.35fr_1fr] lg:items-end">
        <div>
          <div className="mb-4 text-xs font-medium uppercase tracking-[0.16em] text-ink-3">Sakshi · साक्षी · the witness</div>
          <h1 className="font-serif text-4xl leading-[1.08] sm:text-5xl">
            Every copy looks the same.
            <br />
            <span className="text-seal">No two copies are the same.</span>
          </h1>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-2">
            When a document goes to a group, a leak usually points at everyone. Sakshi watermarks each copy invisibly at the moment of decryption. The recipient signs for that decryption with their own post-quantum key, and the record is witnessed on a ledger that no single administrator can rewrite.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            {session ? (
              <Link href={session.kind === "registrar" ? "/admin" : session.roles.includes("recipient") ? "/inbox" : session.roles.includes("sender") ? "/send" : "/forensics"} className="rounded-[4px] bg-ink px-4 py-2.5 text-sm font-medium text-paper">
                Continue as {session.principal}
              </Link>
            ) : (
              <>
                <Link href="/login" className="rounded-[4px] bg-ink px-4 py-2.5 text-sm font-medium text-paper">Sign in with your key</Link>
                <Link href="/enrol" className="rounded-[4px] border border-rule-2 px-4 py-2.5 text-sm font-medium">Enrol</Link>
              </>
            )}
            <Link href="/ledger" className="px-2 py-2.5 text-sm text-ink-2 underline underline-offset-4">Inspect the ledger</Link>
          </div>
        </div>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-ink-3">
            <Dot tone={!status ? "idle" : live ? "good" : "bad"} /> Network
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
            <div><dt className="text-ink-3">Validators</dt><dd className="font-serif text-2xl tabular">{status ? `${online}/${status.nodes.length}` : "–"}</dd></div>
            <div><dt className="text-ink-3">Finality</dt><dd className="font-serif text-2xl tabular">{status ? `${status.quorum} sigs` : "–"}</dd></div>
            <div><dt className="text-ink-3">Decryptions witnessed</dt><dd className="font-serif text-2xl tabular">{status?.summary?.decrypts ?? "–"}</dd></div>
            <div><dt className="text-ink-3">Certified identities</dt><dd className="font-serif text-2xl tabular">{status?.summary?.certs ?? "–"}</dd></div>
          </dl>
          <div className="mt-4 border-t border-rule pt-3 text-xs text-ink-3">
            ML-KEM-768 (FIPS 203) · ML-DSA-65 (FIPS 204) · runs offline: no cloud KMS, no public chain
          </div>
        </Card>
      </section>

      <section className="py-12">
        <h2 className="font-serif text-2xl">How a copy comes to exist</h2>
        <ol className="mt-6 grid gap-px overflow-hidden rounded-md border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="bg-card p-5">
              <div className="font-mono text-xs text-seal">{s.n}</div>
              <div className="mt-2 font-medium">{s.t}</div>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">{s.d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-6 border-t border-rule pt-12 md:grid-cols-3">
        <div>
          <h3 className="font-serif text-lg">No single point of trust</h3>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">The gateway cannot decrypt without the recipient&apos;s key half. Recipients cannot get an unmarked copy without the validators. A validator alone cannot release anything, and an administrator cannot edit history.</p>
        </div>
        <div>
          <h3 className="font-serif text-lg">Survives real leaks</h3>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">The watermark is recovered from forwarded files, screenshots at any common zoom, cropped captures and recompressed JPEGs. Each match carries a statistical confidence, so a weak signal is never reported as proof.</p>
        </div>
        <div>
          <h3 className="font-serif text-lg">Honest limits</h3>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">A watermark makes a leak traceable; it does not prevent one. Retyping text by hand, heavy rotation or redrawing, and several recipients combining their copies can defeat it. Sakshi reports “no attribution” rather than guess.</p>
        </div>
      </section>
    </div>
  );
}
