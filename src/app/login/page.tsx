"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useIdentity } from "@/components/identity";
import { Button, Card, Field, Notice, PageHeader, inputClass } from "@/components/ui";
import { listKeys, parseKeyFile, removeKey } from "@/lib/client/keystore";
import type { KeyFile } from "@/lib/core/keyfile";

export default function LoginPage() {
  const { signIn } = useIdentity();
  const router = useRouter();
  const [keys, setKeys] = useState<KeyFile[]>([]);
  const [selected, setSelected] = useState<KeyFile | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // localStorage is only readable after hydration.
    const k = listKeys();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKeys(k);
    if (k.length === 1) setSelected(k[0]);
  }, []);

  const importFile = async (f: File) => {
    try {
      const kf = parseKeyFile(await f.text());
      setKeys((prev) => [kf, ...prev.filter((x) => x.principal !== kf.principal)]);
      setSelected(kf);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const s = await signIn(selected, pass);
      setPass("");
      router.push(s.kind === "registrar" ? "/admin" : s.roles.includes("recipient") ? "/inbox" : s.roles.includes("sender") ? "/send" : "/forensics");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader eyebrow="Passwordless, post-quantum" title="Sign in with your key">
        The server sends a one-time challenge and your browser signs it with your ML-DSA-65 key. Your passphrase only decrypts the key locally.
      </PageHeader>
      <Card className="p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="text-xs font-medium uppercase tracking-[0.08em] text-ink-2">Identity</div>
          <div className="mt-2 divide-y divide-rule rounded-[4px] border border-rule-2">
            {keys.length === 0 && <div className="px-3 py-3 text-sm text-ink-3">No key stored in this browser. Import your key file below.</div>}
            {keys.map((k) => (
              <label key={k.principal} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-paper-2">
                <input type="radio" name="key" checked={selected?.principal === k.principal} onChange={() => setSelected(k)} className="accent-[var(--verdigris)]" />
                <span className="flex-1">
                  <span className="font-mono text-sm">{k.principal}</span>
                  <span className="ml-2 text-xs text-ink-3">{k.kind}</span>
                </span>
                <button
                  type="button"
                  className="text-xs text-ink-3 hover:text-seal"
                  onClick={() => {
                    if (confirm(`Forget the key for ${k.principal} in this browser? Make sure you have the .sakshikey file.`)) {
                      removeKey(k.principal);
                      setKeys(listKeys());
                      if (selected?.principal === k.principal) setSelected(null);
                    }
                  }}
                >
                  Forget
                </button>
              </label>
            ))}
          </div>
          <label className="mt-3 inline-block cursor-pointer text-sm text-verdigris underline underline-offset-4">
            Import a .sakshikey file
            <input type="file" accept=".sakshikey,application/json" className="sr-only" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
          <Field label="Passphrase" className="mt-5">
            <input type="password" className={inputClass} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
          </Field>
          {error && (
            <div className="mt-4">
              <Notice tone="bad">{error}</Notice>
            </div>
          )}
          <div className="mt-5 flex items-center justify-between">
            <Link href="/enrol" className="text-sm text-ink-2 underline underline-offset-4">New here? Enrol</Link>
            <Button type="submit" disabled={!selected || !pass || busy}>{busy ? "Unlocking & signing…" : "Sign in"}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
