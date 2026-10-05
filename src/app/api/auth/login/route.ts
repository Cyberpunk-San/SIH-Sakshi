import { NextResponse, type NextRequest } from "next/server";
import { fromB64 } from "@/lib/core/bytes";
import { verify } from "@/lib/core/pq";
import { getGenesis } from "@/lib/server/config";
import { guard, HttpError } from "@/lib/server/http";
import { consumeChallenge, cookieOptions, COOKIE, encodeSession, loginMessage, LOGIN_DOMAIN, resolvePrincipal } from "@/lib/server/session";

export const POST = guard(async (req: NextRequest) => {
  const { principal, nonce, sig } = await req.json();
  if (!consumeChallenge(nonce, principal)) throw new HttpError(401, "challenge expired, try again");
  const who = await resolvePrincipal(principal);
  if (!who) throw new HttpError(403, "no active certificate for this identity (enrolment pending, revoked or expired)");
  const ok = verify(fromB64(who.dsaPk), LOGIN_DOMAIN, loginMessage(principal, nonce, getGenesis().chainId), fromB64(sig));
  if (!ok) throw new HttpError(401, "signature does not match the certified key");
  const session = { principal, kind: who.kind, name: who.name, roles: who.roles };
  const res = NextResponse.json(session);
  res.cookies.set(COOKIE, encodeSession(session), cookieOptions);
  return res;
});
