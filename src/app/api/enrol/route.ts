import { NextResponse, type NextRequest } from "next/server";
import { fromB64 } from "@/lib/core/bytes";
import { verify } from "@/lib/core/pq";
import { ENROL_DOMAIN, enrolPayload } from "@/lib/core/state";
import type { Role } from "@/lib/core/ledger";
import { addEnrolment, listEnrolments, removeEnrolment } from "@/lib/server/enrol-store";
import { guard, HttpError, requireSession } from "@/lib/server/http";
import { resolvePrincipal } from "@/lib/server/session";

const USER_ID = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const ROLES: Role[] = ["sender", "recipient", "investigator"];

// Anyone on the air-gapped network may request enrolment; only a registrar can approve it.
export const POST = guard(async (req: NextRequest) => {
  const b = await req.json();
  if (!USER_ID.test(b.userId ?? "")) throw new HttpError(400, "user id: 3-40 chars, lowercase letters, digits, . _ -");
  if (!b.name || String(b.name).length > 120 || String(b.org ?? "").length > 120) throw new HttpError(400, "name and organisation required");
  const roles = (b.requestedRoles ?? []).filter((r: Role) => ROLES.includes(r));
  if (!roles.length) throw new HttpError(400, "request at least one role");
  try {
    if (fromB64(b.dsaPk).length !== 1952 || fromB64(b.kemPk).length !== 1184) throw new Error();
    if (!verify(fromB64(b.dsaPk), ENROL_DOMAIN, enrolPayload(b), fromB64(b.popSig))) throw new Error();
  } catch {
    throw new HttpError(400, "invalid keys or proof of possession");
  }
  if (await resolvePrincipal(b.userId)) throw new HttpError(409, "this user id already has an active certificate");
  addEnrolment({
    userId: b.userId,
    name: String(b.name),
    org: String(b.org ?? ""),
    dsaPk: b.dsaPk,
    kemPk: b.kemPk,
    popSig: b.popSig,
    requestedRoles: roles,
    note: String(b.note ?? "").slice(0, 300),
    submittedAt: Date.now(),
  });
  return NextResponse.json({ ok: true });
});

export const GET = guard(async (req: NextRequest) => {
  requireSession(req, { registrar: true });
  return NextResponse.json({ pending: listEnrolments() });
});

export const DELETE = guard(async (req: NextRequest) => {
  requireSession(req, { registrar: true });
  removeEnrolment(req.nextUrl.searchParams.get("userId") ?? "");
  return NextResponse.json({ ok: true });
});
