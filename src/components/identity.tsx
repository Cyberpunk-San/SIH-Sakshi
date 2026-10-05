"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Api, login, type NetConfig, type Session } from "@/lib/client/flows";
import { getKey, saveKey } from "@/lib/client/keystore";
import { unlockIdentity, type KeyFile } from "@/lib/core/keyfile";
import type { Identity } from "@/lib/core/pq";
import { Button, Field, inputClass } from "./ui";

type Ctx = {
  api: Api;
  config: NetConfig | null;
  configError: string | null;
  session: Session | null;
  ready: boolean;
  identity: Identity | null;
  signIn: (kf: KeyFile, passphrase: string) => Promise<Session>;
  signOut: () => Promise<void>;
  /** Returns the unlocked keys, prompting for the passphrase if they are not in memory. */
  ensureIdentity: () => Promise<Identity>;
  refresh: () => Promise<void>;
};

const IdentityCtx = createContext<Ctx | null>(null);

export function useIdentity() {
  const c = useContext(IdentityCtx);
  if (!c) throw new Error("useIdentity outside provider");
  return c;
}

export function IdentityProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => new Api(""), []);
  const [config, setConfig] = useState<NetConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [prompt, setPrompt] = useState<{ kf: KeyFile | null } | null>(null);
  const waiters = useRef<{ resolve: (i: Identity) => void; reject: (e: Error) => void }[]>([]);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<{ session: Session | null }>("/api/me");
      setSession(me.session);
      if (!me.session) setIdentity(null);
    } finally {
      setReady(true);
    }
  }, [api]);

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setConfigError(e.message));
    void refresh();
  }, [api, refresh]);

  const signIn = useCallback(
    async (kf: KeyFile, passphrase: string) => {
      const ident = await unlockIdentity(kf, passphrase);
      const s = await login(api, kf.principal, ident);
      saveKey(kf);
      setIdentity(ident);
      setSession(s);
      return s;
    },
    [api],
  );

  const signOut = useCallback(async () => {
    await api.post("/api/auth/logout", {});
    identity?.dsa.secretKey.fill(0);
    identity?.kem.secretKey.fill(0);
    setIdentity(null);
    setSession(null);
  }, [api, identity]);

  const ensureIdentity = useCallback(() => {
    if (identity) return Promise.resolve(identity);
    return new Promise<Identity>((resolve, reject) => {
      waiters.current.push({ resolve, reject });
      setPrompt({ kf: session ? getKey(session.principal) : null });
    });
  }, [identity, session]);

  const finishPrompt = (ident: Identity | null, err?: Error) => {
    const w = waiters.current;
    waiters.current = [];
    setPrompt(null);
    for (const x of w) {
      if (ident) x.resolve(ident);
      else x.reject(err ?? new Error("cancelled"));
    }
  };

  return (
    <IdentityCtx.Provider value={{ api, config, configError, session, ready, identity, signIn, signOut, ensureIdentity, refresh }}>
      {children}
      {prompt && session && (
        <UnlockDialog
          principal={session.principal}
          keyFile={prompt.kf}
          onCancel={() => finishPrompt(null)}
          onUnlocked={(ident) => {
            setIdentity(ident);
            finishPrompt(ident);
          }}
        />
      )}
    </IdentityCtx.Provider>
  );
}

function UnlockDialog({
  principal,
  keyFile,
  onCancel,
  onUnlocked,
}: {
  principal: string;
  keyFile: KeyFile | null;
  onCancel: () => void;
  onUnlocked: (i: Identity) => void;
}) {
  const [kf, setKf] = useState<KeyFile | null>(keyFile);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!kf) return;
    setBusy(true);
    setError(null);
    try {
      if (kf.principal !== principal) throw new Error(`This key belongs to ${kf.principal}, you are signed in as ${principal}.`);
      const ident = await unlockIdentity(kf, pass);
      saveKey(kf);
      onUnlocked(ident);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
      <form
        className="w-full max-w-md rounded-md border border-rule bg-card p-6 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="unlock-title" className="font-serif text-xl">Unlock your signing key</h2>
        <p className="mt-1 text-sm text-ink-2">
          This action is signed with your post-quantum key. It is decrypted only in this tab and never sent anywhere.
        </p>
        {!kf ? (
          <Field label={`Key file for ${principal}`} className="mt-4">
            <input
              type="file"
              accept=".sakshikey,application/json"
              className={inputClass}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setKf(JSON.parse(await f.text()));
              }}
            />
          </Field>
        ) : (
          <p className="mt-4 text-sm">
            Key: <span className="font-mono">{kf.principal}</span>
          </p>
        )}
        <Field label="Passphrase" className="mt-3">
          <input autoFocus type="password" className={inputClass} value={pass} onChange={(e) => setPass(e.target.value)} />
        </Field>
        {error && <p className="mt-3 text-sm text-seal">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={!kf || !pass || busy}>{busy ? "Deriving key…" : "Unlock"}</Button>
        </div>
      </form>
    </div>
  );
}
