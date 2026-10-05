import { NextResponse, type NextRequest } from "next/server";
import { guard, requireSession } from "@/lib/server/http";
import { query } from "@/lib/server/ledger-client";
import type { CertRecord } from "@/lib/core/state";

export const GET = guard(async (req: NextRequest) => {
  const s = requireSession(req);
  const { certs } = await query<{ certs: CertRecord[] }>("/state/certs");
  const now = Date.now();
  const latest = new Map<string, CertRecord>();
  for (const c of certs) latest.set(c.body.userId, c);
  const people = [...latest.values()].map((c) => ({
    userId: c.body.userId,
    name: c.body.name,
    org: c.body.org,
    roles: c.body.roles,
    kemPk: c.body.kemPk,
    dsaPk: c.body.dsaPk,
    certTxId: c.txId,
    height: c.height,
    issuer: c.issuer,
    expiresAt: c.body.expiresAt,
    status: c.revoked ? "revoked" : now > c.body.expiresAt ? "expired" : "active",
    revoked: c.revoked ?? null,
  }));
  return NextResponse.json({ people, me: s.principal });
});
