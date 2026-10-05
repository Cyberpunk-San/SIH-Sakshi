"use client";

import { useCallback, useEffect, useState } from "react";
import { Gate } from "@/components/gate";
import { useIdentity } from "@/components/identity";
import { Badge, Button, Card, CardHeader, Empty, Hash, Notice, PageHeader, cx, formatTime, inputClass } from "@/components/ui";
import { approveEnrolment, revokeCertificate, type Enrolment } from "@/lib/client/flows";
import { sha256Hex } from "@/lib/core/bytes";
import type { Role } from "@/lib/core/ledger";

type Pending = Enrolment & { requestedRoles: Role[]; note: string };
type Person = {
  userId: string;
  name: string;
  org: string;
  roles: Role[];
  dsaPk: string;
  certTxId: string;
  height: number;
  expiresAt: number;
  status: "active" | "revoked" | "expired";
  revoked: { reason: string; height: number } | null;
};

export default function AdminPage() {
  return <Gate registrar>{(s) => <Registry principal={s.principal} />}</Gate>;
}

function Registry({ principal }: { principal: string }) {
  const { api, ensureIdentity } = useIdentity();
  const [pending, setPending] = useState<Pending[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([api.get<{ pending: Pending[] }>("/api/enrol"), api.get<{ people: Person[] }>("/api/directory")]);
      setPending(p.pending);
      setPeople(d.people.sort((a, b) => b.height - a.height));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    Promise.all([api.get<{ pending: Pending[] }>("/api/enrol"), api.get<{ people: Person[] }>("/api/directory")])
      .then(([p, d]) => {
        setPending(p.pending);
        setPeople(d.people.sort((a, b) => b.height - a.height));
      })
      .catch((e) => setError(e.message));
  }, [api]);

  return (
    <div>
      <PageHeader eyebrow="Registration authority" title="Identity registry">
        Approving an enrolment signs a certificate with the registrar key and commits it to the ledger. The certificate binds a person to their ML-DSA-65 and ML-KEM-768 public keys. Every issuance and revocation is permanent and visible to every validator.
      </PageHeader>
      {error && <Notice tone="bad">{error}</Notice>}
      {msg && <div className="mb-4"><Notice tone="good">{msg}</Notice></div>}

      <Card className="mb-8">
        <CardHeader title="Pending enrolments" meta={`${pending.length} waiting`} />
        {pending.length === 0 ? (
          <Empty title="Nothing to review">New enrolment requests appear here.</Empty>
        ) : (
          <div className="ledger-rule">
            {pending.map((p) => (
              <PendingRow
                key={p.userId}
                p={p}
                onApprove={async (roles, days) => {
                  const ident = await ensureIdentity();
                  const r = await approveEnrolment(api, ident, principal, p, roles, days);
                  setMsg(`Certificate for ${p.userId} committed in block #${r.height}.`);
                  await load();
                }}
                onReject={async () => {
                  await api.raw(`/api/enrol?userId=${encodeURIComponent(p.userId)}`, { method: "DELETE" });
                  await load();
                }}
              />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Certified identities" meta={`${people.filter((p) => p.status === "active").length} active`} />
        {people.length === 0 ? (
          <Empty title="No certificates yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-ink-3">
                  <th className="px-5 py-2 font-medium">Identity</th>
                  <th className="px-3 py-2 font-medium">Roles</th>
                  <th className="px-3 py-2 font-medium">Key fingerprint</th>
                  <th className="px-3 py-2 font-medium">Block</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody className="ledger-rule">
                {people.map((p) => (
                  <tr key={p.userId} className="border-t border-rule align-top">
                    <td className="px-5 py-3">
                      <div>{p.name}</div>
                      <div className="font-mono text-xs text-ink-3">{p.userId} · {p.org}</div>
                    </td>
                    <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{p.roles.map((r) => <Badge key={r}>{r}</Badge>)}</div></td>
                    <td className="px-3 py-3"><Hash value={sha256Hex(p.dsaPk)} chars={8} /></td>
                    <td className="px-3 py-3 tabular">#{p.height}</td>
                    <td className="px-3 py-3">
                      <Badge tone={p.status === "active" ? "good" : "bad"}>{p.status}</Badge>
                      {p.revoked && <div className="mt-1 text-xs text-ink-3">{p.revoked.reason}</div>}
                      {p.status === "active" && <div className="mt-1 text-xs text-ink-3">until {formatTime(p.expiresAt)}</div>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {p.status === "active" && (
                        <Button
                          variant="ghost"
                          className="text-seal"
                          onClick={async () => {
                            const reason = prompt(`Revoke ${p.userId}? Reason (recorded on the ledger):`);
                            if (!reason) return;
                            try {
                              const ident = await ensureIdentity();
                              const r = await revokeCertificate(api, ident, principal, p.userId, p.certTxId, reason);
                              setMsg(`${p.userId} revoked in block #${r.height}.`);
                              await load();
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function PendingRow({ p, onApprove, onReject }: { p: Pending; onApprove: (r: Role[], days: number) => Promise<void>; onReject: () => Promise<void> }) {
  const [roles, setRoles] = useState<Role[]>(p.requestedRoles);
  const [days, setDays] = useState(365);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto]">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="font-medium">{p.name}</span>
          <span className="font-mono text-xs text-ink-3">{p.userId}</span>
          <span className="text-xs text-ink-3">{p.org}</span>
        </div>
        <div className="mt-1 text-xs text-ink-3">
          Requested {formatTime(p.submittedAt)} · key fingerprint <Hash value={sha256Hex(p.dsaPk)} chars={8} /> · proof of possession verified
        </div>
        {p.note && <div className="mt-1 text-sm text-ink-2">“{p.note}”</div>}
        <div className="mt-3 flex flex-wrap gap-2">
          {(["recipient", "sender", "investigator"] as Role[]).map((r) => (
            <label key={r} className={cx("flex cursor-pointer items-center gap-1.5 rounded-[3px] border px-2 py-1 text-xs", roles.includes(r) ? "border-verdigris bg-verdigris-soft" : "border-rule-2")}>
              <input type="checkbox" className="accent-[var(--verdigris)]" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />
              {r}
            </label>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            valid for
            <select className={cx(inputClass, "w-auto py-1 text-xs")} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[30, 90, 180, 365, 730].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
        </div>
        {err && <div className="mt-2 text-sm text-seal">{err}</div>}
      </div>
      <div className="flex items-start gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => { setBusy(true); onReject().finally(() => setBusy(false)); }}>Reject</Button>
        <Button
          disabled={busy || roles.length === 0}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await onApprove(roles, days);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Committing…" : "Sign certificate"}
        </Button>
      </div>
    </div>
  );
}
