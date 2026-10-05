"use client";

import Link from "next/link";
import { useState } from "react";
import { useIdentity } from "@/components/identity";
import { Button, Card, Field, Notice, PageHeader, inputClass } from "@/components/ui";
import { enrolmentRequest } from "@/lib/client/flows";
import { downloadBytes, saveKey } from "@/lib/client/keystore";
import { lockIdentity } from "@/lib/core/keyfile";
import type { Role } from "@/lib/core/ledger";
import { generateIdentity } from "@/lib/core/pq";

const ROLE_INFO: { id: Role; label: string; text: string }[] = [
  { id: "recipient", label: "Recipient", text: "Receive and decrypt documents" },
  { id: "sender", label: "Sender", text: "Encrypt and distribute documents" },
  { id: "investigator", label: "Investigator", text: "Trace leaked copies" },
];

export default function EnrolPage() {
  const { api } = useIdentity();
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [roles, setRoles] = useState<Role[]>(["recipient"]);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const valid = /^[a-z0-9][a-z0-9._-]{2,39}$/.test(userId) && name.trim() && roles.length && pass.length >= 10 && pass === pass2;

  const submit = async () => {
    setError(null);
    try {
      setBusy("Generating ML-DSA-65 and ML-KEM-768 key pairs…");
      await new Promise((r) => setTimeout(r, 30));
      const ident = generateIdentity();
      setBusy("Encrypting your private keys with your passphrase (Argon2id)…");
      const kf = await lockIdentity(ident, userId, "user", pass);
      saveKey(kf);
      downloadBytes(JSON.stringify(kf, null, 2), `${userId}.sakshikey`, "application/json");
      setBusy("Sending your public keys to the registrar…");
      await api.post("/api/enrol", enrolmentRequest(ident, userId, name.trim(), org.trim(), roles, note));
      ident.dsa.secretKey.fill(0);
      ident.kem.secretKey.fill(0);
      setDone(userId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (done)
    return (
      <div className="mx-auto max-w-xl">
        <PageHeader eyebrow="Enrolment submitted" title="Waiting for the registrar">
          Your keys were generated on this device. Only the public halves were sent. When the registration authority certifies your identity on the ledger, you can sign in.
        </PageHeader>
        <Notice tone="warn" title="Keep your key file safe">
          <span className="font-mono">{done}.sakshikey</span> was downloaded and also kept in this browser. Without it and its passphrase, you cannot decrypt documents or sign in, and nobody can recover it for you.
        </Notice>
        <div className="mt-6">
          <Link href="/login" className="text-sm underline underline-offset-4">Go to sign in</Link>
        </div>
      </div>
    );

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader eyebrow="New identity" title="Enrol on the network">
        Your post-quantum key pairs are created in this browser. The private keys are encrypted with your passphrase and never leave this device.
      </PageHeader>
      <Card className="p-6">
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void submit();
          }}
        >
          <Field label="User ID" hint="Lowercase letters, digits, dot, dash, underscore">
            <input className={inputClass} value={userId} onChange={(e) => setUserId(e.target.value.toLowerCase())} placeholder="r.sharma" autoComplete="username" />
          </Field>
          <Field label="Full name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Riya Sharma" />
          </Field>
          <Field label="Organisation" className="sm:col-span-2">
            <input className={inputClass} value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Department / unit" />
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-ink-2">Requested roles</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {ROLE_INFO.map((r) => (
                <label key={r.id} className="flex cursor-pointer gap-2 rounded-[4px] border border-rule-2 bg-card px-3 py-2 has-[:checked]:border-verdigris has-[:checked]:bg-verdigris-soft">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-[var(--verdigris)]"
                    checked={roles.includes(r.id)}
                    onChange={(e) => setRoles(e.target.checked ? [...roles, r.id] : roles.filter((x) => x !== r.id))}
                  />
                  <span>
                    <span className="block text-sm font-medium">{r.label}</span>
                    <span className="block text-xs text-ink-3">{r.text}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Passphrase" hint="At least 10 characters. It cannot be reset.">
            <input type="password" className={inputClass} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Repeat passphrase">
            <input type="password" className={inputClass} value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Note for the registrar (optional)" className="sm:col-span-2">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. employee number, approving officer" />
          </Field>
          {pass2 && pass !== pass2 && <p className="text-sm text-seal sm:col-span-2">Passphrases do not match.</p>}
          {error && (
            <div className="sm:col-span-2">
              <Notice tone="bad">{error}</Notice>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <span className="text-sm text-ink-3">{busy}</span>
            <Button type="submit" disabled={!valid || !!busy}>Generate keys and request certificate</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
